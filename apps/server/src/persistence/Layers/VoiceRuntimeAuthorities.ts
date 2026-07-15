import {
  AuthSessionId,
  VoiceRuntimeId,
  VoiceRuntimeTarget,
  VoiceThreadRuntimeTarget,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceRuntimeAuthorityRepository,
  type PersistedVoiceRuntimeAuthority,
  type VoiceRuntimeAuthorityRepositoryShape,
} from "../Services/VoiceRuntimeAuthorities.ts";

interface AuthorityRow {
  readonly authSessionId: string;
  readonly runtimeId: string;
  readonly generation: number;
  readonly targetJson: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const encodeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceRuntimeTarget));
const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceRuntimeTarget));
const decodeThreadTarget = Schema.decodeUnknownSync(
  Schema.fromJsonString(VoiceThreadRuntimeTarget),
);
const columns = `authority.auth_session_id AS "authSessionId",
  authority.runtime_id AS "runtimeId", authority.generation,
  authority.target_json AS "targetJson", authority.created_at AS "createdAt",
  authority.updated_at AS "updatedAt"`;

const decode = (row: AuthorityRow): PersistedVoiceRuntimeAuthority => ({
  authSessionId: AuthSessionId.make(row.authSessionId),
  runtimeId: VoiceRuntimeId.make(row.runtimeId),
  generation: row.generation,
  target: decodeTarget(row.targetJson),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const handoffCasRollback = Symbol("VoiceRuntimeAuthorityRepository.handoffCasRollback");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const retireRuntime = (authSessionId: AuthSessionId, runtimeId: VoiceRuntimeId) =>
    Effect.gen(function* () {
      yield* sql`UPDATE voice_thread_turn_operations SET
        detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
        active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
        processing_lease_until = CASE WHEN dispatch_accepted = 0
          THEN NULL ELSE processing_lease_until END,
        processing_lease_token = CASE WHEN dispatch_accepted = 0
          THEN NULL ELSE processing_lease_token END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      yield* sql`UPDATE voice_runtime_realtime_starts SET close_only = 1
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}
          AND session_id IS NOT NULL`;
      yield* sql`DELETE FROM voice_runtime_realtime_starts
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}
          AND session_id IS NULL`;
    });

  const configure: VoiceRuntimeAuthorityRepositoryShape["configure"] = (input, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<AuthorityRow>(
            `SELECT ${columns} FROM voice_runtime_authorities AS authority
             WHERE authority.auth_session_id = ? AND authority.runtime_id = ? LIMIT 1`,
            [input.authSessionId, input.runtimeId],
          );
          const previous = rows[0];
          const fenceRows = yield* sql<{ readonly maximumGeneration: number }>`
            SELECT maximum_generation AS "maximumGeneration"
            FROM voice_runtime_generation_fences
            WHERE auth_session_id = ${input.authSessionId} AND runtime_id = ${input.runtimeId}
            LIMIT 1`;
          const persistedGeneration = previous?.generation ?? fenceRows[0]?.maximumGeneration ?? 0;
          const targetJson = encodeTarget(input.target);
          if (previous?.generation === input.generation) {
            return previous.targetJson === targetJson
              ? { status: "existing" as const, authority: decode(previous) }
              : { status: "stale" as const };
          }
          if (
            input.generation !== input.expectedCurrentGeneration + 1 ||
            persistedGeneration !== input.expectedCurrentGeneration
          ) {
            return { status: "stale" as const };
          }
          if (previous !== undefined) yield* retireRuntime(input.authSessionId, input.runtimeId);
          yield* sql`INSERT INTO voice_runtime_authorities (
              auth_session_id, runtime_id, generation, target_json, created_at, updated_at
            ) VALUES (
              ${input.authSessionId}, ${input.runtimeId}, ${input.generation}, ${targetJson},
              ${now}, ${now}
            ) ON CONFLICT(auth_session_id, runtime_id) DO UPDATE SET
              generation = excluded.generation, target_json = excluded.target_json,
              updated_at = excluded.updated_at`;
          yield* sql`INSERT INTO voice_runtime_generation_fences (
              auth_session_id, runtime_id, maximum_generation
            ) VALUES (${input.authSessionId}, ${input.runtimeId}, ${input.generation})
            ON CONFLICT(auth_session_id, runtime_id) DO UPDATE SET
              maximum_generation = MAX(maximum_generation, excluded.maximum_generation)`;
          return {
            status: "configured" as const,
            authority: {
              authSessionId: input.authSessionId,
              runtimeId: input.runtimeId,
              generation: input.generation,
              target: input.target,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            },
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceRuntimeAuthorityRepository.configure")));

  const find: VoiceRuntimeAuthorityRepositoryShape["find"] = (authSessionId, runtimeId) => {
    const nowIso = DateTime.formatIso(DateTime.nowUnsafe());
    return sql
      .unsafe<AuthorityRow>(
        `SELECT ${columns} FROM voice_runtime_authorities AS authority
         INNER JOIN auth_sessions AS auth ON auth.session_id = authority.auth_session_id
         WHERE authority.auth_session_id = ? AND authority.runtime_id = ?
           AND auth.revoked_at IS NULL AND auth.expires_at > ? LIMIT 1`,
        [authSessionId, runtimeId, nowIso],
      )
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : decode(rows[0]))),
        Effect.mapError(toPersistenceSqlError("VoiceRuntimeAuthorityRepository.find")),
      );
  };

  const consumeHandoff: VoiceRuntimeAuthorityRepositoryShape["consumeHandoff"] = (input, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.nextGeneration !== input.sourceGeneration + 1)
            return { status: "stale" as const };
          const reservations = yield* sql<{
            readonly authSessionId: string;
            readonly sourceLeaseGeneration: number;
            readonly actionSequence: number;
            readonly runtimeId: string;
            readonly runtimeInstanceId: string;
            readonly sourceGeneration: number;
            readonly modeSessionId: string;
            readonly targetJson: string;
            readonly consumedAt: number | null;
          }>`SELECT auth_session_id AS "authSessionId",
              source_lease_generation AS "sourceLeaseGeneration",
              action_sequence AS "actionSequence", runtime_id AS "runtimeId",
              runtime_instance_id AS "runtimeInstanceId",
              source_generation AS "sourceGeneration", mode_session_id AS "modeSessionId",
              target_json AS "targetJson", consumed_at AS "consumedAt"
            FROM voice_runtime_realtime_transition_grants
            WHERE source_session_id = ${input.sourceSessionId}
              AND action_id = ${input.actionId}
              AND next_generation = ${input.nextGeneration} LIMIT 1`;
          const reservation = reservations[0];
          if (
            reservation === undefined ||
            reservation.authSessionId !== input.authSessionId ||
            reservation.sourceLeaseGeneration !== input.sourceLeaseGeneration ||
            reservation.actionSequence !== input.actionSequence ||
            reservation.runtimeId !== input.runtimeId ||
            reservation.runtimeInstanceId !== input.runtimeInstanceId ||
            reservation.sourceGeneration !== input.sourceGeneration ||
            reservation.modeSessionId !== input.modeSessionId
          )
            return { status: "stale" as const };
          const targetJson = reservation.targetJson;
          const target = decodeThreadTarget(targetJson);
          const authorities = yield* sql.unsafe<AuthorityRow>(
            `SELECT ${columns} FROM voice_runtime_authorities AS authority
             WHERE authority.auth_session_id = ? AND authority.runtime_id = ? LIMIT 1`,
            [input.authSessionId, input.runtimeId],
          );
          const current = authorities[0];
          if (current?.generation === input.nextGeneration) {
            return reservation.consumedAt !== null && current.targetJson === targetJson
              ? { status: "existing" as const, target }
              : { status: "stale" as const };
          }
          if (reservation.consumedAt !== null || current?.generation !== input.sourceGeneration)
            return { status: "stale" as const };
          yield* sql`UPDATE voice_runtime_realtime_transition_grants
            SET consumed_at = ${now}
            WHERE source_session_id = ${input.sourceSessionId}
              AND action_id = ${input.actionId} AND next_generation = ${input.nextGeneration}
              AND consumed_at IS NULL`;
          const consumed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          if (consumed[0]?.changed !== 1) return yield* Effect.fail(handoffCasRollback);
          yield* retireRuntime(input.authSessionId, input.runtimeId);
          yield* sql`UPDATE voice_runtime_authorities SET
              generation = ${input.nextGeneration}, target_json = ${targetJson}, updated_at = ${now}
            WHERE auth_session_id = ${input.authSessionId} AND runtime_id = ${input.runtimeId}
              AND generation = ${input.sourceGeneration}`;
          const advanced = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          if (advanced[0]?.changed !== 1) return yield* Effect.fail(handoffCasRollback);
          yield* sql`INSERT INTO voice_runtime_generation_fences (
              auth_session_id, runtime_id, maximum_generation
            ) VALUES (${input.authSessionId}, ${input.runtimeId}, ${input.nextGeneration})
            ON CONFLICT(auth_session_id, runtime_id) DO UPDATE SET
              maximum_generation = MAX(maximum_generation, excluded.maximum_generation)`;
          return { status: "consumed" as const, target };
        }),
      )
      .pipe(
        Effect.catch((cause) =>
          cause === handoffCasRollback
            ? Effect.succeed({ status: "stale" as const })
            : Effect.fail(cause),
        ),
        Effect.mapError(toPersistenceSqlError("VoiceRuntimeAuthorityRepository.consumeHandoff")),
      );

  const clearRuntime: VoiceRuntimeAuthorityRepositoryShape["clearRuntime"] = (
    authSessionId,
    runtimeId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* retireRuntime(authSessionId, runtimeId);
          yield* sql`DELETE FROM voice_runtime_authorities
            WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          yield* sql`DELETE FROM voice_runtime_realtime_transition_grants
            WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
          return changed[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceRuntimeAuthorityRepository.clearRuntime")));

  const clearAuthSession: VoiceRuntimeAuthorityRepositoryShape["clearAuthSession"] = (
    authSessionId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const runtimes = yield* sql<{ readonly runtimeId: string }>`
            SELECT runtime_id AS "runtimeId" FROM voice_runtime_authorities
            WHERE auth_session_id = ${authSessionId}`;
          yield* Effect.forEach(
            runtimes,
            ({ runtimeId }) => retireRuntime(authSessionId, VoiceRuntimeId.make(runtimeId)),
            { discard: true },
          );
          yield* sql`DELETE FROM voice_runtime_authorities
            WHERE auth_session_id = ${authSessionId}`;
          yield* sql`DELETE FROM voice_runtime_realtime_transition_grants
            WHERE auth_session_id = ${authSessionId}`;
          yield* sql`DELETE FROM voice_runtime_realtime_starts
            WHERE auth_session_id = ${authSessionId}`;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("VoiceRuntimeAuthorityRepository.clearAuthSession")),
      );

  return VoiceRuntimeAuthorityRepository.of({
    configure,
    find,
    consumeHandoff,
    clearRuntime,
    clearAuthSession,
  });
});

export const VoiceRuntimeAuthorityRepositoryLive = Layer.effect(
  VoiceRuntimeAuthorityRepository,
  make,
);

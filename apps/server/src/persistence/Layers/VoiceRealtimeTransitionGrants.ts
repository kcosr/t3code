import {
  AuthSessionId,
  VoiceClientActionId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
  VoiceThreadRuntimeTarget,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceRealtimeTransitionGrantRepository,
  type PersistedVoiceRealtimeTransitionGrant,
  type VoiceRealtimeTransitionGrantRepositoryShape,
} from "../Services/VoiceRealtimeTransitionGrants.ts";

interface Row {
  readonly operationKey: string;
  readonly tokenHash: string;
  readonly sourceControlTokenHash: string;
  readonly authSessionId: string;
  readonly sourceSessionId: string;
  readonly sourceLeaseGeneration: number;
  readonly actionId: string;
  readonly actionSequence: number;
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly modeSessionId: string;
  readonly targetJson: string;
  readonly expiresAt: number;
  readonly authorityExpiresAt: number;
  readonly consumedAt: number | null;
}

const encodeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceThreadRuntimeTarget));
const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceThreadRuntimeTarget));
const selectColumns = `operation_key AS "operationKey", token_hash AS "tokenHash",
  source_control_token_hash AS "sourceControlTokenHash",
  auth_session_id AS "authSessionId", source_session_id AS "sourceSessionId",
  source_lease_generation AS "sourceLeaseGeneration", action_id AS "actionId",
  action_sequence AS "actionSequence",
  runtime_id AS "runtimeId", runtime_instance_id AS "runtimeInstanceId",
  source_generation AS "sourceGeneration", target_generation AS "targetGeneration",
  mode_session_id AS "modeSessionId", target_json AS "targetJson",
  expires_at AS "expiresAt", authority_expires_at AS "authorityExpiresAt",
  consumed_at AS "consumedAt"`;
const qualifiedSelectColumns = `transition.operation_key AS "operationKey",
  transition.token_hash AS "tokenHash", transition.auth_session_id AS "authSessionId",
  transition.source_control_token_hash AS "sourceControlTokenHash",
  transition.source_session_id AS "sourceSessionId",
  transition.source_lease_generation AS "sourceLeaseGeneration",
  transition.action_id AS "actionId", transition.action_sequence AS "actionSequence",
  transition.runtime_id AS "runtimeId",
  transition.runtime_instance_id AS "runtimeInstanceId",
  transition.source_generation AS "sourceGeneration",
  transition.target_generation AS "targetGeneration",
  transition.mode_session_id AS "modeSessionId", transition.target_json AS "targetJson",
  transition.expires_at AS "expiresAt",
  transition.authority_expires_at AS "authorityExpiresAt",
  transition.consumed_at AS "consumedAt"`;

const decode = (row: Row): PersistedVoiceRealtimeTransitionGrant => ({
  operationKey: row.operationKey,
  tokenHash: row.tokenHash,
  sourceControlTokenHash: row.sourceControlTokenHash,
  authSessionId: AuthSessionId.make(row.authSessionId),
  sourceSessionId: VoiceSessionId.make(row.sourceSessionId),
  sourceLeaseGeneration: row.sourceLeaseGeneration,
  actionId: VoiceClientActionId.make(row.actionId),
  actionSequence: row.actionSequence,
  runtimeId: VoiceRuntimeId.make(row.runtimeId),
  runtimeInstanceId: VoiceRuntimeInstanceId.make(row.runtimeInstanceId),
  sourceGeneration: row.sourceGeneration,
  targetGeneration: row.targetGeneration,
  modeSessionId: VoiceModeSessionId.make(row.modeSessionId),
  target: decodeTarget(row.targetJson),
  expiresAt: row.expiresAt,
  authorityExpiresAt: row.authorityExpiresAt,
  consumedAt: row.consumedAt,
});

const sameIdentity = (
  row: PersistedVoiceRealtimeTransitionGrant,
  input: Omit<PersistedVoiceRealtimeTransitionGrant, "consumedAt">,
) =>
  row.operationKey === input.operationKey &&
  row.tokenHash === input.tokenHash &&
  row.sourceControlTokenHash === input.sourceControlTokenHash &&
  row.authSessionId === input.authSessionId &&
  row.sourceSessionId === input.sourceSessionId &&
  row.sourceLeaseGeneration === input.sourceLeaseGeneration &&
  row.actionId === input.actionId &&
  row.actionSequence === input.actionSequence &&
  row.runtimeId === input.runtimeId &&
  row.runtimeInstanceId === input.runtimeInstanceId &&
  row.sourceGeneration === input.sourceGeneration &&
  row.targetGeneration === input.targetGeneration &&
  row.modeSessionId === input.modeSessionId &&
  encodeTarget(row.target) === encodeTarget(input.target) &&
  row.expiresAt === input.expiresAt &&
  row.authorityExpiresAt === input.authorityExpiresAt;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const claim: VoiceRealtimeTransitionGrantRepositoryShape["claim"] = (input, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM voice_runtime_realtime_transition_grants
            WHERE expires_at <= ${now} AND consumed_at IS NULL`;
          const rows = yield* sql.unsafe<Row>(
            `SELECT ${selectColumns} FROM voice_runtime_realtime_transition_grants
             WHERE operation_key = ? OR
               (source_session_id = ? AND source_lease_generation = ? AND action_id = ?)
             LIMIT 1`,
            [
              input.operationKey,
              input.sourceSessionId,
              input.sourceLeaseGeneration,
              input.actionId,
            ],
          );
          const existing = rows[0];
          if (existing !== undefined) {
            const record = decode(existing);
            return sameIdentity(record, input)
              ? ({ status: "existing" as const, record } as const)
              : ({ status: "mismatch" as const } as const);
          }
          yield* sql`INSERT INTO voice_runtime_realtime_transition_grants (
            operation_key, token_hash, source_control_token_hash, auth_session_id,
            source_session_id,
            source_lease_generation, action_id, action_sequence, runtime_id, runtime_instance_id,
            source_generation, target_generation, mode_session_id, target_json,
            expires_at, authority_expires_at, created_at
          ) VALUES (
            ${input.operationKey}, ${input.tokenHash}, ${input.sourceControlTokenHash},
            ${input.authSessionId},
            ${input.sourceSessionId}, ${input.sourceLeaseGeneration}, ${input.actionId},
            ${input.actionSequence},
            ${input.runtimeId}, ${input.runtimeInstanceId}, ${input.sourceGeneration},
            ${input.targetGeneration}, ${input.modeSessionId}, ${encodeTarget(input.target)},
            ${input.expiresAt}, ${input.authorityExpiresAt}, ${now}
          )`;
          return { status: "claimed" as const };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceRealtimeTransitionGrantRepository.claim")));

  const findByToken: VoiceRealtimeTransitionGrantRepositoryShape["findByToken"] = (
    tokenHash,
    now,
  ) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
      const rows = yield* sql.unsafe<Row>(
        `SELECT ${qualifiedSelectColumns}
         FROM voice_runtime_realtime_transition_grants AS transition
         INNER JOIN auth_sessions AS auth ON auth.session_id = transition.auth_session_id
         WHERE transition.token_hash = ?
           AND (transition.consumed_at IS NOT NULL OR transition.expires_at > ?)
           AND transition.authority_expires_at > ? AND auth.revoked_at IS NULL
           AND auth.expires_at > ? LIMIT 1`,
        [tokenHash, now, now, nowIso],
      );
      return rows[0] === undefined ? undefined : decode(rows[0]);
    }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceRealtimeTransitionGrantRepository.findByToken")),
    );

  const findByOperationKey: VoiceRealtimeTransitionGrantRepositoryShape["findByOperationKey"] = (
    operationKey,
    now,
  ) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
      const rows = yield* sql.unsafe<Row>(
        `SELECT ${qualifiedSelectColumns}
         FROM voice_runtime_realtime_transition_grants AS transition
         INNER JOIN auth_sessions AS auth ON auth.session_id = transition.auth_session_id
         WHERE transition.operation_key = ?
           AND (transition.consumed_at IS NOT NULL OR transition.expires_at > ?)
           AND transition.authority_expires_at > ?
           AND auth.revoked_at IS NULL AND auth.expires_at > ? LIMIT 1`,
        [operationKey, now, now, nowIso],
      );
      return rows[0] === undefined ? undefined : decode(rows[0]);
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("VoiceRealtimeTransitionGrantRepository.findByOperationKey"),
      ),
    );

  const revoke: VoiceRealtimeTransitionGrantRepositoryShape["revoke"] = (operationKey) =>
    sql`DELETE FROM voice_runtime_realtime_transition_grants
      WHERE operation_key = ${operationKey} AND consumed_at IS NULL`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceRealtimeTransitionGrantRepository.revoke")),
    );
  const purgeExpired: VoiceRealtimeTransitionGrantRepositoryShape["purgeExpired"] = (now) =>
    sql`DELETE FROM voice_runtime_realtime_transition_grants
      WHERE (consumed_at IS NULL AND expires_at <= ${now})
        OR (consumed_at IS NOT NULL AND authority_expires_at <= ${now})`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceRealtimeTransitionGrantRepository.purgeExpired")),
    );

  return VoiceRealtimeTransitionGrantRepository.of({
    claim,
    findByToken,
    findByOperationKey,
    revoke,
    purgeExpired,
  });
});

export const VoiceRealtimeTransitionGrantRepositoryLive = Layer.effect(
  VoiceRealtimeTransitionGrantRepository,
  make,
);

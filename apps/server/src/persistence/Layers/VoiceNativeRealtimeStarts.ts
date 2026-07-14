import {
  AuthSessionId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceNativeRuntimeId,
  VoicePublicErrorReason,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceNativeRealtimeStartRepository,
  type PersistedVoiceNativeRealtimeStart,
  type VoiceNativeRealtimeStartRepositoryShape,
} from "../Services/VoiceNativeRealtimeStarts.ts";

interface StartRow {
  readonly operationKey: string;
  readonly authSessionId: string;
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly runtimeGeneration: number;
  readonly modeSessionId: string;
  readonly clientOperationId: string;
  readonly conversationId: string;
  readonly sessionId: string | null;
  readonly leaseGeneration: number | null;
  readonly failureReason: string | null;
  readonly failureOperation: string | null;
  readonly failureDetail: string | null;
  readonly failureRetryable: number | null;
  readonly claimExpiresAt: number;
  readonly expiresAt: number;
}
const decodeFailureReason = Schema.decodeUnknownSync(VoicePublicErrorReason);

const decode = (row: StartRow): PersistedVoiceNativeRealtimeStart => ({
  operationKey: row.operationKey,
  authSessionId: AuthSessionId.make(row.authSessionId),
  runtimeId: VoiceNativeRuntimeId.make(row.runtimeId),
  runtimeInstanceId: VoiceRuntimeInstanceId.make(row.runtimeInstanceId),
  runtimeGeneration: row.runtimeGeneration,
  modeSessionId: VoiceModeSessionId.make(row.modeSessionId),
  clientOperationId: row.clientOperationId,
  conversationId: VoiceConversationId.make(row.conversationId),
  sessionId: row.sessionId === null ? null : VoiceSessionId.make(row.sessionId),
  leaseGeneration: row.leaseGeneration,
  failure:
    row.failureReason === null ||
    row.failureOperation === null ||
    row.failureDetail === null ||
    row.failureRetryable === null
      ? null
      : {
          reason: decodeFailureReason(row.failureReason),
          operation: row.failureOperation,
          detail: row.failureDetail,
          retryable: row.failureRetryable === 1,
        },
  claimExpiresAt: row.claimExpiresAt,
  expiresAt: row.expiresAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const claim: VoiceNativeRealtimeStartRepositoryShape["claim"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<StartRow>`SELECT
            operation_key AS "operationKey", auth_session_id AS "authSessionId",
            runtime_id AS "runtimeId", runtime_instance_id AS "runtimeInstanceId",
            runtime_generation AS "runtimeGeneration", mode_session_id AS "modeSessionId",
            client_operation_id AS "clientOperationId", conversation_id AS "conversationId",
            session_id AS "sessionId", lease_generation AS "leaseGeneration",
            failure_reason AS "failureReason",
            failure_operation AS "failureOperation", failure_detail AS "failureDetail",
            failure_retryable AS "failureRetryable", claim_expires_at AS "claimExpiresAt",
            expires_at AS "expiresAt"
          FROM voice_native_realtime_starts WHERE operation_key = ${input.operationKey}
          LIMIT 1`;
          let existing = rows[0];
          if (existing !== undefined) {
            if (
              existing.authSessionId !== input.authSessionId ||
              existing.runtimeId !== input.runtimeId ||
              existing.runtimeInstanceId !== input.runtimeInstanceId ||
              existing.runtimeGeneration !== input.runtimeGeneration ||
              existing.modeSessionId !== input.modeSessionId ||
              existing.clientOperationId !== input.clientOperationId ||
              existing.conversationId !== input.conversationId
            )
              return { status: "mismatch" as const };
            if (existing.expiresAt <= input.now) {
              yield* sql`DELETE FROM voice_native_realtime_starts
                WHERE operation_key = ${input.operationKey}`;
              existing = undefined;
            }
            if (
              existing !== undefined &&
              existing.sessionId === null &&
              existing.failureReason !== null &&
              existing.failureRetryable === 1
            ) {
              yield* sql`UPDATE voice_native_realtime_starts SET
                failure_reason = NULL, failure_operation = NULL,
                failure_detail = NULL, failure_retryable = NULL,
                claim_expires_at = ${input.claimExpiresAt},
                expires_at = ${input.expiresAt}, updated_at = ${input.now}
                WHERE operation_key = ${input.operationKey}
                  AND session_id IS NULL AND failure_retryable = 1`;
              const updated = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
              if (updated[0]?.changed === 1) return { status: "claimed" as const };
            }
            if (existing !== undefined)
              return { status: "existing" as const, record: decode(existing) };
          }
          yield* sql`DELETE FROM voice_native_realtime_starts WHERE expires_at <= ${input.now}`;
          yield* sql`INSERT INTO voice_native_realtime_starts (
            operation_key, auth_session_id, runtime_id, runtime_generation,
            runtime_instance_id, mode_session_id, client_operation_id, conversation_id,
            claim_expires_at, expires_at,
            created_at, updated_at
          ) VALUES (
            ${input.operationKey}, ${input.authSessionId}, ${input.runtimeId},
            ${input.runtimeGeneration}, ${input.runtimeInstanceId}, ${input.modeSessionId},
            ${input.clientOperationId}, ${input.conversationId},
            ${input.claimExpiresAt}, ${input.expiresAt}, ${input.now}, ${input.now}
          )`;
          return { status: "claimed" as const };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeRealtimeStartRepository.claim")));

  const bindSession: VoiceNativeRealtimeStartRepositoryShape["bindSession"] = (
    operationKey,
    sessionId,
    leaseGeneration,
    now,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly sessionId: string | null;
            readonly leaseGeneration: number | null;
          }>`SELECT session_id AS "sessionId", lease_generation AS "leaseGeneration"
            FROM voice_native_realtime_starts
            WHERE operation_key = ${operationKey} LIMIT 1`;
          const existing = rows[0];
          if (existing === undefined) return false;
          if (existing.sessionId !== null)
            return existing.sessionId === sessionId && existing.leaseGeneration === leaseGeneration;
          yield* sql`UPDATE voice_native_realtime_starts
            SET session_id = ${sessionId}, lease_generation = ${leaseGeneration}, updated_at = ${now}
            WHERE operation_key = ${operationKey} AND session_id IS NULL
              AND failure_reason IS NULL
              AND claim_expires_at >= ${now}`;
          const updated = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return updated[0]?.changed === 1;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("VoiceNativeRealtimeStartRepository.bindSession")),
      );

  const findBySession: VoiceNativeRealtimeStartRepositoryShape["findBySession"] = (
    sessionId,
    now,
  ) =>
    sql<StartRow>`SELECT
      operation_key AS "operationKey", auth_session_id AS "authSessionId",
      runtime_id AS "runtimeId", runtime_instance_id AS "runtimeInstanceId",
      runtime_generation AS "runtimeGeneration", mode_session_id AS "modeSessionId",
      client_operation_id AS "clientOperationId", conversation_id AS "conversationId",
      session_id AS "sessionId", lease_generation AS "leaseGeneration",
      failure_reason AS "failureReason", failure_operation AS "failureOperation",
      failure_detail AS "failureDetail", failure_retryable AS "failureRetryable",
      claim_expires_at AS "claimExpiresAt", expires_at AS "expiresAt"
      FROM voice_native_realtime_starts
      WHERE session_id = ${sessionId} AND lease_generation IS NOT NULL
        AND failure_reason IS NULL AND expires_at > ${now}
      LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : decode(rows[0]))),
      Effect.mapError(toPersistenceSqlError("VoiceNativeRealtimeStartRepository.findBySession")),
    );

  const fail: VoiceNativeRealtimeStartRepositoryShape["fail"] = (operationKey, failure, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_native_realtime_starts SET
            failure_reason = ${failure.reason}, failure_operation = ${failure.operation},
            failure_detail = ${failure.detail}, failure_retryable = ${failure.retryable ? 1 : 0},
            updated_at = ${now}
            WHERE operation_key = ${operationKey} AND session_id IS NULL
              AND failure_reason IS NULL`;
          const updated = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return updated[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeRealtimeStartRepository.fail")));

  const revokeRuntime: VoiceNativeRealtimeStartRepositoryShape["revokeRuntime"] = (
    authSessionId,
    runtimeId,
  ) =>
    sql`DELETE FROM voice_native_realtime_starts
      WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeRealtimeStartRepository.revokeRuntime")),
    );
  const revokeAuthSession: VoiceNativeRealtimeStartRepositoryShape["revokeAuthSession"] = (
    authSessionId,
  ) =>
    sql`DELETE FROM voice_native_realtime_starts WHERE auth_session_id = ${authSessionId}`.pipe(
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlError("VoiceNativeRealtimeStartRepository.revokeAuthSession"),
      ),
    );
  const purgeExpired: VoiceNativeRealtimeStartRepositoryShape["purgeExpired"] = (now) =>
    sql`DELETE FROM voice_native_realtime_starts WHERE expires_at <= ${now}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeRealtimeStartRepository.purgeExpired")),
    );

  yield* Clock.currentTimeMillis.pipe(
    Effect.flatMap(purgeExpired),
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return VoiceNativeRealtimeStartRepository.of({
    claim,
    bindSession,
    findBySession,
    fail,
    revokeRuntime,
    revokeAuthSession,
    purgeExpired,
  });
});

export const VoiceNativeRealtimeStartRepositoryLive = Layer.effect(
  VoiceNativeRealtimeStartRepository,
  make,
);

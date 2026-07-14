import {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceRuntimeId,
  VoiceRuntimeProvisioningOperationId,
  VoiceRuntimeTarget,
  VoiceRuntimeTargetDigest,
  type VoiceRuntimeGrantOperation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceRuntimeGrantRepository,
  type PersistedVoiceRuntimeGrant,
  type VoiceRuntimeGrantRepositoryShape,
} from "../Services/VoiceRuntimeGrants.ts";

const encodeScopes = Schema.encodeSync(Schema.fromJsonString(Schema.Array(AuthEnvironmentScope)));
const decodeScopes = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(AuthEnvironmentScope)),
);
const encodeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceRuntimeTarget));
const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceRuntimeTarget));
const encodeGrantScopes = (scopes: ReadonlySet<AuthEnvironmentScope>) =>
  encodeScopes([...scopes].sort());

interface GrantRow {
  readonly tokenHash: string;
  readonly provisioningOperationId: string;
  readonly runtimeId: string;
  readonly generation: number;
  readonly authSessionId: string;
  readonly grantedScopesJson: string;
  readonly targetJson: string;
  readonly targetDigest: string;
  readonly operation: VoiceRuntimeGrantOperation;
  readonly readinessEnabled: number;
  readonly refreshCurrentHash: string | null;
  readonly refreshPreviousHash: string | null;
  readonly refreshRotationCounter: number;
  readonly refreshPreviousConfirmUntil: number | null;
  readonly refreshPreviousRequestId: string | null;
  readonly refreshPreviousCandidateHash: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const grantColumns = `
  runtime.token_hash AS "tokenHash",
  runtime.provisioning_operation_id AS "provisioningOperationId",
  runtime.runtime_id AS "runtimeId", runtime.generation,
  runtime.auth_session_id AS "authSessionId",
  runtime.granted_scopes_json AS "grantedScopesJson",
  runtime.target_json AS "targetJson", runtime.target_digest AS "targetDigest",
  runtime.operation, runtime.readiness_enabled AS "readinessEnabled",
  runtime.refresh_current_hash AS "refreshCurrentHash",
  runtime.refresh_previous_hash AS "refreshPreviousHash",
  runtime.refresh_rotation_counter AS "refreshRotationCounter",
  runtime.refresh_previous_confirm_until AS "refreshPreviousConfirmUntil",
  runtime.refresh_previous_request_id AS "refreshPreviousRequestId",
  runtime.refresh_previous_candidate_hash AS "refreshPreviousCandidateHash",
  runtime.created_at AS "issuedAt", runtime.expires_at AS "expiresAt"
`;

const mapGrant = (row: GrantRow): PersistedVoiceRuntimeGrant => ({
  tokenHash: row.tokenHash,
  provisioningOperationId: VoiceRuntimeProvisioningOperationId.make(row.provisioningOperationId),
  runtimeId: VoiceRuntimeId.make(row.runtimeId),
  generation: row.generation,
  authSessionId: AuthSessionId.make(row.authSessionId),
  grantedScopes: new Set(decodeScopes(row.grantedScopesJson)),
  target: decodeTarget(row.targetJson),
  targetDigest: VoiceRuntimeTargetDigest.make(row.targetDigest),
  operation: row.operation,
  readinessEnabled: row.readinessEnabled === 1,
  refreshRotationCounter: row.refreshRotationCounter,
  issuedAt: row.issuedAt,
  expiresAt: row.expiresAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const revokeDerived = (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
    preserveSessionClose: boolean,
  ) =>
    Effect.gen(function* () {
      yield* sql`UPDATE voice_thread_turn_operations SET
        token_hash = 'revoked:' || operation_id,
        detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
        active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
        processing_lease_until = CASE WHEN dispatch_accepted = 0
          THEN NULL ELSE processing_lease_until END,
        processing_lease_token = CASE WHEN dispatch_accepted = 0
          THEN NULL ELSE processing_lease_token END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      yield* sql`DELETE FROM voice_runtime_realtime_starts
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      if (preserveSessionClose) {
        yield* sql`DELETE FROM voice_runtime_control_grants
          WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}
            AND session_close = 0`;
        yield* sql`UPDATE voice_runtime_control_grants SET
          session_control = 0, handoff_actions = 0, webrtc_signaling = 0
          WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}
            AND session_close = 1`;
      } else {
        yield* sql`DELETE FROM voice_runtime_control_grants
          WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      }
    });

  const replace: VoiceRuntimeGrantRepositoryShape["replace"] = (grant, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<GrantRow>(
            `SELECT ${grantColumns} FROM voice_runtime_grants AS runtime
             WHERE runtime.auth_session_id = ? AND runtime.runtime_id = ? LIMIT 1`,
            [grant.authSessionId, grant.runtimeId],
          );
          const previous = rows[0];
          const fenceRows = yield* sql<{ readonly maximumGeneration: number }>`
            SELECT maximum_generation AS "maximumGeneration"
            FROM voice_runtime_generation_fences
            WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}
            LIMIT 1`;
          const persistedGeneration = previous?.generation ?? fenceRows[0]?.maximumGeneration;
          const currentGeneration = persistedGeneration ?? grant.expectedCurrentGeneration;
          const grantedScopesJson = encodeGrantScopes(grant.grantedScopes);
          const targetJson = encodeTarget(grant.target);
          if (previous?.generation === grant.generation) {
            const refreshHash = grant.readinessEnabled ? grant.refreshCredentialHash : null;
            if (
              previous.tokenHash !== grant.tokenHash ||
              previous.provisioningOperationId !== grant.provisioningOperationId ||
              previous.grantedScopesJson !== grantedScopesJson ||
              previous.targetJson !== targetJson ||
              previous.targetDigest !== grant.targetDigest ||
              previous.operation !== grant.operation ||
              previous.readinessEnabled !== (grant.readinessEnabled ? 1 : 0) ||
              previous.refreshCurrentHash !== refreshHash
            )
              return { status: "stale" as const };
            return {
              status: "existing" as const,
              issuedAt: previous.issuedAt,
              expiresAt: previous.expiresAt,
              refreshRotationCounter: previous.refreshRotationCounter,
            };
          }
          if (grant.generation !== grant.expectedCurrentGeneration + 1)
            return { status: "stale" as const };
          if (
            persistedGeneration !== undefined &&
            grant.expectedCurrentGeneration !== currentGeneration
          )
            return { status: "stale" as const };
          yield* revokeDerived(grant.authSessionId, grant.runtimeId, false);
          yield* sql`DELETE FROM voice_runtime_refresh_requests
            WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
          yield* sql`DELETE FROM voice_runtime_grants
            WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
          yield* sql`INSERT INTO voice_runtime_grants (
            token_hash, provisioning_operation_id, runtime_id, generation, auth_session_id,
            granted_scopes_json, target_json, target_digest, operation, readiness_enabled,
            refresh_current_hash, refresh_rotation_counter, expires_at, created_at
          ) VALUES (
            ${grant.tokenHash}, ${grant.provisioningOperationId}, ${grant.runtimeId},
            ${grant.generation}, ${grant.authSessionId}, ${grantedScopesJson}, ${targetJson},
            ${grant.targetDigest}, ${grant.operation}, ${grant.readinessEnabled ? 1 : 0},
            ${grant.readinessEnabled ? grant.refreshCredentialHash : null}, 0,
            ${grant.expiresAt}, ${now}
          )`;
          yield* sql`INSERT INTO voice_runtime_generation_fences (
            auth_session_id, runtime_id, maximum_generation
          ) VALUES (${grant.authSessionId}, ${grant.runtimeId}, ${grant.generation})
          ON CONFLICT(auth_session_id, runtime_id) DO UPDATE SET
            maximum_generation = MAX(maximum_generation, excluded.maximum_generation)`;
          return {
            status: "issued" as const,
            issuedAt: now,
            expiresAt: grant.expiresAt,
            refreshRotationCounter: 0,
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceRuntimeGrantRepository.replace")));

  const findActive: VoiceRuntimeGrantRepositoryShape["findActive"] = (tokenHash, now) => {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
    return sql
      .unsafe<GrantRow>(
        `SELECT ${grantColumns} FROM voice_runtime_grants AS runtime
         INNER JOIN auth_sessions AS auth ON auth.session_id = runtime.auth_session_id
         WHERE runtime.token_hash = ? AND runtime.expires_at > ?
           AND auth.revoked_at IS NULL AND auth.expires_at > ? LIMIT 1`,
        [tokenHash, now, nowIso],
      )
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : mapGrant(rows[0]))),
        Effect.mapError(toPersistenceSqlError("VoiceRuntimeGrantRepository.findActive")),
      );
  };

  const transition: VoiceRuntimeGrantRepositoryShape["transition"] = (input, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.targetGeneration !== input.sourceGeneration + 1)
            return { status: "stale" as const };
          const transitionRows = yield* sql<{
            readonly authSessionId: string;
            readonly runtimeId: string;
            readonly sourceGeneration: number;
            readonly targetGeneration: number;
            readonly targetJson: string;
            readonly expiresAt: number;
            readonly authorityExpiresAt: number;
            readonly consumedAt: number | null;
          }>`SELECT auth_session_id AS "authSessionId", runtime_id AS "runtimeId",
              source_generation AS "sourceGeneration", target_generation AS "targetGeneration",
              target_json AS "targetJson", expires_at AS "expiresAt",
              authority_expires_at AS "authorityExpiresAt", consumed_at AS "consumedAt"
            FROM voice_runtime_realtime_transition_grants
            WHERE token_hash = ${input.tokenHash} LIMIT 1`;
          const transition = transitionRows[0];
          const targetJson = encodeTarget(input.target);
          if (
            transition === undefined ||
            transition.authSessionId !== input.authSessionId ||
            transition.runtimeId !== input.runtimeId ||
            transition.sourceGeneration !== input.sourceGeneration ||
            transition.targetGeneration !== input.targetGeneration ||
            transition.targetJson !== targetJson ||
            transition.authorityExpiresAt !== input.authorityExpiresAt ||
            transition.authorityExpiresAt <= now ||
            (transition.consumedAt === null && transition.expiresAt <= now)
          )
            return { status: "stale" as const };
          const rows = yield* sql.unsafe<GrantRow>(
            `SELECT ${grantColumns} FROM voice_runtime_grants AS runtime
             WHERE runtime.auth_session_id = ? AND runtime.runtime_id = ? LIMIT 1`,
            [input.authSessionId, input.runtimeId],
          );
          const current = rows[0];
          if (current === undefined || current.expiresAt <= now)
            return { status: "stale" as const };
          if (current.generation === input.targetGeneration) {
            if (
              transition.consumedAt === null ||
              current.tokenHash !== input.tokenHash ||
              current.targetJson !== targetJson ||
              current.targetDigest !== input.targetDigest
            )
              return { status: "stale" as const };
            return {
              status: "existing" as const,
              issuedAt: current.issuedAt,
              expiresAt: current.expiresAt,
              refreshRotationCounter: current.refreshRotationCounter,
            };
          }
          if (transition.consumedAt !== null || current.generation !== input.sourceGeneration)
            return { status: "stale" as const };
          yield* sql`UPDATE voice_runtime_realtime_transition_grants
            SET consumed_at = ${now}
            WHERE token_hash = ${input.tokenHash} AND consumed_at IS NULL
              AND expires_at > ${now}`;
          const consumed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          if (consumed[0]?.changed !== 1) return { status: "stale" as const };
          yield* revokeDerived(input.authSessionId, input.runtimeId, true);
          yield* sql`DELETE FROM voice_runtime_refresh_requests
            WHERE auth_session_id = ${input.authSessionId} AND runtime_id = ${input.runtimeId}`;
          const provisioningOperationId = VoiceRuntimeProvisioningOperationId.make(
            `handoff-${input.sourceGeneration}-${input.targetGeneration}-${input.tokenHash}`,
          );
          yield* sql`UPDATE voice_runtime_grants SET
            token_hash = ${input.tokenHash},
            provisioning_operation_id = ${provisioningOperationId},
            generation = ${input.targetGeneration}, target_json = ${targetJson},
            target_digest = ${input.targetDigest}, operation = 'thread-turn-start',
            readiness_enabled = 0, refresh_current_hash = NULL,
            refresh_previous_hash = NULL, refresh_rotation_counter = 0,
            refresh_previous_confirm_until = NULL, refresh_previous_request_id = NULL,
            refresh_previous_candidate_hash = NULL, expires_at = ${input.authorityExpiresAt},
            created_at = ${now}
            WHERE auth_session_id = ${input.authSessionId} AND runtime_id = ${input.runtimeId}`;
          yield* sql`INSERT INTO voice_runtime_generation_fences (
            auth_session_id, runtime_id, maximum_generation
          ) VALUES (${input.authSessionId}, ${input.runtimeId}, ${input.targetGeneration})
          ON CONFLICT(auth_session_id, runtime_id) DO UPDATE SET
            maximum_generation = MAX(maximum_generation, excluded.maximum_generation)`;
          return {
            status: "issued" as const,
            issuedAt: now,
            expiresAt: input.authorityExpiresAt,
            refreshRotationCounter: 0,
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceRuntimeGrantRepository.transition")));

  const refresh: VoiceRuntimeGrantRepositoryShape["refresh"] = (input, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
          const rows = yield* sql.unsafe<GrantRow & { readonly authExpiresAt: string }>(
            `SELECT ${grantColumns}, auth.expires_at AS "authExpiresAt"
             FROM voice_runtime_grants AS runtime
             INNER JOIN auth_sessions AS auth ON auth.session_id = runtime.auth_session_id
             WHERE runtime.runtime_id = ?
               AND (
                 runtime.refresh_current_hash = ?
                 OR runtime.refresh_previous_hash = ?
               )
               AND auth.revoked_at IS NULL AND auth.expires_at > ? LIMIT 1`,
            [input.runtimeId, input.refreshCredentialHash, input.refreshCredentialHash, nowIso],
          );
          const current = rows[0];
          if (
            current === undefined ||
            current.readinessEnabled !== 1 ||
            current.refreshCurrentHash === null ||
            current.generation !== input.generation ||
            current.provisioningOperationId !== input.provisioningOperationId ||
            current.operation !== input.operation ||
            current.targetDigest !== input.targetDigest
          )
            return { status: "stale" as const };
          const usingCurrent = current.refreshCurrentHash === input.refreshCredentialHash;
          const usingPrevious =
            current.refreshPreviousHash === input.refreshCredentialHash &&
            current.refreshPreviousConfirmUntil !== null &&
            current.refreshPreviousConfirmUntil > now &&
            current.refreshPreviousRequestId === input.refreshRequestId &&
            current.refreshPreviousCandidateHash === input.candidateCredentialHash;
          if (!usingCurrent && !usingPrevious) return { status: "stale" as const };

          const requestRows = yield* sql<{
            readonly provisioningOperationId: string;
            readonly generation: number;
            readonly operation: VoiceRuntimeGrantOperation;
            readonly targetDigest: string;
            readonly expectedRotationCounter: number;
            readonly candidateCredentialHash: string;
          }>`SELECT provisioning_operation_id AS "provisioningOperationId", generation,
              operation, target_digest AS "targetDigest",
              expected_rotation_counter AS "expectedRotationCounter",
              candidate_credential_hash AS "candidateCredentialHash"
            FROM voice_runtime_refresh_requests
            WHERE auth_session_id = ${current.authSessionId}
              AND runtime_id = ${input.runtimeId}
              AND refresh_request_id = ${input.refreshRequestId} LIMIT 1`;
          const priorRequest = requestRows[0];
          if (priorRequest !== undefined) {
            if (
              priorRequest.provisioningOperationId !== input.provisioningOperationId ||
              priorRequest.generation !== input.generation ||
              priorRequest.operation !== input.operation ||
              priorRequest.targetDigest !== input.targetDigest ||
              priorRequest.expectedRotationCounter !== input.expectedRotationCounter ||
              priorRequest.candidateCredentialHash !== input.candidateCredentialHash ||
              current.refreshCurrentHash !== input.candidateCredentialHash ||
              current.refreshRotationCounter !== input.expectedRotationCounter + 1
            )
              return { status: "stale" as const };
            if (usingCurrent && current.refreshPreviousHash !== null) {
              yield* sql`UPDATE voice_runtime_grants SET
                refresh_previous_hash = NULL, refresh_previous_confirm_until = NULL,
                refresh_previous_request_id = NULL, refresh_previous_candidate_hash = NULL
                WHERE auth_session_id = ${current.authSessionId}
                  AND runtime_id = ${input.runtimeId}`;
            }
            return { status: "existing" as const, grant: mapGrant(current) };
          }
          if (
            !usingCurrent ||
            current.refreshRotationCounter !== input.expectedRotationCounter ||
            input.candidateCredentialHash === current.refreshCurrentHash ||
            input.candidateCredentialHash === current.refreshPreviousHash
          )
            return { status: "stale" as const };

          const authExpiresAt = Date.parse(current.authExpiresAt);
          const expiresAt = Math.min(input.proposedExpiresAt, authExpiresAt);
          const nextCounter = current.refreshRotationCounter + 1;
          yield* sql`DELETE FROM voice_runtime_refresh_requests
            WHERE auth_session_id = ${current.authSessionId} AND runtime_id = ${input.runtimeId}`;
          yield* sql`INSERT INTO voice_runtime_refresh_requests (
            auth_session_id, runtime_id, refresh_request_id, provisioning_operation_id,
            generation, operation, target_digest, expected_rotation_counter,
            candidate_credential_hash, created_at
          ) VALUES (
            ${current.authSessionId}, ${input.runtimeId}, ${input.refreshRequestId},
            ${input.provisioningOperationId}, ${input.generation}, ${input.operation},
            ${input.targetDigest}, ${input.expectedRotationCounter},
            ${input.candidateCredentialHash}, ${now}
          )`;
          yield* sql`UPDATE voice_runtime_grants SET
            token_hash = ${input.runtimeGrantTokenHash},
            refresh_previous_hash = refresh_current_hash,
            refresh_current_hash = ${input.candidateCredentialHash},
            refresh_rotation_counter = ${nextCounter},
            refresh_previous_confirm_until = ${now + 5 * 60_000},
            refresh_previous_request_id = ${input.refreshRequestId},
            refresh_previous_candidate_hash = ${input.candidateCredentialHash},
            expires_at = ${expiresAt}, created_at = ${now}
            WHERE auth_session_id = ${current.authSessionId} AND runtime_id = ${input.runtimeId}`;
          return {
            status: "issued" as const,
            grant: mapGrant({
              ...current,
              tokenHash: input.runtimeGrantTokenHash,
              refreshCurrentHash: input.candidateCredentialHash,
              refreshPreviousHash: current.refreshCurrentHash,
              refreshRotationCounter: nextCounter,
              refreshPreviousConfirmUntil: now + 5 * 60_000,
              refreshPreviousRequestId: input.refreshRequestId,
              refreshPreviousCandidateHash: input.candidateCredentialHash,
              issuedAt: now,
              expiresAt,
            }),
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceRuntimeGrantRepository.refresh")));

  const revokeRuntime: VoiceRuntimeGrantRepositoryShape["revokeRuntime"] = (
    authSessionId,
    runtimeId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly generation: number }>`SELECT generation
            FROM voice_runtime_grants WHERE auth_session_id = ${authSessionId}
              AND runtime_id = ${runtimeId} LIMIT 1`;
          const current = rows[0];
          if (current === undefined) return false;
          yield* sql`DELETE FROM voice_runtime_refresh_requests
            WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
          yield* sql`DELETE FROM voice_runtime_grants
            WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
          yield* sql`INSERT INTO voice_runtime_generation_fences (
            auth_session_id, runtime_id, maximum_generation
          ) VALUES (${authSessionId}, ${runtimeId}, ${current.generation})
          ON CONFLICT(auth_session_id, runtime_id) DO UPDATE SET
            maximum_generation = MAX(maximum_generation, excluded.maximum_generation)`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceRuntimeGrantRepository.revokeRuntime")));

  const revokeAuthSession = (authSessionId: AuthSessionId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM voice_runtime_refresh_requests
            WHERE auth_session_id = ${authSessionId}`;
          yield* sql`DELETE FROM voice_runtime_grants WHERE auth_session_id = ${authSessionId}`;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("VoiceRuntimeGrantRepository.revokeAuthSession")),
      );

  return VoiceRuntimeGrantRepository.of({
    replace,
    findActive,
    transition,
    refresh,
    revokeRuntime,
    revokeAuthSession,
  });
});

export const VoiceRuntimeGrantRepositoryLive = Layer.effect(VoiceRuntimeGrantRepository, make);

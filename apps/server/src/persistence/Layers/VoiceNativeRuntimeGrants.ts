import {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceNativeRuntimeId,
  VoiceNativeRuntimeTarget,
  VoiceRuntimeProvisioningOperationId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceNativeRuntimeGrantRepository,
  type VoiceNativeRuntimeGrantRepositoryShape,
} from "../Services/VoiceNativeRuntimeGrants.ts";

const encodeScopes = Schema.encodeSync(Schema.fromJsonString(Schema.Array(AuthEnvironmentScope)));
const decodeScopes = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(AuthEnvironmentScope)),
);
const encodeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceNativeRuntimeTarget));
const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceNativeRuntimeTarget));
const encodeGrantScopes = (scopes: ReadonlySet<AuthEnvironmentScope>) =>
  encodeScopes([...scopes].sort());

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const replace: VoiceNativeRuntimeGrantRepositoryShape["replace"] = (grant, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{
            readonly tokenHash: string;
            readonly provisioningOperationId: string | null;
            readonly generation: number;
            readonly issuedAt: number;
            readonly expiresAt: number;
            readonly grantedScopesJson: string;
            readonly targetJson: string;
          }>`
          SELECT token_hash AS "tokenHash",
            provisioning_operation_id AS "provisioningOperationId", generation,
            created_at AS "issuedAt",
            expires_at AS "expiresAt", granted_scopes_json AS "grantedScopesJson",
            target_json AS "targetJson"
          FROM voice_native_runtime_grants
          WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}
          LIMIT 1
        `;
          const previous = existing[0];
          const grantedScopesJson = encodeGrantScopes(grant.grantedScopes);
          const targetJson = encodeTarget(grant.target);
          if (previous !== undefined && previous.generation > grant.generation)
            return { status: "stale" as const };
          if (previous?.generation === grant.generation) {
            if (
              previous.tokenHash !== grant.tokenHash ||
              previous.provisioningOperationId !== grant.provisioningOperationId ||
              previous.grantedScopesJson !== grantedScopesJson ||
              previous.targetJson !== targetJson
            )
              return { status: "stale" as const };
            return {
              status: "existing" as const,
              issuedAt: previous.issuedAt,
              expiresAt: previous.expiresAt,
            };
          }
          yield* sql`UPDATE voice_native_thread_turn_operations SET
            token_hash = 'revoked:' || operation_id,
            detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
            active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
            processing_lease_until = CASE WHEN dispatch_accepted = 0
              THEN NULL ELSE processing_lease_until END,
            processing_lease_token = CASE WHEN dispatch_accepted = 0
              THEN NULL ELSE processing_lease_token END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
          yield* sql`DELETE FROM voice_native_realtime_starts
            WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
          yield* sql`DELETE FROM voice_native_control_grants
            WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
          yield* sql`DELETE FROM voice_native_runtime_grants
          WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
          yield* sql`INSERT INTO voice_native_runtime_grants (
          token_hash, provisioning_operation_id, runtime_id, generation, auth_session_id,
          granted_scopes_json, target_json, expires_at, created_at
        ) VALUES (
          ${grant.tokenHash}, ${grant.provisioningOperationId}, ${grant.runtimeId},
          ${grant.generation}, ${grant.authSessionId}, ${grantedScopesJson}, ${targetJson},
          ${grant.expiresAt}, ${now}
        )`;
          return {
            status: "issued" as const,
            issuedAt: now,
            expiresAt: grant.expiresAt,
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeRuntimeGrantRepository.replace")));

  const findActive: VoiceNativeRuntimeGrantRepositoryShape["findActive"] = (tokenHash, now) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM voice_native_runtime_grants WHERE expires_at <= ${now}`;
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
      const rows = yield* sql<{
        readonly runtimeId: string;
        readonly provisioningOperationId: string;
        readonly generation: number;
        readonly authSessionId: string;
        readonly grantedScopesJson: string;
        readonly targetJson: string;
        readonly issuedAt: number;
        readonly expiresAt: number;
      }>`SELECT runtime.runtime_id AS "runtimeId",
          runtime.provisioning_operation_id AS "provisioningOperationId", runtime.generation,
          runtime.auth_session_id AS "authSessionId",
          runtime.granted_scopes_json AS "grantedScopesJson",
          runtime.target_json AS "targetJson", runtime.created_at AS "issuedAt",
          runtime.expires_at AS "expiresAt"
        FROM voice_native_runtime_grants AS runtime
        INNER JOIN auth_sessions AS auth ON auth.session_id = runtime.auth_session_id
        WHERE runtime.token_hash = ${tokenHash}
          AND auth.revoked_at IS NULL AND auth.expires_at > ${nowIso}
        LIMIT 1`;
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        tokenHash,
        provisioningOperationId: VoiceRuntimeProvisioningOperationId.make(
          row.provisioningOperationId,
        ),
        runtimeId: VoiceNativeRuntimeId.make(row.runtimeId),
        generation: row.generation,
        authSessionId: AuthSessionId.make(row.authSessionId),
        grantedScopes: new Set(decodeScopes(row.grantedScopesJson)),
        target: decodeTarget(row.targetJson),
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
      };
    }).pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeRuntimeGrantRepository.findActive")));

  const transition: VoiceNativeRuntimeGrantRepositoryShape["transition"] = (input, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.targetGeneration !== input.sourceGeneration + 1) {
            return { status: "stale" as const };
          }
          const rows = yield* sql<{
            readonly tokenHash: string;
            readonly generation: number;
            readonly grantedScopesJson: string;
            readonly targetJson: string;
            readonly provisioningOperationId: string;
            readonly issuedAt: number;
            readonly expiresAt: number;
          }>`SELECT token_hash AS "tokenHash", generation,
              provisioning_operation_id AS "provisioningOperationId",
              granted_scopes_json AS "grantedScopesJson", target_json AS "targetJson",
              created_at AS "issuedAt", expires_at AS "expiresAt"
            FROM voice_native_runtime_grants
            WHERE auth_session_id = ${input.authSessionId} AND runtime_id = ${input.runtimeId}
            LIMIT 1`;
          const current = rows[0];
          if (current === undefined || current.expiresAt <= now) {
            return { status: "stale" as const };
          }
          const targetJson = encodeTarget(input.target);
          if (current.generation === input.targetGeneration) {
            return current.tokenHash === input.tokenHash && current.targetJson === targetJson
              ? ({
                  status: "existing" as const,
                  issuedAt: current.issuedAt,
                  expiresAt: current.expiresAt,
                } as const)
              : ({ status: "stale" as const } as const);
          }
          if (current.generation !== input.sourceGeneration) {
            return { status: "stale" as const };
          }
          yield* sql`DELETE FROM voice_native_runtime_grants
            WHERE auth_session_id = ${input.authSessionId} AND runtime_id = ${input.runtimeId}
              AND generation = ${input.sourceGeneration}`;
          const provisioningOperationId = VoiceRuntimeProvisioningOperationId.make(
            `handoff-${input.sourceGeneration}-${input.targetGeneration}-${input.tokenHash}`,
          );
          yield* sql`INSERT INTO voice_native_runtime_grants (
            token_hash, provisioning_operation_id, runtime_id, generation, auth_session_id,
            granted_scopes_json,
            target_json, expires_at, created_at
          ) VALUES (
            ${input.tokenHash}, ${provisioningOperationId}, ${input.runtimeId}, ${input.targetGeneration},
            ${input.authSessionId}, ${current.grantedScopesJson}, ${targetJson},
            ${current.expiresAt}, ${now}
          )`;
          return {
            status: "issued" as const,
            issuedAt: now,
            expiresAt: current.expiresAt,
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeRuntimeGrantRepository.transition")));

  const revokeRuntime: VoiceNativeRuntimeGrantRepositoryShape["revokeRuntime"] = (
    authSessionId,
    runtimeId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly found: number }>`SELECT 1 AS found
      FROM voice_native_runtime_grants WHERE auth_session_id = ${authSessionId}
      AND runtime_id = ${runtimeId} LIMIT 1`;
          yield* sql`DELETE FROM voice_native_runtime_grants WHERE auth_session_id = ${authSessionId}
      AND runtime_id = ${runtimeId}`;
          return rows.length > 0;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("VoiceNativeRuntimeGrantRepository.revokeRuntime")),
      );

  const revokeAuthSession = (authSessionId: AuthSessionId) =>
    sql`DELETE FROM voice_native_runtime_grants WHERE auth_session_id = ${authSessionId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeRuntimeGrantRepository.revokeAuthSession")),
    );
  return VoiceNativeRuntimeGrantRepository.of({
    replace,
    findActive,
    transition,
    revokeRuntime,
    revokeAuthSession,
  });
});

export const VoiceNativeRuntimeGrantRepositoryLive = Layer.effect(
  VoiceNativeRuntimeGrantRepository,
  make,
);

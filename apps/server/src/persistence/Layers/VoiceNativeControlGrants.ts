import { AuthSessionId, VoiceNativeRuntimeId, VoiceSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceNativeControlGrantRepository,
  type VoiceNativeControlGrantRepositoryShape,
} from "../Services/VoiceNativeControlGrants.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insert: VoiceNativeControlGrantRepositoryShape["insert"] = (grant, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO voice_native_control_grants (
            token_hash, auth_session_id, session_id, lease_generation, expires_at,
            session_control, handoff_actions, webrtc_signaling, session_close,
            runtime_id, runtime_generation, created_at
          )
          SELECT
            ${grant.tokenHash}, ${grant.authSessionId}, ${grant.sessionId},
            ${grant.leaseGeneration}, ${grant.expiresAt},
            ${grant.capabilities.has("session-control") ? 1 : 0},
            ${grant.capabilities.has("handoff-actions") ? 1 : 0},
            ${grant.capabilities.has("webrtc-signaling") ? 1 : 0},
            ${grant.capabilities.has("session-close") ? 1 : 0},
            ${grant.runtimeId ?? null}, ${grant.runtimeGeneration ?? null}, ${now}
          WHERE ${grant.runtimeId ?? null} IS NULL OR EXISTS (
            SELECT 1 FROM voice_native_runtime_grants
            WHERE auth_session_id = ${grant.authSessionId}
              AND runtime_id = ${grant.runtimeId ?? null}
              AND generation = ${grant.runtimeGeneration ?? null}
              AND expires_at > ${now}
          )
        `;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeControlGrantRepository.insert")));
  const findActive: VoiceNativeControlGrantRepositoryShape["findActive"] = (tokenHash, now) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM voice_native_control_grants WHERE expires_at <= ${now}`;
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
      const rows = yield* sql<{
        readonly authSessionId: string;
        readonly sessionId: string;
        readonly leaseGeneration: number;
        readonly expiresAt: number;
        readonly sessionControl: number;
        readonly handoffActions: number;
        readonly webrtcSignaling: number;
        readonly sessionClose: number;
        readonly runtimeId: string | null;
        readonly runtimeGeneration: number | null;
        readonly runtimeActive: number;
      }>`
        SELECT child.auth_session_id AS "authSessionId", child.session_id AS "sessionId",
          child.lease_generation AS "leaseGeneration", child.expires_at AS "expiresAt",
          child.session_control AS "sessionControl", child.handoff_actions AS "handoffActions",
          child.webrtc_signaling AS "webrtcSignaling", child.session_close AS "sessionClose",
          child.runtime_id AS "runtimeId", child.runtime_generation AS "runtimeGeneration"
          , CASE WHEN runtime.token_hash IS NULL THEN 0 ELSE 1 END AS "runtimeActive"
        FROM voice_native_control_grants AS child
        LEFT JOIN voice_native_runtime_grants AS runtime
          ON runtime.auth_session_id = child.auth_session_id
          AND runtime.runtime_id = child.runtime_id
          AND runtime.generation = child.runtime_generation
          AND runtime.expires_at > ${now}
        LEFT JOIN auth_sessions AS auth ON auth.session_id = child.auth_session_id
        WHERE child.token_hash = ${tokenHash}
          AND (
            child.runtime_id IS NULL OR (
              auth.revoked_at IS NULL
              AND auth.expires_at > ${nowIso}
              AND (runtime.token_hash IS NOT NULL OR child.session_close = 1)
            )
          )
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return undefined;
      const capabilities = new Set<
        "session-control" | "handoff-actions" | "webrtc-signaling" | "session-close"
      >();
      if (row.runtimeId === null || row.runtimeActive === 1) {
        if (row.sessionControl === 1) capabilities.add("session-control");
        if (row.handoffActions === 1) capabilities.add("handoff-actions");
        if (row.webrtcSignaling === 1) capabilities.add("webrtc-signaling");
      }
      if (row.sessionClose === 1) capabilities.add("session-close");
      return {
        tokenHash,
        authSessionId: AuthSessionId.make(row.authSessionId),
        sessionId: VoiceSessionId.make(row.sessionId),
        leaseGeneration: row.leaseGeneration,
        expiresAt: row.expiresAt,
        capabilities,
        ...(row.runtimeId === null ? {} : { runtimeId: VoiceNativeRuntimeId.make(row.runtimeId) }),
        ...(row.runtimeGeneration === null ? {} : { runtimeGeneration: row.runtimeGeneration }),
      };
    }).pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeControlGrantRepository.findActive")));
  const releaseSessionControl: VoiceNativeControlGrantRepositoryShape["releaseSessionControl"] = (
    sessionId,
  ) =>
    sql`DELETE FROM voice_native_control_grants
          WHERE session_id = ${sessionId} AND handoff_actions = 0`.pipe(
      Effect.andThen(
        sql`UPDATE voice_native_control_grants SET session_control = 0
              WHERE session_id = ${sessionId} AND handoff_actions = 1`,
      ),
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlError("VoiceNativeControlGrantRepository.releaseSessionControl"),
      ),
    );
  const revokeSession = (sessionId: VoiceSessionId) =>
    sql`DELETE FROM voice_native_control_grants WHERE session_id = ${sessionId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeControlGrantRepository.revokeSession")),
    );
  const revokeAuthSession = (authSessionId: AuthSessionId) =>
    sql`DELETE FROM voice_native_control_grants WHERE auth_session_id = ${authSessionId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeControlGrantRepository.revokeAuthSession")),
    );
  const revokeRuntime = (authSessionId: AuthSessionId, runtimeId: VoiceNativeRuntimeId) =>
    sql`DELETE FROM voice_native_control_grants WHERE auth_session_id = ${authSessionId}
      AND runtime_id = ${runtimeId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeControlGrantRepository.revokeRuntime")),
    );
  return VoiceNativeControlGrantRepository.of({
    insert,
    findActive,
    releaseSessionControl,
    revokeSession,
    revokeAuthSession,
    revokeRuntime,
  });
});

export const VoiceNativeControlGrantRepositoryLive = Layer.effect(
  VoiceNativeControlGrantRepository,
  make,
);

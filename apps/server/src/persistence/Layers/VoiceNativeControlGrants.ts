import { AuthSessionId, VoiceSessionId } from "@t3tools/contracts";
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
    sql`
      INSERT INTO voice_native_control_grants (
        token_hash, auth_session_id, session_id, lease_generation, expires_at,
        session_control, handoff_actions, created_at
      ) VALUES (
        ${grant.tokenHash}, ${grant.authSessionId}, ${grant.sessionId},
        ${grant.leaseGeneration}, ${grant.expiresAt},
        ${grant.capabilities.has("session-control") ? 1 : 0},
        ${grant.capabilities.has("handoff-actions") ? 1 : 0}, ${now}
      )
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeControlGrantRepository.insert")),
    );
  const findActive: VoiceNativeControlGrantRepositoryShape["findActive"] = (tokenHash, now) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM voice_native_control_grants WHERE expires_at <= ${now}`;
      const rows = yield* sql<{
        readonly authSessionId: string;
        readonly sessionId: string;
        readonly leaseGeneration: number;
        readonly expiresAt: number;
        readonly sessionControl: number;
        readonly handoffActions: number;
      }>`
        SELECT auth_session_id AS "authSessionId", session_id AS "sessionId",
          lease_generation AS "leaseGeneration", expires_at AS "expiresAt",
          session_control AS "sessionControl", handoff_actions AS "handoffActions"
        FROM voice_native_control_grants WHERE token_hash = ${tokenHash} LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return undefined;
      const capabilities = new Set<"session-control" | "handoff-actions">();
      if (row.sessionControl === 1) capabilities.add("session-control");
      if (row.handoffActions === 1) capabilities.add("handoff-actions");
      return {
        tokenHash,
        authSessionId: AuthSessionId.make(row.authSessionId),
        sessionId: VoiceSessionId.make(row.sessionId),
        leaseGeneration: row.leaseGeneration,
        expiresAt: row.expiresAt,
        capabilities,
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
  return VoiceNativeControlGrantRepository.of({
    insert,
    findActive,
    releaseSessionControl,
    revokeSession,
    revokeAuthSession,
  });
});

export const VoiceNativeControlGrantRepositoryLive = Layer.effect(
  VoiceNativeControlGrantRepository,
  make,
);

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE voice_native_control_grants_next (
      token_hash TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
      expires_at INTEGER NOT NULL,
      session_control INTEGER NOT NULL CHECK (session_control IN (0, 1)),
      handoff_actions INTEGER NOT NULL CHECK (handoff_actions IN (0, 1)),
      created_at INTEGER NOT NULL,
      runtime_id TEXT,
      runtime_generation INTEGER,
      webrtc_signaling INTEGER NOT NULL DEFAULT 0 CHECK (webrtc_signaling IN (0, 1)),
      session_close INTEGER NOT NULL DEFAULT 0 CHECK (session_close IN (0, 1)),
      CHECK (
        session_control = 1 OR handoff_actions = 1 OR
        webrtc_signaling = 1 OR session_close = 1
      )
    )
  `;
  yield* sql`
    INSERT INTO voice_native_control_grants_next (
      token_hash, auth_session_id, session_id, lease_generation, expires_at,
      session_control, handoff_actions, created_at, runtime_id, runtime_generation,
      webrtc_signaling, session_close
    ) SELECT
      token_hash, auth_session_id, session_id, lease_generation, expires_at,
      session_control, handoff_actions, created_at, runtime_id, runtime_generation,
      webrtc_signaling, session_close
    FROM voice_native_control_grants
  `;
  yield* sql`DROP TABLE voice_native_control_grants`;
  yield* sql`ALTER TABLE voice_native_control_grants_next RENAME TO voice_native_control_grants`;
  yield* sql`
    CREATE INDEX idx_voice_native_control_grants_session
    ON voice_native_control_grants(session_id)
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_control_grants_auth
    ON voice_native_control_grants(auth_session_id)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE voice_native_runtime_grants (
      token_hash TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      auth_session_id TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (auth_session_id, runtime_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_runtime_grants_auth
    ON voice_native_runtime_grants(auth_session_id)
  `;
  yield* sql`ALTER TABLE voice_native_control_grants ADD COLUMN runtime_id TEXT`;
  yield* sql`ALTER TABLE voice_native_control_grants ADD COLUMN runtime_generation INTEGER`;
  yield* sql`ALTER TABLE voice_native_control_grants ADD COLUMN webrtc_signaling INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE voice_native_control_grants ADD COLUMN session_close INTEGER NOT NULL DEFAULT 0`;
});

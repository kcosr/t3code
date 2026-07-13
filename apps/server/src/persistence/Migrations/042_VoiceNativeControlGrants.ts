import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE voice_native_control_grants (
      token_hash TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
      expires_at INTEGER NOT NULL,
      session_control INTEGER NOT NULL CHECK (session_control IN (0, 1)),
      handoff_actions INTEGER NOT NULL CHECK (handoff_actions IN (0, 1)),
      created_at INTEGER NOT NULL,
      CHECK (session_control = 1 OR handoff_actions = 1)
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_control_grants_session
    ON voice_native_control_grants(session_id)
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_control_grants_auth
    ON voice_native_control_grants(auth_session_id)
  `;
});

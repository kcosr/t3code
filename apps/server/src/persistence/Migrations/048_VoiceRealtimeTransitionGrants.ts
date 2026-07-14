import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE voice_runtime_realtime_transition_grants (
      operation_key TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      source_control_token_hash TEXT NOT NULL,
      auth_session_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_lease_generation INTEGER NOT NULL CHECK (source_lease_generation > 0),
      action_id TEXT NOT NULL,
      action_sequence INTEGER NOT NULL CHECK (action_sequence > 0),
      runtime_id TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      source_generation INTEGER NOT NULL CHECK (source_generation > 0),
      target_generation INTEGER NOT NULL CHECK (target_generation = source_generation + 1),
      mode_session_id TEXT NOT NULL,
      target_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (source_session_id, source_lease_generation, action_id),
      UNIQUE (auth_session_id, runtime_id, target_generation, mode_session_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_runtime_realtime_transitions_expiry
    ON voice_runtime_realtime_transition_grants(expires_at)
  `;
});

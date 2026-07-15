import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE voice_runtime_refresh_requests`;
  yield* sql`DROP TABLE voice_runtime_grants`;
  yield* sql`DROP TABLE voice_runtime_control_grants`;

  yield* sql`
    CREATE TABLE voice_runtime_authorities (
      auth_session_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      target_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (auth_session_id, runtime_id)
    )
  `;
  yield* sql`CREATE INDEX idx_voice_runtime_authorities_auth
    ON voice_runtime_authorities(auth_session_id)`;

  yield* sql`ALTER TABLE voice_runtime_realtime_transition_grants
    RENAME TO voice_runtime_realtime_transition_grants_legacy`;
  yield* sql`
    CREATE TABLE voice_runtime_realtime_transition_grants (
      source_session_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      next_generation INTEGER NOT NULL CHECK (next_generation > 0),
      auth_session_id TEXT NOT NULL,
      source_lease_generation INTEGER NOT NULL CHECK (source_lease_generation > 0),
      action_sequence INTEGER NOT NULL CHECK (action_sequence > 0),
      runtime_id TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      source_generation INTEGER NOT NULL CHECK (next_generation = source_generation + 1),
      mode_session_id TEXT NOT NULL,
      target_json TEXT NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_session_id, action_id, next_generation),
      UNIQUE (source_session_id, source_lease_generation, action_id),
      UNIQUE (auth_session_id, runtime_id, next_generation, mode_session_id)
    )
  `;
  yield* sql`DROP TABLE voice_runtime_realtime_transition_grants_legacy`;

  yield* sql`ALTER TABLE voice_runtime_realtime_starts
    ADD COLUMN close_only INTEGER NOT NULL DEFAULT 0 CHECK (close_only IN (0, 1))`;
});

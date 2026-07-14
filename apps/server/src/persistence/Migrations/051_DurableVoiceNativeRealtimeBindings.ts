import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Starts created before the full native fence cannot safely authorize a recovered process.
  yield* sql`DELETE FROM voice_native_control_grants
    WHERE session_id IN (
      SELECT session_id FROM voice_native_realtime_starts WHERE session_id IS NOT NULL
    )`;
  yield* sql`DROP TABLE voice_native_realtime_starts`;
  yield* sql`
    CREATE TABLE voice_native_realtime_starts (
      operation_key TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
      mode_session_id TEXT NOT NULL,
      client_operation_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      session_id TEXT UNIQUE,
      lease_generation INTEGER CHECK (lease_generation > 0),
      failure_reason TEXT,
      failure_operation TEXT,
      failure_detail TEXT,
      failure_retryable INTEGER CHECK (failure_retryable IN (0, 1)),
      claim_expires_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (auth_session_id, runtime_id, runtime_generation, client_operation_id),
      CHECK (
        (session_id IS NULL AND lease_generation IS NULL)
        OR (session_id IS NOT NULL AND lease_generation IS NOT NULL)
      )
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_realtime_starts_expiry
    ON voice_native_realtime_starts(expires_at)
  `;
});

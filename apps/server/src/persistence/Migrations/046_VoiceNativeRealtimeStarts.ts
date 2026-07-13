import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE voice_native_realtime_starts (
      operation_key TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
      client_operation_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      session_id TEXT,
      failure_reason TEXT,
      failure_operation TEXT,
      failure_detail TEXT,
      failure_retryable INTEGER CHECK (failure_retryable IN (0, 1)),
      claim_expires_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (auth_session_id, runtime_id, runtime_generation, client_operation_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_realtime_starts_expiry
    ON voice_native_realtime_starts(expires_at)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE voice_native_thread_turn_operations SET
    token_hash = 'revoked:migration-50:' || operation_id,
    detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
    active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
    processing_lease_until = CASE WHEN dispatch_accepted = 0
      THEN NULL ELSE processing_lease_until END,
    processing_lease_token = CASE WHEN dispatch_accepted = 0
      THEN NULL ELSE processing_lease_token END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE EXISTS (
      SELECT 1 FROM voice_native_runtime_grants AS runtime
      WHERE runtime.auth_session_id = voice_native_thread_turn_operations.auth_session_id
        AND runtime.runtime_id = voice_native_thread_turn_operations.runtime_id
    )`;
  yield* sql`DELETE FROM voice_native_realtime_starts WHERE EXISTS (
    SELECT 1 FROM voice_native_runtime_grants AS runtime
    WHERE runtime.auth_session_id = voice_native_realtime_starts.auth_session_id
      AND runtime.runtime_id = voice_native_realtime_starts.runtime_id
  )`;
  yield* sql`DELETE FROM voice_native_control_grants WHERE EXISTS (
    SELECT 1 FROM voice_native_runtime_grants AS runtime
    WHERE runtime.auth_session_id = voice_native_control_grants.auth_session_id
      AND runtime.runtime_id = voice_native_control_grants.runtime_id
  )`;
  yield* sql`DROP TABLE voice_native_runtime_grants`;
  yield* sql`
    CREATE TABLE voice_native_runtime_grants (
      token_hash TEXT PRIMARY KEY,
      provisioning_operation_id TEXT NOT NULL,
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
});

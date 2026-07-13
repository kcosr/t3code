import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE voice_native_thread_turn_operations (
      operation_id TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
      client_operation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      speech_preset TEXT NOT NULL,
      auto_rearm INTEGER NOT NULL CHECK (auto_rearm IN (0, 1)),
      token_hash TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL,
      active_slot INTEGER CHECK (active_slot = 1 OR active_slot IS NULL),
      processing_lease_until INTEGER,
      processing_attempt INTEGER NOT NULL DEFAULT 0,
      command_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
      speech_terminal TEXT,
      dispatch_accepted INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_accepted IN (0, 1)),
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (auth_session_id, runtime_id, runtime_generation, client_operation_id),
      UNIQUE (auth_session_id, runtime_id, runtime_generation, active_slot)
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_thread_turn_operations_expiry
    ON voice_native_thread_turn_operations(expires_at)
  `;
  yield* sql`
    CREATE TABLE voice_native_thread_turn_events (
      operation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, sequence),
      FOREIGN KEY (operation_id) REFERENCES voice_native_thread_turn_operations(operation_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE voice_native_thread_turn_speech_segments (
      operation_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      assistant_message_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
      end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
      final_segment INTEGER NOT NULL CHECK (final_segment IN (0, 1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, segment_index),
      FOREIGN KEY (operation_id) REFERENCES voice_native_thread_turn_operations(operation_id)
        ON DELETE CASCADE
    )
  `;
});

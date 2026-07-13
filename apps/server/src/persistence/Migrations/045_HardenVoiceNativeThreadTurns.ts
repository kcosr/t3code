import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE voice_native_thread_turn_operations
    ADD COLUMN processing_lease_token TEXT
  `;
  yield* sql`
    ALTER TABLE voice_native_thread_turn_speech_segments
    ADD COLUMN source_event_sequence INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE voice_native_thread_turn_speech_segments
    ADD COLUMN source_text_sha256 TEXT NOT NULL DEFAULT ''
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_thread_turn_operations_retention
    ON voice_native_thread_turn_operations(active_slot, expires_at)
  `;
  yield* sql`
    CREATE INDEX idx_orchestration_assistant_message_events
    ON orchestration_events(
      event_type,
      json_extract(payload_json, '$.messageId'),
      sequence
    )
    WHERE event_type = 'thread.message-sent'
      AND json_extract(payload_json, '$.role') = 'assistant'
  `;
});

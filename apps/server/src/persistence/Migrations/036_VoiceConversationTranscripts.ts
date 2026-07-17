import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE voice_conversation_transcript_entries (
      entry_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      context_epoch INTEGER NOT NULL CHECK (context_epoch > 0),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (entry_id)
        REFERENCES voice_conversation_entries(entry_id)
        ON DELETE CASCADE,
      FOREIGN KEY (conversation_id)
        REFERENCES voice_conversations(conversation_id)
        ON DELETE CASCADE,
      UNIQUE (conversation_id, sequence)
    )
  `;

  yield* sql`
    INSERT INTO voice_conversation_transcript_entries (
      entry_id,
      conversation_id,
      context_epoch,
      sequence,
      role,
      text,
      occurred_at
    )
    SELECT
      entry_id,
      conversation_id,
      epoch,
      sequence,
      CASE kind
        WHEN 'transcript.user' THEN 'user'
        ELSE 'assistant'
      END,
      json_extract(payload_json, '$.text'),
      occurred_at
    FROM voice_conversation_entries
    WHERE kind IN ('transcript.user', 'transcript.assistant')
      AND json_valid(payload_json)
      AND json_type(payload_json, '$.text') = 'text'
      AND length(trim(json_extract(payload_json, '$.text'))) > 0
  `;

  yield* sql`
    CREATE INDEX idx_voice_conversation_transcript_sequence
    ON voice_conversation_transcript_entries(conversation_id, sequence DESC)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE voice_conversations (
      conversation_id TEXT PRIMARY KEY,
      retention TEXT NOT NULL CHECK (retention = 'durable'),
      title TEXT,
      active_epoch INTEGER NOT NULL DEFAULT 1 CHECK (active_epoch > 0),
      next_entry_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_entry_sequence > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_voice_conversations_updated
    ON voice_conversations(updated_at DESC, conversation_id ASC)
  `;

  yield* sql`
    CREATE TABLE voice_conversation_entries (
      entry_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id)
        REFERENCES voice_conversations(conversation_id)
        ON DELETE CASCADE,
      UNIQUE (conversation_id, sequence)
    )
  `;

  yield* sql`
    CREATE INDEX idx_voice_conversation_entries_context
    ON voice_conversation_entries(conversation_id, epoch, sequence)
  `;
});

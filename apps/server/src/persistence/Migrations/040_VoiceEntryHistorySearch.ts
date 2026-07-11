import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const searchableVoiceEntries = (prefix: "entries" | "NEW") => {
  const column = (name: string) => `${prefix}.${name}`;
  return {
    text: `CASE ${column("kind")}
      WHEN 'transcript.user' THEN trim(json_extract(${column("payload_json")}, '$.text'))
      WHEN 'transcript.assistant' THEN trim(json_extract(${column("payload_json")}, '$.text'))
      WHEN 'summary' THEN trim(json_extract(${column("payload_json")}, '$.text'))
      WHEN 'tool-result' THEN
        'T3 tool ' || trim(json_extract(${column("payload_json")}, '$.tool')) || ' ' ||
        trim(json_extract(${column("payload_json")}, '$.outcome'))
      WHEN 'context-change' THEN
        'Active T3 context: ' ||
        CASE
          WHEN json_type(${column("payload_json")}, '$.projectId') = 'text'
          THEN 'project ' || trim(json_extract(${column("payload_json")}, '$.projectId'))
          ELSE ''
        END ||
        CASE
          WHEN json_type(${column("payload_json")}, '$.projectId') = 'text'
            AND json_type(${column("payload_json")}, '$.threadId') = 'text'
          THEN ', '
          ELSE ''
        END ||
        CASE
          WHEN json_type(${column("payload_json")}, '$.threadId') = 'text'
          THEN 'thread ' || trim(json_extract(${column("payload_json")}, '$.threadId'))
          ELSE ''
        END
    END`,
    predicate: `${column("kind")} IN (
        'transcript.user',
        'transcript.assistant',
        'summary',
        'tool-result',
        'context-change'
      )
      AND json_valid(${column("payload_json")})
      AND CASE ${column("kind")}
        WHEN 'transcript.user' THEN
          json_type(${column("payload_json")}, '$.text') = 'text'
          AND length(trim(json_extract(${column("payload_json")}, '$.text'))) > 0
        WHEN 'transcript.assistant' THEN
          json_type(${column("payload_json")}, '$.text') = 'text'
          AND length(trim(json_extract(${column("payload_json")}, '$.text'))) > 0
        WHEN 'summary' THEN
          json_type(${column("payload_json")}, '$.version') IN ('integer', 'real')
          AND json_type(${column("payload_json")}, '$.text') = 'text'
          AND length(trim(json_extract(${column("payload_json")}, '$.text'))) > 0
        WHEN 'tool-result' THEN
          json_type(${column("payload_json")}, '$.tool') = 'text'
          AND length(trim(json_extract(${column("payload_json")}, '$.tool'))) > 0
          AND json_type(${column("payload_json")}, '$.outcome') = 'text'
          AND length(trim(json_extract(${column("payload_json")}, '$.outcome'))) > 0
          AND (
            json_type(${column("payload_json")}, '$.result') IS NULL
            OR json_type(${column("payload_json")}, '$.result') = 'text'
          )
        WHEN 'context-change' THEN
          (
            json_type(${column("payload_json")}, '$.projectId') = 'text'
            AND length(trim(json_extract(${column("payload_json")}, '$.projectId'))) > 0
          ) OR (
            json_type(${column("payload_json")}, '$.threadId') = 'text'
            AND length(trim(json_extract(${column("payload_json")}, '$.threadId'))) > 0
          )
        ELSE 0
      END`,
  };
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const entries = searchableVoiceEntries("entries");
  const inserted = searchableVoiceEntries("NEW");

  yield* sql`
    INSERT INTO history_search_index_state (source, generation)
    VALUES ('voice-entry', 1)
  `;

  yield* sql`
    CREATE TABLE history_voice_entry_documents (
      document_id INTEGER PRIMARY KEY,
      entry_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      context_epoch INTEGER NOT NULL CHECK (context_epoch > 0),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      role_or_kind TEXT NOT NULL,
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
    CREATE INDEX idx_history_voice_documents_owner_order
    ON history_voice_entry_documents(conversation_id, context_epoch, sequence, entry_id)
  `;

  yield* sql.unsafe(`
    INSERT INTO history_voice_entry_documents (
      entry_id,
      conversation_id,
      context_epoch,
      sequence,
      role_or_kind,
      text,
      occurred_at
    )
    SELECT
      entries.entry_id,
      entries.conversation_id,
      entries.epoch,
      entries.sequence,
      CASE entries.kind
        WHEN 'transcript.user' THEN 'user'
        WHEN 'transcript.assistant' THEN 'assistant'
        ELSE entries.kind
      END,
      ${entries.text},
      entries.occurred_at
    FROM voice_conversation_entries AS entries
    INNER JOIN voice_conversations AS conversations
      ON conversations.conversation_id = entries.conversation_id
      AND conversations.active_epoch = entries.epoch
    WHERE ${entries.predicate}
  `);

  yield* sql`
    CREATE VIRTUAL TABLE voice_conversation_entries_fts USING fts5(
      text,
      content = 'history_voice_entry_documents',
      content_rowid = 'document_id',
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  yield* sql`
    INSERT INTO voice_conversation_entries_fts (rowid, text)
    SELECT document_id, text
    FROM history_voice_entry_documents
  `;

  yield* sql`
    CREATE TRIGGER history_voice_documents_after_insert
    AFTER INSERT ON history_voice_entry_documents
    BEGIN
      INSERT INTO voice_conversation_entries_fts (rowid, text)
      VALUES (NEW.document_id, NEW.text);
      UPDATE history_search_index_state
      SET generation = generation + 1
      WHERE source = 'voice-entry';
    END
  `;
  yield* sql`
    CREATE TRIGGER history_voice_documents_before_delete
    BEFORE DELETE ON history_voice_entry_documents
    BEGIN
      INSERT INTO voice_conversation_entries_fts (
        voice_conversation_entries_fts,
        rowid,
        text
      ) VALUES ('delete', OLD.document_id, OLD.text);
      UPDATE history_search_index_state
      SET generation = generation + 1
      WHERE source = 'voice-entry';
    END
  `;

  yield* sql.unsafe(`
    CREATE TRIGGER history_voice_entries_after_insert
    AFTER INSERT ON voice_conversation_entries
    WHEN ${inserted.predicate}
    BEGIN
      INSERT INTO history_voice_entry_documents (
        entry_id,
        conversation_id,
        context_epoch,
        sequence,
        role_or_kind,
        text,
        occurred_at
      )
      SELECT
        NEW.entry_id,
        NEW.conversation_id,
        NEW.epoch,
        NEW.sequence,
        CASE NEW.kind
          WHEN 'transcript.user' THEN 'user'
          WHEN 'transcript.assistant' THEN 'assistant'
          ELSE NEW.kind
        END,
        ${inserted.text},
        NEW.occurred_at
      FROM voice_conversations AS conversations
      WHERE conversations.conversation_id = NEW.conversation_id
        AND conversations.active_epoch = NEW.epoch;
    END
  `);

  yield* sql`
    CREATE TRIGGER history_voice_conversations_after_epoch_update
    AFTER UPDATE OF active_epoch ON voice_conversations
    WHEN OLD.active_epoch IS NOT NEW.active_epoch
    BEGIN
      DELETE FROM history_voice_entry_documents
      WHERE conversation_id = NEW.conversation_id
        AND context_epoch <> NEW.active_epoch;
    END
  `;
});

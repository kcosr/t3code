import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE history_search_index_state (
      source TEXT PRIMARY KEY CHECK (source IN ('thread-message', 'voice-entry')),
      generation INTEGER NOT NULL CHECK (generation >= 0)
    )
  `;
  yield* sql`
    INSERT INTO history_search_index_state (source, generation)
    VALUES ('thread-message', 1)
  `;

  yield* sql`
    CREATE TABLE history_thread_message_documents (
      document_id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      text TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (message_id)
        REFERENCES projection_thread_messages(message_id)
        ON DELETE CASCADE,
      FOREIGN KEY (thread_id)
        REFERENCES projection_threads(thread_id)
        ON DELETE CASCADE,
      FOREIGN KEY (project_id)
        REFERENCES projection_projects(project_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_history_thread_documents_owner_order
    ON history_thread_message_documents(thread_id, occurred_at, message_id)
  `;
  yield* sql`
    CREATE INDEX idx_history_thread_documents_project
    ON history_thread_message_documents(project_id, occurred_at, message_id)
  `;

  yield* sql`
    INSERT INTO history_thread_message_documents (
      message_id,
      thread_id,
      project_id,
      role,
      text,
      occurred_at
    )
    SELECT
      messages.message_id,
      messages.thread_id,
      threads.project_id,
      messages.role,
      trim(messages.text),
      messages.created_at
    FROM projection_thread_messages AS messages
    INNER JOIN projection_threads AS threads
      ON threads.thread_id = messages.thread_id
      AND threads.deleted_at IS NULL
    INNER JOIN projection_projects AS projects
      ON projects.project_id = threads.project_id
      AND projects.deleted_at IS NULL
    WHERE messages.is_streaming = 0
      AND messages.role IN ('user', 'assistant', 'system')
      AND length(trim(messages.text)) > 0
  `;

  yield* sql`
    CREATE VIRTUAL TABLE projection_thread_messages_fts USING fts5(
      text,
      content = 'history_thread_message_documents',
      content_rowid = 'document_id',
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages_fts (rowid, text)
    SELECT document_id, text
    FROM history_thread_message_documents
  `;

  yield* sql`
    CREATE TRIGGER history_thread_documents_after_insert
    AFTER INSERT ON history_thread_message_documents
    BEGIN
      INSERT INTO projection_thread_messages_fts (rowid, text)
      VALUES (NEW.document_id, NEW.text);
      UPDATE history_search_index_state
      SET generation = generation + 1
      WHERE source = 'thread-message';
    END
  `;
  yield* sql`
    CREATE TRIGGER history_thread_documents_before_delete
    BEFORE DELETE ON history_thread_message_documents
    BEGIN
      INSERT INTO projection_thread_messages_fts (
        projection_thread_messages_fts,
        rowid,
        text
      ) VALUES ('delete', OLD.document_id, OLD.text);
      UPDATE history_search_index_state
      SET generation = generation + 1
      WHERE source = 'thread-message';
    END
  `;
  yield* sql`
    CREATE TRIGGER history_thread_documents_before_update
    BEFORE UPDATE OF text ON history_thread_message_documents
    WHEN OLD.text IS NOT NEW.text
    BEGIN
      INSERT INTO projection_thread_messages_fts (
        projection_thread_messages_fts,
        rowid,
        text
      ) VALUES ('delete', OLD.document_id, OLD.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER history_thread_documents_after_update
    AFTER UPDATE OF text ON history_thread_message_documents
    WHEN OLD.text IS NOT NEW.text
    BEGIN
      INSERT INTO projection_thread_messages_fts (rowid, text)
      VALUES (NEW.document_id, NEW.text);
      UPDATE history_search_index_state
      SET generation = generation + 1
      WHERE source = 'thread-message';
    END
  `;

  yield* sql`
    CREATE TRIGGER history_thread_messages_after_insert
    AFTER INSERT ON projection_thread_messages
    WHEN NEW.is_streaming = 0
      AND NEW.role IN ('user', 'assistant', 'system')
      AND length(trim(NEW.text)) > 0
    BEGIN
      INSERT INTO history_thread_message_documents (
        message_id,
        thread_id,
        project_id,
        role,
        text,
        occurred_at
      )
      SELECT
        NEW.message_id,
        NEW.thread_id,
        threads.project_id,
        NEW.role,
        trim(NEW.text),
        NEW.created_at
      FROM projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.thread_id = NEW.thread_id
        AND threads.deleted_at IS NULL
        AND projects.deleted_at IS NULL;
    END
  `;
  yield* sql`
    CREATE TRIGGER history_thread_messages_after_update
    AFTER UPDATE OF thread_id, role, text, is_streaming, created_at
    ON projection_thread_messages
    WHEN OLD.thread_id IS NOT NEW.thread_id
      OR OLD.role IS NOT NEW.role
      OR OLD.text IS NOT NEW.text
      OR OLD.is_streaming IS NOT NEW.is_streaming
      OR OLD.created_at IS NOT NEW.created_at
    BEGIN
      DELETE FROM history_thread_message_documents
      WHERE message_id = OLD.message_id;
      INSERT INTO history_thread_message_documents (
        message_id,
        thread_id,
        project_id,
        role,
        text,
        occurred_at
      )
      SELECT
        NEW.message_id,
        NEW.thread_id,
        threads.project_id,
        NEW.role,
        trim(NEW.text),
        NEW.created_at
      FROM projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.thread_id = NEW.thread_id
        AND threads.deleted_at IS NULL
        AND projects.deleted_at IS NULL
        AND NEW.is_streaming = 0
        AND NEW.role IN ('user', 'assistant', 'system')
        AND length(trim(NEW.text)) > 0;
    END
  `;

  yield* sql`
    CREATE TRIGGER history_threads_after_visibility_update
    AFTER UPDATE OF project_id, deleted_at ON projection_threads
    WHEN OLD.project_id IS NOT NEW.project_id
      OR OLD.deleted_at IS NOT NEW.deleted_at
    BEGIN
      DELETE FROM history_thread_message_documents
      WHERE thread_id = NEW.thread_id;
      INSERT INTO history_thread_message_documents (
        message_id,
        thread_id,
        project_id,
        role,
        text,
        occurred_at
      )
      SELECT
        messages.message_id,
        messages.thread_id,
        NEW.project_id,
        messages.role,
        trim(messages.text),
        messages.created_at
      FROM projection_thread_messages AS messages
      INNER JOIN projection_projects AS projects
        ON projects.project_id = NEW.project_id
      WHERE messages.thread_id = NEW.thread_id
        AND NEW.deleted_at IS NULL
        AND projects.deleted_at IS NULL
        AND messages.is_streaming = 0
        AND messages.role IN ('user', 'assistant', 'system')
        AND length(trim(messages.text)) > 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER history_projects_after_visibility_update
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN OLD.deleted_at IS NOT NEW.deleted_at
    BEGIN
      DELETE FROM history_thread_message_documents
      WHERE project_id = NEW.project_id;
      INSERT INTO history_thread_message_documents (
        message_id,
        thread_id,
        project_id,
        role,
        text,
        occurred_at
      )
      SELECT
        messages.message_id,
        messages.thread_id,
        threads.project_id,
        messages.role,
        trim(messages.text),
        messages.created_at
      FROM projection_thread_messages AS messages
      INNER JOIN projection_threads AS threads
        ON threads.thread_id = messages.thread_id
      WHERE threads.project_id = NEW.project_id
        AND NEW.deleted_at IS NULL
        AND threads.deleted_at IS NULL
        AND messages.is_streaming = 0
        AND messages.role IN ('user', 'assistant', 'system')
        AND length(trim(messages.text)) > 0;
    END
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const RECEIPT_RETENTION_MILLIS = 30 * 24 * 60 * 60 * 1_000;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TEMP TABLE voice_native_thread_turn_events_migration AS
    SELECT * FROM voice_native_thread_turn_events`;
  yield* sql`CREATE TEMP TABLE voice_native_thread_turn_speech_segments_migration AS
    SELECT * FROM voice_native_thread_turn_speech_segments`;

  yield* sql`
    CREATE TABLE voice_native_thread_turn_operations_next (
      operation_id TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
      mode_session_id TEXT NOT NULL,
      turn_client_operation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      speech_preset TEXT NOT NULL,
      auto_rearm INTEGER NOT NULL CHECK (auto_rearm IN (0, 1)),
      submission_policy TEXT NOT NULL CHECK (submission_policy IN ('auto-submit', 'draft')),
      speech_plan_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL,
      active_slot INTEGER CHECK (active_slot = 1 OR active_slot IS NULL),
      processing_lease_until INTEGER,
      processing_lease_token TEXT,
      processing_attempt INTEGER NOT NULL DEFAULT 0,
      command_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
      speech_terminal TEXT,
      highest_started_segment INTEGER CHECK (highest_started_segment IS NULL OR highest_started_segment >= 0),
      highest_drained_segment INTEGER CHECK (highest_drained_segment IS NULL OR highest_drained_segment >= 0),
      dispatch_accepted INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_accepted IN (0, 1)),
      detached_at TEXT,
      operation_token_expires_at INTEGER NOT NULL,
      retention_expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (
        auth_session_id,
        runtime_id,
        runtime_generation,
        mode_session_id,
        turn_client_operation_id
      ),
      UNIQUE (auth_session_id, runtime_id, runtime_generation, active_slot)
    )
  `;
  yield* sql`
    INSERT INTO voice_native_thread_turn_operations_next (
      operation_id, auth_session_id, runtime_id, runtime_instance_id, runtime_generation, mode_session_id,
      turn_client_operation_id, project_id, thread_id, speech_preset, auto_rearm,
      submission_policy, speech_plan_id, token_hash, phase, active_slot,
      processing_lease_until, processing_lease_token, processing_attempt, command_id,
      message_id, turn_id, last_sequence, acknowledged_sequence, speech_terminal,
      highest_started_segment, highest_drained_segment,
      dispatch_accepted, detached_at, operation_token_expires_at, retention_expires_at,
      created_at, updated_at
    )
    SELECT
      operation_id, auth_session_id, runtime_id, 'legacy-instance:' || runtime_id, runtime_generation,
      'voice-mode:' || operation_id, client_operation_id, project_id, thread_id,
      speech_preset, auto_rearm, 'auto-submit', 'voice-speech-plan:' || operation_id,
      token_hash, phase, active_slot, processing_lease_until, processing_lease_token,
      processing_attempt, command_id, message_id, turn_id, last_sequence,
      acknowledged_sequence, speech_terminal, NULL, NULL, dispatch_accepted, NULL, expires_at,
      expires_at + ${RECEIPT_RETENTION_MILLIS}, created_at, updated_at
    FROM voice_native_thread_turn_operations
  `;

  yield* sql`DROP TABLE voice_native_thread_turn_operations`;
  yield* sql`ALTER TABLE voice_native_thread_turn_operations_next
    RENAME TO voice_native_thread_turn_operations`;
  yield* sql`INSERT INTO voice_native_thread_turn_events
    SELECT * FROM voice_native_thread_turn_events_migration`;
  yield* sql`INSERT INTO voice_native_thread_turn_speech_segments
    SELECT * FROM voice_native_thread_turn_speech_segments_migration`;
  yield* sql`DROP TABLE voice_native_thread_turn_events_migration`;
  yield* sql`DROP TABLE voice_native_thread_turn_speech_segments_migration`;
  yield* sql`
    CREATE INDEX idx_voice_native_thread_turn_operations_token_expiry
    ON voice_native_thread_turn_operations(operation_token_expires_at)
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_thread_turn_operations_retention
    ON voice_native_thread_turn_operations(active_slot, retention_expires_at)
  `;

  yield* sql`
    CREATE TABLE voice_native_thread_turn_assistant_messages (
      operation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      first_seen_sequence INTEGER NOT NULL CHECK (first_seen_sequence > 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, message_id),
      UNIQUE (operation_id, first_seen_sequence, message_id),
      FOREIGN KEY (operation_id) REFERENCES voice_native_thread_turn_operations(operation_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_thread_turn_assistant_message_order
    ON voice_native_thread_turn_assistant_messages(
      operation_id,
      first_seen_sequence,
      message_id
    )
  `;

  yield* sql`
    CREATE TABLE voice_native_thread_turn_speech_dispositions (
      operation_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      disposition TEXT NOT NULL CHECK (disposition IN ('drained', 'interrupted', 'skipped', 'failed')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, segment_index),
      FOREIGN KEY (operation_id) REFERENCES voice_native_thread_turn_operations(operation_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE voice_native_thread_turn_drafts (
      operation_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('ready', 'consumed', 'expired')),
      cipher_version INTEGER NOT NULL CHECK (cipher_version > 0),
      nonce BLOB,
      ciphertext BLOB,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      CHECK (
        (state = 'ready' AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND consumed_at IS NULL)
        OR
        (state IN ('consumed', 'expired') AND nonce IS NULL AND ciphertext IS NULL)
      ),
      FOREIGN KEY (operation_id) REFERENCES voice_native_thread_turn_operations(operation_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_voice_native_thread_turn_drafts_expiry
    ON voice_native_thread_turn_drafts(state, expires_at)
  `;

  yield* sql`
    CREATE TRIGGER voice_native_thread_turn_draft_policy_guard
    BEFORE INSERT ON voice_native_thread_turn_drafts
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM voice_native_thread_turn_operations
        WHERE operation_id = NEW.operation_id
          AND submission_policy = 'draft'
          AND dispatch_accepted = 0
      ) THEN RAISE(ABORT, 'draft operation cannot dispatch') END;
    END
  `;
  yield* sql`
    CREATE TRIGGER voice_native_thread_turn_dispatch_policy_guard
    BEFORE UPDATE OF dispatch_accepted ON voice_native_thread_turn_operations
    WHEN NEW.dispatch_accepted = 1
    BEGIN
      SELECT CASE WHEN NEW.submission_policy != 'auto-submit' OR EXISTS (
        SELECT 1 FROM voice_native_thread_turn_drafts
        WHERE operation_id = NEW.operation_id
      ) THEN RAISE(ABORT, 'dispatch operation cannot contain a draft') END;
    END
  `;
});

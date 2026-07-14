import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE voice_runtime_generation_fences (
      auth_session_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      maximum_generation INTEGER NOT NULL CHECK (maximum_generation > 0),
      PRIMARY KEY (auth_session_id, runtime_id)
    )
  `;
  yield* sql`INSERT INTO voice_runtime_generation_fences (
      auth_session_id, runtime_id, maximum_generation
    ) SELECT auth_session_id, runtime_id, MAX(generation)
      FROM voice_native_runtime_grants GROUP BY auth_session_id, runtime_id`;

  // The protocol major changes every authority and cursor fence. Preserve accepted
  // orchestration work, but detach its local media owner and cancel unaccepted work.
  yield* sql`UPDATE voice_native_thread_turn_operations SET
    token_hash = 'revoked:protocol-1:' || operation_id,
    detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
    active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
    processing_lease_until = CASE WHEN dispatch_accepted = 0
      THEN NULL ELSE processing_lease_until END,
    processing_lease_token = CASE WHEN dispatch_accepted = 0
      THEN NULL ELSE processing_lease_token END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE runtime_id IN (SELECT runtime_id FROM voice_native_runtime_grants)`;
  yield* sql`DELETE FROM voice_native_control_grants`;
  yield* sql`DELETE FROM voice_native_realtime_starts`;
  yield* sql`DELETE FROM voice_runtime_realtime_transition_grants`;
  yield* sql`DROP TABLE voice_native_runtime_grants`;

  yield* sql`DROP TRIGGER voice_native_thread_turn_draft_policy_guard`;
  yield* sql`DROP TRIGGER voice_native_thread_turn_dispatch_policy_guard`;
  yield* sql`DROP INDEX idx_voice_native_thread_turn_operations_token_expiry`;
  yield* sql`DROP INDEX idx_voice_native_thread_turn_operations_retention`;
  yield* sql`DROP INDEX idx_voice_native_thread_turn_assistant_message_order`;
  yield* sql`DROP INDEX idx_voice_native_thread_turn_drafts_expiry`;
  yield* sql`DROP INDEX idx_voice_native_realtime_starts_expiry`;
  yield* sql`DROP INDEX idx_voice_native_control_grants_session`;
  yield* sql`DROP INDEX idx_voice_native_control_grants_auth`;

  yield* sql`ALTER TABLE voice_native_thread_turn_operations
    RENAME TO voice_thread_turn_operations`;
  yield* sql`ALTER TABLE voice_native_thread_turn_events
    RENAME TO voice_thread_turn_events`;
  yield* sql`ALTER TABLE voice_native_thread_turn_speech_segments
    RENAME TO voice_thread_turn_speech_segments`;
  yield* sql`ALTER TABLE voice_native_thread_turn_assistant_messages
    RENAME TO voice_thread_turn_assistant_messages`;
  yield* sql`ALTER TABLE voice_native_thread_turn_speech_dispositions
    RENAME TO voice_thread_turn_speech_dispositions`;
  yield* sql`ALTER TABLE voice_native_thread_turn_drafts
    RENAME TO voice_thread_turn_drafts`;
  yield* sql`ALTER TABLE voice_native_realtime_starts
    RENAME TO voice_runtime_realtime_starts`;
  yield* sql`ALTER TABLE voice_native_control_grants
    RENAME TO voice_runtime_control_grants`;

  yield* sql`CREATE INDEX idx_voice_thread_turn_operations_token_expiry
    ON voice_thread_turn_operations(operation_token_expires_at)`;
  yield* sql`CREATE INDEX idx_voice_thread_turn_operations_retention
    ON voice_thread_turn_operations(active_slot, retention_expires_at)`;
  yield* sql`CREATE INDEX idx_voice_thread_turn_assistant_message_order
    ON voice_thread_turn_assistant_messages(operation_id, first_seen_sequence, message_id)`;
  yield* sql`CREATE INDEX idx_voice_thread_turn_drafts_expiry
    ON voice_thread_turn_drafts(state, expires_at)`;
  yield* sql`CREATE INDEX idx_voice_runtime_realtime_starts_expiry
    ON voice_runtime_realtime_starts(expires_at)`;
  yield* sql`CREATE INDEX idx_voice_runtime_control_grants_session
    ON voice_runtime_control_grants(session_id)`;
  yield* sql`CREATE INDEX idx_voice_runtime_control_grants_auth
    ON voice_runtime_control_grants(auth_session_id)`;

  yield* sql`
    CREATE TRIGGER voice_thread_turn_draft_policy_guard
    BEFORE INSERT ON voice_thread_turn_drafts
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM voice_thread_turn_operations
        WHERE operation_id = NEW.operation_id
          AND submission_policy = 'draft'
          AND dispatch_accepted = 0
      ) THEN RAISE(ABORT, 'draft operation cannot dispatch') END;
    END
  `;
  yield* sql`
    CREATE TRIGGER voice_thread_turn_dispatch_policy_guard
    BEFORE UPDATE OF dispatch_accepted ON voice_thread_turn_operations
    WHEN NEW.dispatch_accepted = 1
    BEGIN
      SELECT CASE WHEN NEW.submission_policy != 'auto-submit' OR EXISTS (
        SELECT 1 FROM voice_thread_turn_drafts
        WHERE operation_id = NEW.operation_id
      ) THEN RAISE(ABORT, 'dispatch operation cannot contain a draft') END;
    END
  `;

  yield* sql`
    CREATE TABLE voice_runtime_grants (
      token_hash TEXT PRIMARY KEY,
      provisioning_operation_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      auth_session_id TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      target_digest TEXT NOT NULL CHECK (
        length(target_digest) = 64 AND target_digest NOT GLOB '*[^a-f0-9]*'
      ),
      operation TEXT NOT NULL CHECK (operation IN ('realtime-start', 'thread-turn-start')),
      readiness_enabled INTEGER NOT NULL CHECK (readiness_enabled IN (0, 1)),
      refresh_current_hash TEXT,
      refresh_previous_hash TEXT,
      refresh_rotation_counter INTEGER NOT NULL DEFAULT 0 CHECK (refresh_rotation_counter >= 0),
      refresh_previous_confirm_until INTEGER,
      refresh_previous_request_id TEXT,
      refresh_previous_candidate_hash TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (auth_session_id, runtime_id),
      CHECK (
        (readiness_enabled = 1 AND refresh_current_hash IS NOT NULL)
        OR (readiness_enabled = 0 AND refresh_current_hash IS NULL)
      ),
      CHECK (
        (refresh_previous_hash IS NULL AND refresh_previous_confirm_until IS NULL
          AND refresh_previous_request_id IS NULL AND refresh_previous_candidate_hash IS NULL)
        OR (refresh_previous_hash IS NOT NULL AND refresh_previous_confirm_until IS NOT NULL
          AND refresh_previous_request_id IS NOT NULL
          AND refresh_previous_candidate_hash IS NOT NULL)
      )
    )
  `;
  yield* sql`CREATE INDEX idx_voice_runtime_grants_auth
    ON voice_runtime_grants(auth_session_id)`;
  yield* sql`CREATE UNIQUE INDEX idx_voice_runtime_refresh_current
    ON voice_runtime_grants(refresh_current_hash) WHERE refresh_current_hash IS NOT NULL`;
  yield* sql`CREATE UNIQUE INDEX idx_voice_runtime_refresh_previous
    ON voice_runtime_grants(refresh_previous_hash) WHERE refresh_previous_hash IS NOT NULL`;

  yield* sql`
    CREATE TABLE voice_runtime_refresh_requests (
      auth_session_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      refresh_request_id TEXT NOT NULL,
      provisioning_operation_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      operation TEXT NOT NULL CHECK (operation IN ('realtime-start', 'thread-turn-start')),
      target_digest TEXT NOT NULL,
      expected_rotation_counter INTEGER NOT NULL CHECK (expected_rotation_counter >= 0),
      candidate_credential_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (auth_session_id, runtime_id, refresh_request_id)
    )
  `;
});

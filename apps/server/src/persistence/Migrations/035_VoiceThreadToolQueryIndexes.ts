import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX idx_projection_thread_messages_completed_page
    ON projection_thread_messages(thread_id, is_streaming, created_at, message_id)
  `;

  yield* sql`
    CREATE TABLE projection_turn_starts (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'submitting', 'accepted', 'failed', 'ambiguous')),
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (thread_id, message_id),
      CHECK (
        (state = 'accepted' AND turn_id IS NOT NULL AND resolved_at IS NOT NULL)
        OR (state = 'failed' AND turn_id IS NULL AND resolved_at IS NOT NULL)
        OR (state = 'pending' AND turn_id IS NULL AND resolved_at IS NULL)
        OR (state = 'submitting' AND turn_id IS NULL AND resolved_at IS NULL)
        OR (state = 'ambiguous' AND turn_id IS NULL AND resolved_at IS NOT NULL)
      ),
      CHECK (
        (source_proposed_plan_thread_id IS NULL AND source_proposed_plan_id IS NULL)
        OR (source_proposed_plan_thread_id IS NOT NULL AND source_proposed_plan_id IS NOT NULL)
      )
    )
  `;

  yield* sql`
    INSERT INTO projection_turn_starts (
      thread_id, message_id, turn_id, state,
      source_proposed_plan_thread_id, source_proposed_plan_id,
      requested_at, resolved_at
    )
    SELECT
      thread_id,
      pending_message_id,
      turn_id,
      CASE WHEN turn_id IS NULL THEN 'pending' ELSE 'accepted' END,
      CASE
        WHEN source_proposed_plan_thread_id IS NOT NULL AND source_proposed_plan_id IS NOT NULL
          THEN source_proposed_plan_thread_id
        ELSE NULL
      END,
      CASE
        WHEN source_proposed_plan_thread_id IS NOT NULL AND source_proposed_plan_id IS NOT NULL
          THEN source_proposed_plan_id
        ELSE NULL
      END,
      requested_at,
      CASE WHEN turn_id IS NULL THEN NULL ELSE COALESCE(started_at, requested_at) END
    FROM projection_turns
    WHERE pending_message_id IS NOT NULL
    ON CONFLICT (thread_id, message_id) DO UPDATE SET
      turn_id = COALESCE(excluded.turn_id, projection_turn_starts.turn_id),
      state = CASE
        WHEN excluded.turn_id IS NOT NULL THEN 'accepted'
        ELSE projection_turn_starts.state
      END,
      source_proposed_plan_thread_id = COALESCE(
        excluded.source_proposed_plan_thread_id,
        projection_turn_starts.source_proposed_plan_thread_id
      ),
      source_proposed_plan_id = COALESCE(
        excluded.source_proposed_plan_id,
        projection_turn_starts.source_proposed_plan_id
      ),
      requested_at = MIN(excluded.requested_at, projection_turn_starts.requested_at),
      resolved_at = COALESCE(excluded.resolved_at, projection_turn_starts.resolved_at)
  `;

  yield* sql`
    CREATE TABLE projection_turns_next (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      assistant_message_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('running', 'interrupted', 'completed', 'error')),
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL,
      UNIQUE (thread_id, turn_id),
      UNIQUE (thread_id, checkpoint_turn_count)
    )
  `;

  yield* sql`
    INSERT INTO projection_turns_next (
      thread_id, turn_id, assistant_message_id, state,
      requested_at, started_at, completed_at,
      checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json
    )
    SELECT
      thread_id, turn_id, assistant_message_id, state,
      requested_at, started_at, completed_at,
      checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json
    FROM projection_turns
    WHERE turn_id IS NOT NULL
  `;

  yield* sql`DROP TABLE projection_turns`;
  yield* sql`ALTER TABLE projection_turns_next RENAME TO projection_turns`;

  yield* sql`
    CREATE INDEX idx_projection_turns_thread_requested
    ON projection_turns(thread_id, requested_at)
  `;

  yield* sql`
    CREATE INDEX idx_projection_turns_thread_checkpoint_completed
    ON projection_turns(thread_id, checkpoint_turn_count, completed_at)
  `;

  yield* sql`
    CREATE INDEX idx_projection_turn_starts_turn
    ON projection_turn_starts(thread_id, turn_id)
    WHERE turn_id IS NOT NULL
  `;
});

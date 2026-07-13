import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE voice_handoff_actions (
      action_id TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      realtime_session_id TEXT NOT NULL,
      realtime_generation INTEGER NOT NULL CHECK (realtime_generation > 0),
      conversation_id TEXT NOT NULL,
      context_epoch INTEGER NOT NULL CHECK (context_epoch > 0),
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      auto_rearm INTEGER NOT NULL CHECK (auto_rearm IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('prepared', 'pending', 'settled', 'expired')),
      outcome TEXT CHECK (outcome IN ('succeeded', 'failed')),
      outcome_state TEXT,
      outcome_stage TEXT,
      outcome_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      settled_at TEXT,
      FOREIGN KEY (conversation_id)
        REFERENCES voice_conversations(conversation_id)
        ON DELETE CASCADE,
      CHECK (
        (status IN ('prepared', 'pending')
          AND outcome IS NULL
          AND outcome_state IS NULL
          AND outcome_stage IS NULL
          AND outcome_reason IS NULL
          AND settled_at IS NULL)
        OR
        (status IN ('settled', 'expired')
          AND outcome IS NOT NULL
          AND settled_at IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX idx_voice_handoff_actions_owner_pending
    ON voice_handoff_actions(auth_session_id, status, expires_at, created_at)
  `;

  yield* sql`
    CREATE INDEX idx_voice_handoff_actions_session
    ON voice_handoff_actions(realtime_session_id, realtime_generation)
  `;
});

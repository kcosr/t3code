import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`ALTER TABLE voice_tool_calls RENAME TO voice_tool_calls_legacy`;

      yield* sql`
        CREATE TABLE voice_tool_calls (
          conversation_id TEXT NOT NULL,
          context_epoch INTEGER NOT NULL CHECK (context_epoch > 0),
          tool_call_id TEXT NOT NULL,
          provider_function_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          canonical_arguments_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('requested', 'pending-confirmation', 'succeeded', 'failed', 'rejected', 'expired')
          ),
          session_id TEXT NOT NULL,
          confirmation_id TEXT,
          summary TEXT,
          command_id TEXT,
          command_json TEXT,
          result_output TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          PRIMARY KEY (conversation_id, tool_call_id),
          UNIQUE (confirmation_id),
          FOREIGN KEY (conversation_id)
            REFERENCES voice_conversations(conversation_id)
            ON DELETE CASCADE,
          CHECK (
            (status = 'pending-confirmation'
              AND confirmation_id IS NOT NULL
              AND summary IS NOT NULL
              AND command_id IS NOT NULL
              AND command_json IS NOT NULL
              AND expires_at IS NOT NULL)
            OR status <> 'pending-confirmation'
          ),
          CHECK (
            (status IN ('succeeded', 'failed', 'rejected', 'expired') AND result_output IS NOT NULL)
            OR status IN ('requested', 'pending-confirmation')
          )
        )
      `;

      yield* sql`
        INSERT INTO voice_tool_calls (
          conversation_id,
          context_epoch,
          tool_call_id,
          provider_function_call_id,
          tool_name,
          canonical_arguments_json,
          status,
          session_id,
          confirmation_id,
          summary,
          command_id,
          command_json,
          result_output,
          created_at,
          updated_at,
          expires_at
        )
        SELECT
          calls.conversation_id,
          COALESCE(
            (
              SELECT entries.epoch
              FROM voice_conversation_entries AS entries
              WHERE entries.entry_id =
                'voice-tool:' || calls.conversation_id || ':' || calls.tool_call_id || ':requested'
              LIMIT 1
            ),
            conversations.active_epoch
          ),
          calls.tool_call_id,
          calls.provider_function_call_id,
          calls.tool_name,
          calls.canonical_arguments_json,
          CASE
            WHEN calls.status IN ('requested', 'pending-confirmation') THEN 'failed'
            ELSE calls.status
          END,
          calls.session_id,
          calls.confirmation_id,
          calls.summary,
          calls.command_id,
          calls.command_json,
          CASE
            WHEN calls.status IN ('requested', 'pending-confirmation')
              THEN '{"error":"Voice session ended during server upgrade"}'
            ELSE calls.result_output
          END,
          calls.created_at,
          calls.updated_at,
          calls.expires_at
        FROM voice_tool_calls_legacy AS calls
        JOIN voice_conversations AS conversations
          ON conversations.conversation_id = calls.conversation_id
      `;

      yield* sql`DROP TABLE voice_tool_calls_legacy`;
      yield* sql`
        CREATE INDEX idx_voice_tool_calls_status
        ON voice_tool_calls(status, updated_at)
      `;
    }),
  );
});

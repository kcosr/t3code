import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE voice_tool_calls (
      conversation_id TEXT NOT NULL,
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
    CREATE INDEX idx_voice_tool_calls_status
    ON voice_tool_calls(status, updated_at)
  `;
});

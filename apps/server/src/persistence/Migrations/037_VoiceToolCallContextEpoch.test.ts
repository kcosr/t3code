import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration037 from "./037_VoiceToolCallContextEpoch.ts";

it.effect("backfills tool-call epochs and terminalizes legacy nonterminal calls", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 36 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO voice_conversations (
        conversation_id, retention, title, active_epoch, next_entry_sequence, created_at, updated_at
      ) VALUES ('conversation-037', 'durable', NULL, 3, 2, '2026-07-11', '2026-07-11')
    `;
    yield* sql`
      INSERT INTO voice_conversation_entries (
        entry_id, conversation_id, epoch, sequence, kind, payload_json, occurred_at
      ) VALUES (
        'voice-tool:conversation-037:call-attributed:requested',
        'conversation-037', 2, 1, 'tool-request', '{}', '2026-07-11'
      )
    `;
    yield* sql`
      INSERT INTO voice_tool_calls (
        conversation_id, tool_call_id, provider_function_call_id, tool_name,
        canonical_arguments_json, status, session_id, result_output, created_at, updated_at
      ) VALUES
        ('conversation-037', 'call-attributed', 'provider-1', 'list_threads', '{}',
          'requested', 'session-old', NULL, '2026-07-11', '2026-07-11'),
        ('conversation-037', 'call-terminal', 'provider-2', 'list_threads', '{}',
          'succeeded', 'session-old', '{}', '2026-07-11', '2026-07-11')
    `;

    yield* Migration037;

    const rows = yield* sql<{
      readonly tool_call_id: string;
      readonly context_epoch: number;
      readonly status: string;
      readonly result_output: string | null;
    }>`
      SELECT tool_call_id, context_epoch, status, result_output
      FROM voice_tool_calls
      ORDER BY tool_call_id
    `;
    assert.deepEqual(rows, [
      {
        tool_call_id: "call-attributed",
        context_epoch: 2,
        status: "failed",
        result_output: '{"error":"Voice session ended during server upgrade"}',
      },
      {
        tool_call_id: "call-terminal",
        context_epoch: 3,
        status: "succeeded",
        result_output: "{}",
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

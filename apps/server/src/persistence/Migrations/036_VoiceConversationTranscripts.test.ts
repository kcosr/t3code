import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_VoiceConversationTranscripts", (it) => {
  it.effect("backfills only sanitized transcripts and creates the paging index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        INSERT INTO voice_conversations (
          conversation_id, retention, title, active_epoch,
          next_entry_sequence, created_at, updated_at
        ) VALUES (
          'conversation-migrate', 'durable', NULL, 1,
          5, '2026-07-11T08:00:00.000Z', '2026-07-11T08:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO voice_conversation_entries (
          entry_id, conversation_id, epoch, sequence, kind, payload_json, occurred_at
        ) VALUES
          ('entry-user', 'conversation-migrate', 1, 1, 'transcript.user',
            '{"text":"hello","providerCallId":"private"}', '2026-07-11T08:00:01.000Z'),
          ('entry-tool', 'conversation-migrate', 1, 2, 'tool-request',
            '{"argumentsJson":"private"}', '2026-07-11T08:00:02.000Z'),
          ('entry-invalid', 'conversation-migrate', 1, 3, 'transcript.assistant',
            '{"text":42}', '2026-07-11T08:00:03.000Z'),
          ('entry-assistant', 'conversation-migrate', 1, 4, 'transcript.assistant',
            '{"text":"hi"}', '2026-07-11T08:00:04.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{
        readonly entryId: string;
        readonly role: string;
        readonly text: string;
      }>`
        SELECT entry_id AS "entryId", role, text
        FROM voice_conversation_transcript_entries
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(rows, [
        { entryId: "entry-user", role: "user", text: "hello" },
        { entryId: "entry-assistant", role: "assistant", text: "hi" },
      ]);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT entry_id
        FROM voice_conversation_transcript_entries
        WHERE conversation_id = 'conversation-migrate' AND sequence < 5
        ORDER BY sequence DESC
        LIMIT 20
      `;
      assert.isTrue(
        plan.some(({ detail }) => detail.includes("idx_voice_conversation_transcript_sequence")),
      );
      assert.isFalse(plan.some(({ detail }) => detail.includes("USE TEMP B-TREE")));

      const listPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT conversation_id
        FROM voice_conversations
        ORDER BY updated_at DESC, conversation_id ASC
        LIMIT 20
      `;
      assert.isTrue(
        listPlan.some(({ detail }) => detail.includes("idx_voice_conversations_updated")),
      );
      assert.isFalse(listPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")));
    }),
  );
});

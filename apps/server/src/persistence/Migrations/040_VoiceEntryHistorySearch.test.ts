import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_VoiceEntryHistorySearch", (it) => {
  it.effect("sanitizes backfill and fences Clear Context and hard delete", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* sql`
        INSERT INTO voice_conversations (
          conversation_id, retention, title, active_epoch, next_entry_sequence,
          created_at, updated_at, last_call_at
        ) VALUES (
          'conversation-history', 'durable', 'Voice history', 1, 7,
          '2026-07-11T09:00:00.000Z', '2026-07-11T09:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO voice_conversation_entries (
          entry_id, conversation_id, epoch, sequence, kind, payload_json, occurred_at
        ) VALUES
          ('entry-user', 'conversation-history', 1, 1, 'transcript.user',
            '{"text":"voice alpha","providerCallId":"private"}', '2026-07-11T09:01:00.000Z'),
          ('entry-summary', 'conversation-history', 1, 2, 'summary',
            '{"version":1,"text":"safe summary","secret":"private"}', '2026-07-11T09:02:00.000Z'),
          ('entry-tool-result', 'conversation-history', 1, 3, 'tool-result',
            '{"tool":"list_threads","outcome":"completed","result":"three threads","argumentsJson":"private"}',
            '2026-07-11T09:03:00.000Z'),
          ('entry-context', 'conversation-history', 1, 4, 'context-change',
            '{"projectId":"project-one","threadId":"thread-one"}', '2026-07-11T09:04:00.000Z'),
          ('entry-tool-request', 'conversation-history', 1, 5, 'tool-request',
            '{"argumentsJson":"private request"}', '2026-07-11T09:05:00.000Z'),
          ('entry-invalid', 'conversation-history', 1, 6, 'transcript.assistant',
            '{"text":42}', '2026-07-11T09:06:00.000Z')
      `;
      yield* sql`
        INSERT INTO voice_conversation_transcript_entries (
          entry_id, conversation_id, context_epoch, sequence, role, text, occurred_at
        ) VALUES (
          'entry-user', 'conversation-history', 1, 1, 'user', 'voice alpha',
          '2026-07-11T09:01:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 40 });
      const documents = yield* sql<{ readonly id: string; readonly text: string }>`
        SELECT entry_id AS id, text
        FROM history_voice_entry_documents
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(documents, [
        { id: "entry-user", text: "voice alpha" },
        { id: "entry-summary", text: "safe summary" },
        { id: "entry-tool-result", text: "T3 tool list_threads completed" },
        { id: "entry-context", text: "Active T3 context: project project-one, thread thread-one" },
      ]);
      assert.notInclude(
        documents.map((document) => `${document.id}:${document.text}`).join("\n"),
        "private",
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
            SELECT count(*) AS count
            FROM voice_conversation_entries_fts
            WHERE voice_conversation_entries_fts MATCH 'three'
          `)[0]!.count,
        0,
      );

      const generation = (yield* sql<{ readonly generation: number }>`
          SELECT generation FROM history_search_index_state WHERE source = 'voice-entry'
        `)[0]!.generation;
      yield* sql`
        UPDATE voice_conversations
        SET active_epoch = 2, next_entry_sequence = 8
        WHERE conversation_id = 'conversation-history'
      `;
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM history_voice_entry_documents`)[0]!.count,
        0,
      );
      assert.isAbove(
        (yield* sql<{ readonly generation: number }>`
            SELECT generation FROM history_search_index_state WHERE source = 'voice-entry'
          `)[0]!.generation,
        generation,
      );
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM voice_conversation_entries`)[0]!.count,
        6,
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
            SELECT count(*) AS count FROM voice_conversation_transcript_entries
          `)[0]!.count,
        1,
      );

      yield* sql`
        INSERT INTO voice_conversation_entries (
          entry_id, conversation_id, epoch, sequence, kind, payload_json, occurred_at
        ) VALUES (
          'entry-new-epoch', 'conversation-history', 2, 8, 'transcript.assistant',
          '{"text":"current epoch"}', '2026-07-11T09:08:00.000Z'
        )
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly id: string }>`
          SELECT entry_id AS id FROM history_voice_entry_documents
        `,
        [{ id: "entry-new-epoch" }],
      );

      yield* sql`DELETE FROM voice_conversations WHERE conversation_id = 'conversation-history'`;
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM history_voice_entry_documents`)[0]!.count,
        0,
      );
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM voice_conversation_entries_fts`)[0]!.count,
        0,
      );
    }),
  );
});

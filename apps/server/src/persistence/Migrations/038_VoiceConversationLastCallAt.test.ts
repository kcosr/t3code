import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_VoiceConversationLastCallAt", (it) => {
  it.effect("backfills existing conversations and leaves new conversations without a call", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO voice_conversations (
          conversation_id, retention, title, active_epoch,
          next_entry_sequence, created_at, updated_at
        ) VALUES (
          'conversation-existing', 'durable', NULL, 1,
          1, '2026-07-11T08:00:00.000Z', '2026-07-11T09:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO voice_conversations (
          conversation_id, retention, title, active_epoch,
          next_entry_sequence, created_at, updated_at
        ) VALUES (
          'conversation-new', 'durable', NULL, 1,
          1, '2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z'
        )
      `;
      const rows = yield* sql<{ readonly id: string; readonly lastCallAt: string | null }>`
        SELECT conversation_id AS id, last_call_at AS "lastCallAt"
        FROM voice_conversations
        ORDER BY conversation_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { id: "conversation-existing", lastCallAt: "2026-07-11T09:00:00.000Z" },
        { id: "conversation-new", lastCallAt: null },
      ]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_VoiceThreadToolQueryIndexes", (it) => {
  it.effect("creates bounded message and durable turn-start projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id,
          source_proposed_plan_thread_id, source_proposed_plan_id,
          assistant_message_id, state, requested_at, started_at, completed_at,
          checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES
          (
            'thread-migrate', NULL, 'message-pending', NULL, NULL,
            NULL, 'pending', '2026-07-11T08:00:00.000Z', NULL, NULL,
            NULL, NULL, NULL, '[]'
          ),
          (
            'thread-migrate', 'turn-accepted', 'message-accepted',
            'thread-source', 'plan-source', NULL, 'running',
            '2026-07-11T08:00:01.000Z', '2026-07-11T08:00:02.000Z', NULL,
            NULL, NULL, NULL, '[]'
          )
      `;
      yield* runMigrations({ toMigrationInclusive: 35 });

      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_messages_completed_page')
      `;
      assert.deepStrictEqual(
        messageColumns.map((column) => column.name),
        ["thread_id", "is_streaming", "created_at", "message_id"],
      );

      const turnIndexes = yield* sql<{
        readonly name: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_turn_starts)
      `;
      assert.ok(
        turnIndexes.some(
          (index) => index.name === "idx_projection_turn_starts_turn" && index.partial === 1,
        ),
      );
      const turnColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_turn_starts_turn')
      `;
      assert.deepStrictEqual(
        turnColumns.map((column) => column.name),
        ["thread_id", "turn_id"],
      );

      const starts = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly state: string;
      }>`
        SELECT message_id AS "messageId", turn_id AS "turnId", state
        FROM projection_turn_starts
        WHERE thread_id = 'thread-migrate'
        ORDER BY message_id ASC
      `;
      assert.deepStrictEqual(starts, [
        { messageId: "message-accepted", turnId: "turn-accepted", state: "accepted" },
        { messageId: "message-pending", turnId: null, state: "pending" },
      ]);
      const legacyPending = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_turns
        WHERE thread_id = 'thread-migrate' AND turn_id IS NULL
      `;
      assert.deepStrictEqual(legacyPending, [{ count: 0 }]);
      const concreteTurnColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_turns)
      `;
      assert.deepStrictEqual(
        concreteTurnColumns.map((column) => column.name),
        [
          "row_id",
          "thread_id",
          "turn_id",
          "assistant_message_id",
          "state",
          "requested_at",
          "started_at",
          "completed_at",
          "checkpoint_turn_count",
          "checkpoint_ref",
          "checkpoint_status",
          "checkpoint_files_json",
        ],
      );
      assert.equal(concreteTurnColumns.find((column) => column.name === "turn_id")?.notnull, 1);
    }),
  );
});

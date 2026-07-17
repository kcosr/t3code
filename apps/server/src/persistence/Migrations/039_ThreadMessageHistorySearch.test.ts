import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const seedProjectAndThread = Effect.fn("seedProjectAndThread")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      'project-history', 'History project', '/tmp/history', NULL, '[]',
      '2026-07-11T08:00:00.000Z', '2026-07-11T08:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
      latest_user_message_at, pending_approval_count, pending_user_input_count,
      has_actionable_proposed_plan, deleted_at
    ) VALUES (
      'thread-history', 'project-history', 'Searchable thread',
      '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
      NULL, NULL, NULL, '2026-07-11T08:00:00.000Z', '2026-07-11T08:00:00.000Z',
      '2026-07-11T08:01:00.000Z', NULL, 0, 0, 0, NULL
    )
  `;
});

layer("039_ThreadMessageHistorySearch", (it) => {
  it.effect("backfills visible completed messages and tracks lifecycle mutations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* seedProjectAndThread();
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('message-user', 'thread-history', NULL, 'user', 'alpha decision', 0,
            '2026-07-11T08:01:00.000Z', '2026-07-11T08:01:00.000Z'),
          ('message-streaming', 'thread-history', NULL, 'assistant', 'partial beta', 1,
            '2026-07-11T08:02:00.000Z', '2026-07-11T08:02:00.000Z'),
          ('message-system', 'thread-history', NULL, 'system', 'system history', 0,
            '2026-07-11T08:03:00.000Z', '2026-07-11T08:03:00.000Z'),
          ('message-empty', 'thread-history', NULL, 'assistant', '   ', 0,
            '2026-07-11T08:04:00.000Z', '2026-07-11T08:04:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const backfilled = yield* sql<{ readonly id: string }>`
        SELECT message_id AS id
        FROM history_thread_message_documents
        ORDER BY message_id ASC
      `;
      assert.deepStrictEqual(backfilled, [{ id: "message-system" }, { id: "message-user" }]);
      assert.deepStrictEqual(
        yield* sql<{ readonly id: string }>`
          SELECT documents.message_id AS id
          FROM projection_thread_messages_fts
          INNER JOIN history_thread_message_documents AS documents
            ON documents.document_id = projection_thread_messages_fts.rowid
          WHERE projection_thread_messages_fts MATCH 'alpha'
        `,
        [{ id: "message-user" }],
      );

      const initialGeneration = (yield* sql<{ readonly generation: number }>`
          SELECT generation FROM history_search_index_state WHERE source = 'thread-message'
        `)[0]!.generation;
      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'completed beta response', is_streaming = 0,
          updated_at = '2026-07-11T08:05:00.000Z'
        WHERE message_id = 'message-streaming'
      `;
      const afterCompletion = (yield* sql<{ readonly generation: number }>`
          SELECT generation FROM history_search_index_state WHERE source = 'thread-message'
        `)[0]!.generation;
      assert.isAbove(afterCompletion, initialGeneration);

      yield* sql`
        UPDATE projection_thread_messages
        SET updated_at = '2026-07-11T08:06:00.000Z'
        WHERE message_id = 'message-streaming'
      `;
      assert.equal(
        (yield* sql<{ readonly generation: number }>`
            SELECT generation FROM history_search_index_state WHERE source = 'thread-message'
          `)[0]!.generation,
        afterCompletion,
      );

      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-07-11T08:07:00.000Z'
        WHERE thread_id = 'thread-history'
      `;
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM history_thread_message_documents`)[0]!.count,
        0,
      );
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM projection_thread_messages`)[0]!.count,
        4,
      );

      yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'thread-history'`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = 'thread-history'`;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-user', 'thread-history', NULL, 'user', 'alpha decision', 0,
          '2026-07-11T08:01:00.000Z', '2026-07-11T08:08:00.000Z'
        )
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly id: string }>`
          SELECT message_id AS id FROM history_thread_message_documents ORDER BY message_id
        `,
        [{ id: "message-user" }],
      );

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-unicode', 'thread-history', NULL, 'assistant', 'naïve café agent_context', 0,
          '2026-07-11T08:09:00.000Z', '2026-07-11T08:09:00.000Z'
        )
      `;
      for (const term of ["naive", "cafe", "agent_context"]) {
        assert.equal(
          (yield* sql<{ readonly count: number }>`
              SELECT count(*) AS count
              FROM projection_thread_messages_fts
              WHERE projection_thread_messages_fts MATCH ${term}
            `)[0]!.count,
          1,
        );
      }

      yield* sql`
        UPDATE projection_projects
        SET deleted_at = '2026-07-11T08:10:00.000Z'
        WHERE project_id = 'project-history'
      `;
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM history_thread_message_documents`)[0]!.count,
        0,
      );
      yield* sql`UPDATE projection_projects SET deleted_at = NULL WHERE project_id = 'project-history'`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-history-moved', 'Moved history project', '/tmp/history-moved', NULL, '[]',
          '2026-07-11T08:11:00.000Z', '2026-07-11T08:11:00.000Z', NULL
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET project_id = 'project-history-moved'
        WHERE thread_id = 'thread-history'
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly projectId: string }>`
          SELECT DISTINCT project_id AS "projectId"
          FROM history_thread_message_documents
        `,
        [{ projectId: "project-history-moved" }],
      );
    }),
  );
});

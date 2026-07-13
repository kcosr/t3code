import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_VoiceHandoffActions", (it) => {
  it.effect("creates the durable action table with terminal outcome constraints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO voice_conversations (
          conversation_id, retention, title, active_epoch, next_entry_sequence,
          created_at, updated_at, last_call_at
        ) VALUES (
          'conversation-1', 'durable', NULL, 1, 1,
          '2026-07-12T10:00:00.000Z', '2026-07-12T10:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO voice_handoff_actions (
          action_id, auth_session_id, realtime_session_id,
          realtime_generation, conversation_id, context_epoch, project_id, thread_id,
          auto_rearm, status, created_at, updated_at, expires_at
        ) VALUES (
          'action-1', 'auth-1', 'realtime-1', 2, 'conversation-1', 1,
          'project-1', 'thread-1', 1, 'pending',
          '2026-07-12T10:00:00.000Z', '2026-07-12T10:00:00.000Z',
          '2026-07-12T10:01:00.000Z'
        )
      `;
      const rows = yield* sql<{ readonly status: string; readonly autoRearm: number }>`
        SELECT status, auto_rearm AS "autoRearm" FROM voice_handoff_actions
      `;
      assert.deepStrictEqual(rows, [{ status: "pending", autoRearm: 1 }]);

      const invalid = yield* Effect.exit(sql`
        UPDATE voice_handoff_actions SET status = 'settled' WHERE action_id = 'action-1'
      `);
      assert.isTrue(invalid._tag === "Failure");
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_VoiceNativeControlGrants", (it) => {
  it.effect("stores hashes and capability scope without raw bearer tokens", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO voice_native_control_grants (
          token_hash, auth_session_id, session_id, lease_generation, expires_at,
          session_control, handoff_actions, created_at
        ) VALUES ('hash-only', 'auth-1', 'session-1', 1, 2000, 1, 1, 1000)
      `;
      const rows = yield* sql<{ readonly tokenHash: string }>`
        SELECT token_hash AS "tokenHash" FROM voice_native_control_grants
      `;
      assert.deepStrictEqual(rows, [{ tokenHash: "hash-only" }]);
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('voice_native_control_grants')
      `;
      assert.isFalse(columns.some((column) => column.name === "token"));
    }),
  );
});

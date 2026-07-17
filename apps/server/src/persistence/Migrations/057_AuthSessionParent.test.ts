import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("057_AuthSessionParent", (it) => {
  it.effect("runs after retired voice migrations and backfills existing native children", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });

      // Migrations 41-56 were deployed by the retired native-runtime design. Their
      // IDs remain part of persistent database history even though that schema is no
      // longer created for fresh installations.
      yield* sql`
        WITH RECURSIVE retired_migrations(migration_id) AS (
          SELECT 41
          UNION ALL
          SELECT migration_id + 1
          FROM retired_migrations
          WHERE migration_id < 56
        )
        INSERT INTO effect_sql_migrations (migration_id, name)
        SELECT migration_id, 'RetiredVoiceMigration' || migration_id
        FROM retired_migrations
      `;

      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, scopes, method, client_device_type,
          issued_at, expires_at, revoked_at
        ) VALUES
          (
            'parent-session', 'paired-mobile', '["voice:use"]',
            'dpop-access-token', 'mobile',
            '2026-07-17T00:00:00.000Z', '2026-07-17T12:00:00.000Z', NULL
          ),
          (
            'native-child', 'native-voice:parent-session', '["voice:use"]',
            'bearer-access-token', 'mobile',
            '2026-07-17T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL
          ),
          (
            'unrelated-session', 'native-voice:missing-parent', '["voice:use"]',
            'bearer-access-token', 'mobile',
            '2026-07-17T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL
          ),
          (
            'uppercase-unrelated', 'NATIVE-VOICE:parent-session', '["voice:use"]',
            'bearer-access-token', 'mobile',
            '2026-07-17T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL
          ),
          (
            'revoked-parent', 'paired-mobile', '["voice:use"]',
            'dpop-access-token', 'mobile',
            '2026-07-17T00:00:00.000Z', '2026-07-17T10:00:00.000Z',
            '2026-07-17T01:00:00.000Z'
          ),
          (
            'legacy-child-of-revoked-parent', 'native-voice:revoked-parent', '["voice:use"]',
            'bearer-access-token', 'mobile',
            '2026-07-17T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 57 });

      const rows = yield* sql<{
        readonly sessionId: string;
        readonly parentSessionId: string | null;
        readonly expiresAt: string;
        readonly revokedAt: string | null;
      }>`
        SELECT
          session_id AS "sessionId",
          parent_session_id AS "parentSessionId",
          expires_at AS "expiresAt",
          revoked_at AS "revokedAt"
        FROM auth_sessions
        ORDER BY session_id ASC
      `;
      assert.deepStrictEqual(rows, [
        {
          sessionId: "legacy-child-of-revoked-parent",
          parentSessionId: "revoked-parent",
          expiresAt: "2026-07-17T10:00:00.000Z",
          revokedAt: "2026-07-17T01:00:00.000Z",
        },
        {
          sessionId: "native-child",
          parentSessionId: "parent-session",
          expiresAt: "2026-07-17T12:00:00.000Z",
          revokedAt: null,
        },
        {
          sessionId: "parent-session",
          parentSessionId: null,
          expiresAt: "2026-07-17T12:00:00.000Z",
          revokedAt: null,
        },
        {
          sessionId: "revoked-parent",
          parentSessionId: null,
          expiresAt: "2026-07-17T10:00:00.000Z",
          revokedAt: "2026-07-17T01:00:00.000Z",
        },
        {
          sessionId: "unrelated-session",
          parentSessionId: null,
          expiresAt: "2026-07-18T00:00:00.000Z",
          revokedAt: null,
        },
        {
          sessionId: "uppercase-unrelated",
          parentSessionId: null,
          expiresAt: "2026-07-18T00:00:00.000Z",
          revokedAt: null,
        },
      ]);

      const indexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_auth_sessions_parent')
      `;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["parent_session_id", "revoked_at"],
      );
    }),
  );
});

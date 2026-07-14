import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_VoiceNativeThreadTurnRuntimeFoundation", (it) => {
  it.effect("rebuilds canonical non-null identity and preserves operation children", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`INSERT INTO auth_sessions (
        session_id, subject, scopes, method, client_device_type, issued_at, expires_at
      ) VALUES (
        'migration-auth', 'migration-test', '[]', 'bearer-access-token', 'mobile',
        '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
      )`;
      yield* sql`INSERT INTO voice_native_thread_turn_operations (
        operation_id, auth_session_id, runtime_id, runtime_generation, client_operation_id,
        project_id, thread_id, speech_preset, auto_rearm, token_hash, phase, active_slot,
        expires_at, created_at, updated_at, last_sequence
      ) VALUES (
        'migration-operation', 'migration-auth', 'migration-runtime', 1, 'migration-client',
        'migration-project', 'migration-thread', 'default', 1, 'migration-token', 'created', 1,
        2000, '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z', 1
      )`;
      yield* sql`INSERT INTO voice_native_thread_turn_events (
        operation_id, sequence, event_json, occurred_at
      ) VALUES (
        'migration-operation', 1,
        '{"type":"phase","sequence":1,"occurredAt":"2026-07-13T12:00:00.000Z","phase":"created"}',
        '2026-07-13T12:00:00.000Z'
      )`;
      yield* sql`INSERT INTO voice_native_thread_turn_speech_segments (
        operation_id, segment_index, assistant_message_id, start_offset, end_offset,
        final_segment, created_at, source_event_sequence, source_text_sha256
      ) VALUES (
        'migration-operation', 0, 'migration-assistant', 0, 5, 1,
        '2026-07-13T12:00:00.000Z', 1, 'migration-digest'
      )`;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info('voice_native_thread_turn_operations')`;
      const required = new Set([
        "mode_session_id",
        "turn_client_operation_id",
        "submission_policy",
        "speech_plan_id",
        "operation_token_expires_at",
        "retention_expires_at",
      ]);
      assert.deepStrictEqual(
        columns
          .filter((column) => required.has(column.name))
          .map((column) => [column.name, column.notnull]),
        [
          ["mode_session_id", 1],
          ["turn_client_operation_id", 1],
          ["submission_policy", 1],
          ["speech_plan_id", 1],
          ["operation_token_expires_at", 1],
          ["retention_expires_at", 1],
        ],
      );
      assert.deepStrictEqual(
        yield* sql<{
          readonly modeSessionId: string;
          readonly turnClientOperationId: string;
          readonly submissionPolicy: string;
          readonly speechPlanId: string;
          readonly operationTokenExpiresAt: number;
          readonly retentionExpiresAt: number;
        }>`SELECT mode_session_id AS "modeSessionId",
            turn_client_operation_id AS "turnClientOperationId",
            submission_policy AS "submissionPolicy", speech_plan_id AS "speechPlanId",
            operation_token_expires_at AS "operationTokenExpiresAt",
            retention_expires_at AS "retentionExpiresAt"
          FROM voice_native_thread_turn_operations`,
        [
          {
            modeSessionId: "voice-mode:migration-operation",
            turnClientOperationId: "migration-client",
            submissionPolicy: "auto-submit",
            speechPlanId: "voice-speech-plan:migration-operation",
            operationTokenExpiresAt: 2000,
            retentionExpiresAt: 2_592_002_000,
          },
        ],
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT count(*) AS count
            FROM voice_native_thread_turn_events WHERE operation_id = 'migration-operation'`)[0]
          ?.count,
        1,
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT count(*) AS count
            FROM voice_native_thread_turn_speech_segments
            WHERE operation_id = 'migration-operation'`)[0]?.count,
        1,
      );
      const uniqueIndexes = yield* sql<{
        readonly name: string;
        readonly unique: number;
      }>`PRAGMA index_list('voice_native_thread_turn_operations')`;
      const uniqueColumnSets: ReadonlyArray<ReadonlyArray<string>> = yield* Effect.forEach(
        uniqueIndexes.filter((index) => index.unique === 1),
        (index) =>
          sql
            .unsafe<{ readonly name: string }>(`PRAGMA index_info('${index.name}')`)
            .pipe(Effect.map((rows) => rows.map((row) => row.name))),
        { concurrency: 1 },
      );
      assert.isTrue(
        uniqueColumnSets.some(
          (columns) =>
            columns.join(",") ===
            "auth_session_id,runtime_id,runtime_generation,mode_session_id,turn_client_operation_id",
        ),
      );
      assert.isFalse(
        uniqueColumnSets.some(
          (columns) =>
            columns.join(",") ===
            "auth_session_id,runtime_id,runtime_generation,turn_client_operation_id",
        ),
      );
    }),
  );
});

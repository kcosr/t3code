import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_InvalidateLegacyVoiceNativeRuntimeTargets", (it) => {
  it.effect("keeps current targets and deletes obsolete or malformed grants", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`INSERT INTO voice_native_runtime_grants (
        token_hash, runtime_id, generation, auth_session_id, granted_scopes_json,
        target_json, expires_at, created_at
      ) VALUES
        (
          'valid-realtime', 'valid-realtime-runtime', 1, 'valid-realtime-auth', '[]',
          '{"mode":"realtime","conversation":{"type":"continue","conversationId":"conversation"},"focus":{"type":"none"}}',
          2000, 1000
        ),
        (
          'valid-thread', 'valid-thread-runtime', 1, 'valid-thread-auth', '[]',
          '{"mode":"thread","environmentId":"environment","projectId":"project","threadId":"thread","speechPreset":"default","autoRearm":true,"endpointPolicy":{"endSilenceMs":2200,"noSpeechTimeoutMs":null,"maximumUtteranceMs":120000},"speechEnabled":true,"rearmGuardMs":500}',
          2000, 1000
        ),
        (
          'legacy-thread', 'legacy-thread-runtime', 1, 'legacy-thread-auth', '[]',
          '{"mode":"thread","projectId":"project","threadId":"thread","speechPreset":"default","autoRearm":true}',
          2000, 1000
        ),
        (
          'malformed', 'malformed-runtime', 1, 'malformed-auth', '[]',
          '{not-json', 2000, 1000
        )`;
      yield* sql`INSERT INTO voice_native_thread_turn_operations (
        operation_id, auth_session_id, runtime_id, runtime_instance_id, runtime_generation,
        mode_session_id, turn_client_operation_id, project_id, thread_id, speech_preset,
        auto_rearm, submission_policy, speech_plan_id, token_hash, phase, active_slot,
        operation_token_expires_at, retention_expires_at, created_at, updated_at
      ) VALUES (
        'legacy-operation', 'legacy-thread-auth', 'legacy-thread-runtime', 'legacy-instance', 1,
        'legacy-mode', 'legacy-client-operation', 'project', 'thread', 'default', 1,
        'auto-submit', 'legacy-speech-plan', 'legacy-operation-token', 'created', 1,
        2000, 3000, '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z'
      )`;
      yield* sql`INSERT INTO voice_native_realtime_starts (
        operation_key, auth_session_id, runtime_id, runtime_generation, client_operation_id,
        conversation_id, claim_expires_at, expires_at, created_at, updated_at
      ) VALUES (
        'legacy-start', 'legacy-thread-auth', 'legacy-thread-runtime', 1, 'legacy-start-client',
        'conversation', 2000, 3000, 1000, 1000
      )`;
      yield* sql`INSERT INTO voice_native_control_grants (
        token_hash, auth_session_id, session_id, lease_generation, expires_at,
        session_control, handoff_actions, created_at, runtime_id, runtime_generation,
        webrtc_signaling, session_close
      ) VALUES (
        'legacy-control', 'legacy-thread-auth', 'legacy-session', 1, 2000,
        1, 0, 1000, 'legacy-thread-runtime', 1, 0, 0
      )`;

      yield* runMigrations({ toMigrationInclusive: 49 });

      assert.deepStrictEqual(
        yield* sql<{ readonly tokenHash: string }>`SELECT token_hash AS "tokenHash"
          FROM voice_native_runtime_grants ORDER BY token_hash`,
        [{ tokenHash: "valid-realtime" }, { tokenHash: "valid-thread" }],
      );
      const operations = yield* sql<{
        readonly tokenHash: string;
        readonly phase: string;
        readonly activeSlot: number | null;
        readonly detachedAt: string | null;
      }>`SELECT token_hash AS "tokenHash", phase, active_slot AS "activeSlot",
          detached_at AS "detachedAt" FROM voice_native_thread_turn_operations
          WHERE operation_id = 'legacy-operation'`;
      assert.deepStrictEqual(
        operations.map(({ detachedAt: _, ...operation }) => operation),
        [
          {
            tokenHash: "revoked:migration-49:legacy-operation",
            phase: "cancelled",
            activeSlot: null,
          },
        ],
      );
      assert.isString(operations[0]?.detachedAt);
      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM voice_native_realtime_starts WHERE operation_key = 'legacy-start'`)[0]?.count,
        0,
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM voice_native_control_grants WHERE token_hash = 'legacy-control'`)[0]?.count,
        0,
      );
    }),
  );
});

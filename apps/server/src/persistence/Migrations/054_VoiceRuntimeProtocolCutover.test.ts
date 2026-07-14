import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_VoiceRuntimeProtocolCutover", (it) => {
  it.effect("fences legacy generations and preserves only accepted detached work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`INSERT INTO voice_native_runtime_grants (
        token_hash, provisioning_operation_id, runtime_id, generation, auth_session_id,
        granted_scopes_json, target_json, expires_at, created_at
      ) VALUES (
        'legacy-runtime-token', 'legacy-provision', 'legacy-runtime', 7, 'legacy-auth',
        '[]', '{"mode":"realtime","conversation":{"type":"continue","conversationId":"conversation"},"focus":{"type":"none"}}',
        2000, 1000
      )`;
      yield* sql`INSERT INTO voice_native_thread_turn_operations (
        operation_id, auth_session_id, runtime_id, runtime_instance_id, runtime_generation,
        mode_session_id, turn_client_operation_id, project_id, thread_id, speech_preset,
        auto_rearm, submission_policy, speech_plan_id, token_hash, phase, active_slot,
        dispatch_accepted, operation_token_expires_at, retention_expires_at, created_at,
        updated_at
      ) VALUES
      (
        'accepted-operation', 'legacy-auth', 'legacy-runtime', 'legacy-instance', 7,
        'accepted-mode', 'accepted-client-operation', 'project', 'thread', 'default',
        1, 'auto-submit', 'accepted-speech-plan', 'accepted-operation-token', 'monitoring', 1,
        1, 2000, 3000, '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z'
      ),
      (
        'unaccepted-operation', 'legacy-auth', 'legacy-runtime', 'legacy-instance', 7,
        'unaccepted-mode', 'unaccepted-client-operation', 'project', 'thread', 'default',
        1, 'auto-submit', 'unaccepted-speech-plan', 'unaccepted-operation-token', 'created', NULL,
        0, 2000, 3000, '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z'
      )`;

      yield* runMigrations({ toMigrationInclusive: 54 });

      expect(
        yield* sql<{
          readonly authSessionId: string;
          readonly runtimeId: string;
          readonly maximumGeneration: number;
        }>`SELECT auth_session_id AS "authSessionId", runtime_id AS "runtimeId",
            maximum_generation AS "maximumGeneration" FROM voice_runtime_generation_fences`,
      ).toEqual([
        {
          authSessionId: "legacy-auth",
          runtimeId: "legacy-runtime",
          maximumGeneration: 7,
        },
      ]);
      expect(
        yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'voice_native_runtime_grants'`,
      ).toEqual([]);
      expect(
        yield* sql<{
          readonly operationId: string;
          readonly tokenHash: string;
          readonly phase: string;
          readonly activeSlot: number | null;
          readonly dispatchAccepted: number;
          readonly detachedAt: string | null;
          readonly speechEnabled: number;
        }>`SELECT operation_id AS "operationId", token_hash AS "tokenHash", phase,
            active_slot AS "activeSlot", dispatch_accepted AS "dispatchAccepted",
            detached_at AS "detachedAt", speech_enabled AS "speechEnabled"
          FROM voice_thread_turn_operations ORDER BY operation_id`,
      ).toEqual([
        {
          operationId: "accepted-operation",
          tokenHash: "revoked:protocol-1:accepted-operation",
          phase: "monitoring",
          activeSlot: 1,
          dispatchAccepted: 1,
          detachedAt: expect.any(String),
          speechEnabled: 1,
        },
        {
          operationId: "unaccepted-operation",
          tokenHash: "revoked:protocol-1:unaccepted-operation",
          phase: "cancelled",
          activeSlot: null,
          dispatchAccepted: 0,
          detachedAt: expect.any(String),
          speechEnabled: 1,
        },
      ]);
      expect(
        yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM voice_runtime_grants`,
      ).toEqual([{ count: 0 }]);
      expect(
        yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name GLOB 'voice_native_*'`,
      ).toEqual([]);
      expect(
        (yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'voice_runtime_control_grants',
              'voice_runtime_realtime_starts',
              'voice_thread_turn_operations',
              'voice_thread_turn_events',
              'voice_thread_turn_speech_segments',
              'voice_thread_turn_assistant_messages',
              'voice_thread_turn_speech_dispositions',
              'voice_thread_turn_drafts'
            ) ORDER BY name`).map(({ name }) => name),
      ).toEqual([
        "voice_runtime_control_grants",
        "voice_runtime_realtime_starts",
        "voice_thread_turn_assistant_messages",
        "voice_thread_turn_drafts",
        "voice_thread_turn_events",
        "voice_thread_turn_operations",
        "voice_thread_turn_speech_dispositions",
        "voice_thread_turn_speech_segments",
      ]);
    }),
  );
});

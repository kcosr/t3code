import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_IdempotentVoiceNativeRuntimeGrantProvisioning", (it) => {
  it.effect("invalidates old authority and requires a provisioning operation identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`INSERT INTO voice_native_runtime_grants (
        token_hash, runtime_id, generation, auth_session_id, granted_scopes_json,
        target_json, expires_at, created_at
      ) VALUES (
        'legacy-runtime-token', 'legacy-runtime', 1, 'legacy-auth', '[]',
        '{"mode":"realtime","conversation":{"type":"continue","conversationId":"conversation"},"focus":{"type":"none"}}',
        2000, 1000
      )`;
      yield* sql`INSERT INTO voice_native_thread_turn_operations (
        operation_id, auth_session_id, runtime_id, runtime_instance_id, runtime_generation,
        mode_session_id, turn_client_operation_id, project_id, thread_id, speech_preset,
        auto_rearm, submission_policy, speech_plan_id, token_hash, phase, active_slot,
        operation_token_expires_at, retention_expires_at, created_at, updated_at
      ) VALUES (
        'legacy-operation', 'legacy-auth', 'legacy-runtime', 'legacy-instance', 1,
        'legacy-mode', 'legacy-client-operation', 'project', 'thread', 'default', 1,
        'auto-submit', 'legacy-speech-plan', 'legacy-operation-token', 'created', 1,
        2000, 3000, '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z'
      )`;
      yield* sql`INSERT INTO voice_native_realtime_starts (
        operation_key, auth_session_id, runtime_id, runtime_generation, client_operation_id,
        conversation_id, claim_expires_at, expires_at, created_at, updated_at
      ) VALUES (
        'legacy-start', 'legacy-auth', 'legacy-runtime', 1, 'legacy-start-client',
        'conversation', 2000, 3000, 1000, 1000
      )`;
      yield* sql`INSERT INTO voice_native_control_grants (
        token_hash, auth_session_id, session_id, lease_generation, expires_at,
        session_control, handoff_actions, created_at, runtime_id, runtime_generation,
        webrtc_signaling, session_close
      ) VALUES (
        'legacy-control', 'legacy-auth', 'legacy-session', 1, 2000,
        1, 0, 1000, 'legacy-runtime', 1, 0, 0
      )`;

      yield* runMigrations({ toMigrationInclusive: 50 });

      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM voice_native_runtime_grants`)[0]?.count,
        0,
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM voice_native_realtime_starts`)[0]?.count,
        0,
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM voice_native_control_grants`)[0]?.count,
        0,
      );
      assert.deepStrictEqual(
        yield* sql<{
          readonly tokenHash: string;
          readonly phase: string;
          readonly activeSlot: number | null;
        }>`SELECT token_hash AS "tokenHash", phase, active_slot AS "activeSlot"
          FROM voice_native_thread_turn_operations`,
        [
          {
            tokenHash: "revoked:migration-50:legacy-operation",
            phase: "cancelled",
            activeSlot: null,
          },
        ],
      );
      const operationColumn = (yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(voice_native_runtime_grants)`).find(
        ({ name }) => name === "provisioning_operation_id",
      );
      assert.equal(operationColumn?.notnull, 1);
    }),
  );
});

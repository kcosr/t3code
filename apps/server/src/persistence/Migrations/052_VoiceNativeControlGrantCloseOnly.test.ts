import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = Layer.mergeAll(NodeSqliteClient.layerMemory());

it.effect("preserves control grants and permits a close-only terminal grant", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 51 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO voice_native_control_grants (
      token_hash, auth_session_id, session_id, lease_generation, expires_at,
      session_control, handoff_actions, created_at, runtime_id, runtime_generation,
      webrtc_signaling, session_close
    ) VALUES (
      'runtime-control', 'auth-one', 'session-one', 1, 20000,
      1, 1, 1000, 'runtime-one', 1, 1, 1
    )`;

    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`UPDATE voice_native_control_grants
      SET session_control = 0, handoff_actions = 0, webrtc_signaling = 0
      WHERE token_hash = 'runtime-control'`;

    expect(
      yield* sql<{
        readonly tokenHash: string;
        readonly sessionControl: number;
        readonly handoffActions: number;
        readonly webrtcSignaling: number;
        readonly sessionClose: number;
      }>`SELECT token_hash AS "tokenHash", session_control AS "sessionControl",
          handoff_actions AS "handoffActions", webrtc_signaling AS "webrtcSignaling",
          session_close AS "sessionClose"
        FROM voice_native_control_grants`,
    ).toEqual([
      {
        tokenHash: "runtime-control",
        sessionControl: 0,
        handoffActions: 0,
        webrtcSignaling: 0,
        sessionClose: 1,
      },
    ]);
  }).pipe(Effect.provide(layer)),
);

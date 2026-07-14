import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const sqlite = NodeSqliteClient.layerMemory();
const layer = Layer.mergeAll(sqlite, NodeServices.layer);

it.effect("invalidates legacy Realtime starts and their child control grants", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 50 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO voice_native_realtime_starts (
      operation_key, auth_session_id, runtime_id, runtime_generation,
      client_operation_id, conversation_id, session_id, claim_expires_at,
      expires_at, created_at, updated_at
    ) VALUES (
      'old-start', 'auth-one', 'runtime-one', 1, 'operation-one',
      'conversation-one', 'session-one', 10000, 20000, 1000, 1000
    )`;
    yield* sql`INSERT INTO voice_native_control_grants (
      token_hash, auth_session_id, session_id, lease_generation, expires_at,
      session_control, handoff_actions, runtime_id, runtime_generation,
      webrtc_signaling, session_close, created_at
    ) VALUES (
      'old-token', 'auth-one', 'session-one', 1, 20000,
      1, 1, 'runtime-one', 1, 1, 1, 1000
    )`;
    yield* sql`INSERT INTO voice_native_control_grants (
      token_hash, auth_session_id, session_id, lease_generation, expires_at,
      session_control, handoff_actions, runtime_id, runtime_generation,
      webrtc_signaling, session_close, created_at
    ) VALUES (
      'unrelated-token', 'auth-two', 'unrelated-session', 1, 20000,
      1, 0, NULL, NULL, 0, 0, 1000
    )`;

    yield* runMigrations({ toMigrationInclusive: 51 });

    expect(yield* sql`SELECT 1 FROM voice_native_realtime_starts`).toHaveLength(0);
    expect(
      yield* sql`SELECT 1 FROM voice_native_control_grants WHERE token_hash = 'old-token'`,
    ).toHaveLength(0);
    expect(
      yield* sql`SELECT 1 FROM voice_native_control_grants WHERE token_hash = 'unrelated-token'`,
    ).toHaveLength(1);
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(
      voice_native_realtime_starts
    )`;
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["runtime_instance_id", "mode_session_id", "lease_generation"]),
    );
  }).pipe(Effect.provide(layer)),
);

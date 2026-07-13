import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthVoiceUseScope,
  VoiceConversationId,
  VoiceNativeRuntimeId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { VoiceNativeControlGrantRepositoryLive } from "../../persistence/Layers/VoiceNativeControlGrants.ts";
import { VoiceNativeRuntimeGrantRepositoryLive } from "../../persistence/Layers/VoiceNativeRuntimeGrants.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { VoiceNativeControlGrantRegistryLive } from "../Services/VoiceNativeControlGrantRegistry.ts";
import { VoiceNativeControlGrantRegistry } from "../Services/VoiceNativeControlGrantRegistry.ts";
import { __testing } from "./VoiceNativeRuntimeGrantRegistry.ts";

const sqlite = NodeSqliteClient.layerMemory();
const controlRepository = VoiceNativeControlGrantRepositoryLive.pipe(Layer.provide(sqlite));
const persistence = Layer.mergeAll(
  VoiceNativeRuntimeGrantRepositoryLive.pipe(Layer.provide(sqlite)),
  controlRepository,
  VoiceNativeControlGrantRegistryLive.pipe(
    Layer.provide(controlRepository),
    Layer.provide(NodeServices.layer),
  ),
  sqlite,
);
const testLayer = persistence.pipe(Layer.provideMerge(NodeServices.layer));

const runtimeId = VoiceNativeRuntimeId.make("android-main");
const authSessionId = AuthSessionId.make("auth-main");
const target = {
  mode: "realtime" as const,
  conversation: {
    type: "continue" as const,
    conversationId: VoiceConversationId.make("conversation-main"),
  },
  focus: { type: "none" as const },
};

const insertActiveAuthSession = (sessionId = authSessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO auth_sessions (
      session_id, subject, scopes, method, client_device_type, issued_at, expires_at
    ) VALUES (
      ${sessionId}, 'native-runtime-test', '[]', 'bearer-access-token', 'mobile',
      '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
    )`;
  });

it.effect("hashes, rotates, expires, and auth-fences runtime grants", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* insertActiveAuthSession();
    const registry = yield* __testing.make;
    const now = yield* Clock.currentTimeMillis;
    const first = yield* registry.issue({
      authSessionId,
      runtimeId,
      generation: 1,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 60_000,
    });
    expect(first.token).not.toContain("auth-main");
    expect(first.refreshed).toBe(false);
    expect(yield* registry.authorize(first.token)).toMatchObject({
      runtimeId,
      generation: 1,
      target,
    });

    const second = yield* registry.issue({
      authSessionId,
      runtimeId,
      generation: 2,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 60_000,
    });
    expect(yield* registry.authorize(first.token)).toBeUndefined();
    expect(yield* registry.authorize(second.token)).toMatchObject({ generation: 2 });
    expect(
      yield* Effect.flip(
        registry.issue({
          authSessionId,
          runtimeId,
          generation: 1,
          grantedScopes: new Set([AuthVoiceUseScope]),
          target,
          expiresAt: now + 60_000,
        }),
      ),
    ).toMatchObject({ reason: "invalid-phase" });

    yield* registry.revokeAuthSession(authSessionId);
    expect(yield* registry.authorize(second.token)).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refreshes an identical generation without revoking its child authority", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* insertActiveAuthSession();
    const runtimeGrants = yield* __testing.make;
    const childGrants = yield* VoiceNativeControlGrantRegistry;
    const now = yield* Clock.currentTimeMillis;
    const first = yield* runtimeGrants.issue({
      authSessionId,
      runtimeId,
      generation: 1,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 60_000,
    });
    const child = yield* childGrants.issue({
      authSessionId,
      runtimeId,
      runtimeGeneration: 1,
      sessionId: VoiceSessionId.make("same-generation-child"),
      leaseGeneration: 1,
      expiresAt: now + 60_000,
      capabilities: new Set(["session-control", "webrtc-signaling"]),
    });

    const refreshed = yield* runtimeGrants.issue({
      authSessionId,
      runtimeId,
      generation: 1,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 120_000,
    });
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.token).not.toBe(first.token);
    expect(yield* runtimeGrants.authorize(first.token)).toBeUndefined();
    expect(yield* runtimeGrants.authorize(refreshed.token)).toMatchObject({
      generation: 1,
      expiresAt: now + 120_000,
    });
    expect(yield* childGrants.authorize(child)).toBeDefined();

    const mismatch = yield* runtimeGrants
      .issue({
        authSessionId,
        runtimeId,
        generation: 1,
        grantedScopes: new Set(),
        target,
        expiresAt: now + 120_000,
      })
      .pipe(Effect.flip);
    expect(mismatch).toMatchObject({ reason: "invalid-phase" });
    expect(yield* runtimeGrants.authorize(refreshed.token)).toBeDefined();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a stale generation when child authority is issued after rotation", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* insertActiveAuthSession();
    const registry = yield* __testing.make;
    const childGrants = yield* VoiceNativeControlGrantRegistry;
    const now = yield* Clock.currentTimeMillis;
    yield* registry.issue({
      authSessionId,
      runtimeId,
      generation: 1,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 60_000,
    });
    yield* registry.issue({
      authSessionId,
      runtimeId,
      generation: 2,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 60_000,
    });

    const rejected = yield* childGrants
      .issue({
        authSessionId,
        runtimeId,
        runtimeGeneration: 1,
        sessionId: VoiceSessionId.make("stale-runtime-child"),
        leaseGeneration: 1,
        expiresAt: now + 60_000,
        capabilities: new Set(["webrtc-signaling"]),
      })
      .pipe(Effect.flip);
    expect(rejected).toMatchObject({ reason: "invalid-phase" });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("immediately fences an existing child grant when its parent generation changes", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* insertActiveAuthSession();
    const runtimeGrants = yield* __testing.make;
    const childGrants = yield* VoiceNativeControlGrantRegistry;
    const now = yield* Clock.currentTimeMillis;
    yield* runtimeGrants.issue({
      authSessionId,
      runtimeId,
      generation: 1,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 60_000,
    });
    const child = yield* childGrants.issue({
      authSessionId,
      runtimeId,
      runtimeGeneration: 1,
      sessionId: VoiceSessionId.make("runtime-child-before-rotation"),
      leaseGeneration: 1,
      expiresAt: now + 60_000,
      capabilities: new Set(["session-control", "webrtc-signaling"]),
    });
    expect(yield* childGrants.authorize(child)).toBeDefined();

    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE voice_native_runtime_grants SET generation = 2
      WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;

    expect(yield* childGrants.authorize(child)).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a runtime token after durable parent revocation across restart", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* insertActiveAuthSession();
    const beforeRestart = yield* __testing.make;
    const now = yield* Clock.currentTimeMillis;
    const issued = yield* beforeRestart.issue({
      authSessionId,
      runtimeId,
      generation: 1,
      grantedScopes: new Set([AuthVoiceUseScope]),
      target,
      expiresAt: now + 60_000,
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-07-13T00:00:00.000Z'
      WHERE session_id = ${authSessionId}`;

    const afterRestart = yield* __testing.make;
    expect(yield* afterRestart.authorize(issued.token)).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthVoiceUseScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  VoiceRuntimeId,
  VoiceModeSessionId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceRuntimeCredentialHash,
  VoiceRuntimeTargetDigest,
  VoiceSpeechPlanId,
  VoiceSessionId,
  VoiceThreadTurnOperationId,
  VoiceTurnClientOperationId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { VoiceRuntimeControlGrantRepositoryLive } from "../../persistence/Layers/VoiceRuntimeControlGrants.ts";
import { VoiceRuntimeRealtimeStartRepository } from "../../persistence/Services/VoiceRuntimeRealtimeStarts.ts";
import { VoiceRuntimeGrantRepositoryLive } from "../../persistence/Layers/VoiceRuntimeGrants.ts";
import { VoiceRuntimeRealtimeStartRepositoryLive } from "../../persistence/Layers/VoiceRuntimeRealtimeStarts.ts";
import { VoiceThreadTurnStoreLive } from "../../persistence/Layers/VoiceThreadTurns.ts";
import { VoiceThreadTurnStore } from "../../persistence/Services/VoiceThreadTurns.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { VoiceRuntimeControlGrantRegistryLive } from "../Services/VoiceRuntimeControlGrantRegistry.ts";
import { VoiceRuntimeControlGrantRegistry } from "../Services/VoiceRuntimeControlGrantRegistry.ts";
import { __testing } from "./VoiceRuntimeGrantRegistry.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const sqlite = NodeSqliteClient.layerMemory();
const controlRepository = VoiceRuntimeControlGrantRepositoryLive.pipe(Layer.provide(sqlite));
const persistence = Layer.mergeAll(
  VoiceRuntimeGrantRepositoryLive.pipe(Layer.provide(sqlite)),
  VoiceRuntimeRealtimeStartRepositoryLive.pipe(Layer.provide(sqlite)),
  VoiceThreadTurnStoreLive.pipe(Layer.provide(sqlite)),
  controlRepository,
  VoiceRuntimeControlGrantRegistryLive.pipe(
    Layer.provide(controlRepository),
    Layer.provide(NodeServices.layer),
  ),
  sqlite,
);
const secretStore = Layer.succeed(ServerSecretStore, {
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(0x5a)),
} as unknown as ServerSecretStore["Service"]);
const testLayer = persistence.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(secretStore),
);

const runtimeId = VoiceRuntimeId.make("android-main");
const authSessionId = AuthSessionId.make("auth-main");
const target = {
  mode: "realtime" as const,
  environmentId: EnvironmentId.make("environment-main"),
  conversationId: VoiceConversationId.make("conversation-main"),
};
const targetDigest = VoiceRuntimeTargetDigest.make(
  NodeCrypto.createHash("sha256").update(__testing.canonicalJson(target)).digest("hex"),
);
const authorityBase = {
  grantedScopes: new Set([AuthVoiceUseScope]),
  target,
  targetDigest,
  operation: "realtime-start" as const,
  readinessEnabled: false,
  refreshCredentialHash: null,
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
    yield* runMigrations({ toMigrationInclusive: 55 });
    yield* insertActiveAuthSession();
    const registry = yield* __testing.make;
    const realtimeStarts = yield* VoiceRuntimeRealtimeStartRepository;
    const threadTurns = yield* VoiceThreadTurnStore;
    const now = yield* Clock.currentTimeMillis;
    const first = yield* registry.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
      ...authorityBase,
      expiresAt: now + 60_000,
    });
    expect(first.token).not.toContain("auth-main");
    expect(first.replayed).toBe(false);
    expect(first.issuedAt).toBe(now);
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql<{
        readonly tokenHash: string;
        readonly provisioningOperationId: string;
      }>`SELECT token_hash AS "tokenHash",
          provisioning_operation_id AS "provisioningOperationId"
        FROM voice_runtime_grants`,
    ).toEqual([
      {
        tokenHash: NodeCrypto.createHash("sha256").update(first.token).digest("hex"),
        provisioningOperationId: "provision-main-1",
      },
    ]);
    expect(yield* registry.authorize(first.token)).toMatchObject({
      runtimeId,
      generation: 1,
      target,
    });
    yield* realtimeStarts.claim({
      operationKey: "native-start-generation-1",
      authSessionId,
      runtimeId,
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-instance-realtime-1"),
      runtimeGeneration: 1,
      modeSessionId: VoiceModeSessionId.make("mode-session-realtime-1"),
      clientOperationId: "generation-1",
      conversationId: target.conversationId,
      claimExpiresAt: now + 30_000,
      expiresAt: now + 60_000,
      now,
    });
    const threadOperationId = VoiceThreadTurnOperationId.make("native-thread-operation-1");
    const threadTokenHash = "native-thread-operation-token-hash";
    yield* threadTurns.claim({
      operationId: threadOperationId,
      authSessionId,
      runtimeId,
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-instance-1"),
      runtimeGeneration: 1,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      turnClientOperationId: VoiceTurnClientOperationId.make("turn-client-operation-1"),
      projectId: ProjectId.make("project-main"),
      threadId: ThreadId.make("thread-main"),
      speechPreset: "default",
      speechEnabled: true,
      autoRearm: true,
      submissionPolicy: "auto-submit",
      speechPlanId: VoiceSpeechPlanId.make("speech-plan-main"),
      tokenHash: threadTokenHash,
      operationTokenExpiresAt: now + 60_000,
      retentionExpiresAt: now + 120_000,
      nowEpochMillis: now,
      now: DateTime.formatIso(DateTime.makeUnsafe(now)),
    });
    expect(yield* threadTurns.authorize(threadOperationId, threadTokenHash, now)).toBeDefined();

    const second = yield* registry.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 1,
      generation: 2,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-2"),
      ...authorityBase,
      expiresAt: now + 60_000,
    });
    expect(yield* registry.authorize(first.token)).toBeUndefined();
    expect(yield* registry.authorize(second.token)).toMatchObject({ generation: 2 });
    expect(
      yield* sql`SELECT 1 FROM voice_runtime_realtime_starts
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`,
    ).toHaveLength(0);
    expect(yield* threadTurns.authorize(threadOperationId, threadTokenHash, now)).toBeUndefined();
    expect(
      yield* Effect.flip(
        registry.issue({
          authSessionId,
          runtimeId,
          expectedCurrentGeneration: 0,
          generation: 1,
          provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
          ...authorityBase,
          expiresAt: now + 60_000,
        }),
      ),
    ).toMatchObject({ reason: "invalid-phase" });

    yield* realtimeStarts.claim({
      operationKey: "native-start-generation-2",
      authSessionId,
      runtimeId,
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-instance-realtime-2"),
      runtimeGeneration: 2,
      modeSessionId: VoiceModeSessionId.make("mode-session-realtime-2"),
      clientOperationId: "generation-2",
      conversationId: target.conversationId,
      claimExpiresAt: now + 30_000,
      expiresAt: now + 60_000,
      now,
    });
    yield* registry.revokeAuthSession(authSessionId);
    expect(yield* registry.authorize(second.token)).toBeUndefined();
    expect(
      yield* sql`SELECT 1 FROM voice_runtime_realtime_starts
        WHERE auth_session_id = ${authSessionId}`,
    ).toHaveLength(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "replays an identical generation without rotating token, expiry, or child authority",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* insertActiveAuthSession();
      const runtimeGrants = yield* __testing.make;
      const childGrants = yield* VoiceRuntimeControlGrantRegistry;
      const now = yield* Clock.currentTimeMillis;
      const first = yield* runtimeGrants.issue({
        authSessionId,
        runtimeId,
        expectedCurrentGeneration: 0,
        generation: 1,
        provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
        ...authorityBase,
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
        expectedCurrentGeneration: 0,
        generation: 1,
        provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
        ...authorityBase,
        expiresAt: now + 120_000,
      });
      expect(refreshed.replayed).toBe(true);
      expect(refreshed.token).toBe(first.token);
      expect(refreshed.issuedAt).toBe(first.issuedAt);
      expect(refreshed.expiresAt).toBe(now + 60_000);
      expect(yield* runtimeGrants.authorize(first.token)).toBeDefined();
      expect(yield* runtimeGrants.authorize(refreshed.token)).toMatchObject({
        generation: 1,
        expiresAt: now + 60_000,
      });
      expect(yield* childGrants.authorize(child)).toBeDefined();

      const mismatch = yield* runtimeGrants
        .issue({
          authSessionId,
          runtimeId,
          expectedCurrentGeneration: 0,
          generation: 1,
          provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-other"),
          ...authorityBase,
          expiresAt: now + 120_000,
        })
        .pipe(Effect.flip);
      expect(mismatch).toMatchObject({ reason: "invalid-phase" });
      expect(yield* runtimeGrants.authorize(refreshed.token)).toBeDefined();
    }).pipe(Effect.provide(testLayer)),
);

it.effect("atomically rotates runtime authority to a replay-stable thread credential", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const transitionAuthSessionId = AuthSessionId.make("auth-transition");
    const transitionRuntimeId = VoiceRuntimeId.make("android-transition");
    yield* insertActiveAuthSession(transitionAuthSessionId);
    const runtimeGrants = yield* __testing.make;
    const childGrants = yield* VoiceRuntimeControlGrantRegistry;
    const now = yield* Clock.currentTimeMillis;
    const issued = yield* runtimeGrants.issue({
      authSessionId: transitionAuthSessionId,
      runtimeId: transitionRuntimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-transition-1"),
      ...authorityBase,
      expiresAt: now + 60_000,
    });
    const sourceSessionId = VoiceSessionId.make("transition-source-session");
    const sourceControlToken = yield* childGrants.issue({
      authSessionId: transitionAuthSessionId,
      runtimeId: transitionRuntimeId,
      runtimeGeneration: 1,
      sessionId: sourceSessionId,
      leaseGeneration: 1,
      expiresAt: now + 60_000,
      capabilities: new Set([
        "session-control",
        "handoff-actions",
        "webrtc-signaling",
        "session-close",
      ]),
    });
    const threadTarget = {
      mode: "thread" as const,
      environmentId: EnvironmentId.make("environment-transition"),
      projectId: ProjectId.make("project-transition"),
      threadId: ThreadId.make("thread-transition"),
      speechPreset: "default" as const,
      autoRearm: true,
      endpointPolicy: {
        endSilenceMs: 2_200,
        noSpeechTimeoutMs: null,
        maximumUtteranceMs: 600_000,
      },
      speechEnabled: true,
      rearmGuardMs: 500,
    };
    const sql = yield* SqlClient.SqlClient;
    const transitionToken = "thread-transition-token";
    const transitionTokenHash = NodeCrypto.createHash("sha256")
      .update(transitionToken)
      .digest("hex");
    yield* sql`INSERT INTO voice_runtime_realtime_transition_grants (
      operation_key, token_hash, source_control_token_hash, auth_session_id,
      source_session_id, source_lease_generation, action_id, action_sequence,
      runtime_id, runtime_instance_id, source_generation, target_generation,
      mode_session_id, target_json, expires_at, authority_expires_at, created_at
    ) VALUES (
      'transition-operation', ${transitionTokenHash}, 'source-control-hash',
      ${transitionAuthSessionId}, ${sourceSessionId}, 1, 'transition-action', 1,
      ${transitionRuntimeId}, 'transition-instance', 1, 2, 'transition-mode',
      ${encodeJson(threadTarget)}, ${now + 30_000}, ${now + 60_000}, ${now}
    )`;

    const first = yield* runtimeGrants.activateTransition(transitionToken, {
      authSessionId: transitionAuthSessionId,
      runtimeId: transitionRuntimeId,
      sourceGeneration: 1,
      targetGeneration: 2,
      target: threadTarget,
      authorityExpiresAt: now + 60_000,
    });
    expect(first).toEqual({ expiresAt: now + 60_000, replayed: false });
    expect(yield* runtimeGrants.authorize(issued.token)).toBeUndefined();
    expect(yield* runtimeGrants.authorize("thread-transition-token")).toMatchObject({
      generation: 2,
      expiresAt: now + 60_000,
      target: threadTarget,
    });
    expect(yield* childGrants.authorize(sourceControlToken)).toMatchObject({
      sessionId: sourceSessionId,
      runtimeGeneration: 1,
      capabilities: new Set(["session-close"]),
    });

    expect(
      yield* runtimeGrants.activateTransition(transitionToken, {
        authSessionId: transitionAuthSessionId,
        runtimeId: transitionRuntimeId,
        sourceGeneration: 1,
        targetGeneration: 2,
        target: threadTarget,
        authorityExpiresAt: now + 60_000,
      }),
    ).toEqual({ expiresAt: now + 60_000, replayed: true });
    expect(
      yield* runtimeGrants
        .activateTransition("conflicting-transition-token", {
          authSessionId: transitionAuthSessionId,
          runtimeId: transitionRuntimeId,
          sourceGeneration: 1,
          targetGeneration: 2,
          target: threadTarget,
          authorityExpiresAt: now + 60_000,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "authorization-revoked" });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a stale generation when child authority is issued after rotation", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* insertActiveAuthSession();
    const registry = yield* __testing.make;
    const childGrants = yield* VoiceRuntimeControlGrantRegistry;
    const now = yield* Clock.currentTimeMillis;
    yield* registry.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
      ...authorityBase,
      expiresAt: now + 60_000,
    });
    yield* registry.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 1,
      generation: 2,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-2"),
      ...authorityBase,
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

it.effect("adopts a device runtime generation when a new auth session has no server fence", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    const repairedAuthSessionId = AuthSessionId.make("auth-repaired");
    yield* insertActiveAuthSession(repairedAuthSessionId);
    const registry = yield* __testing.make;
    const now = yield* Clock.currentTimeMillis;

    const issued = yield* registry.issue({
      authSessionId: repairedAuthSessionId,
      runtimeId,
      expectedCurrentGeneration: 7,
      generation: 8,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-repaired-8"),
      ...authorityBase,
      expiresAt: now + 60_000,
    });

    expect(yield* registry.authorize(issued.token)).toMatchObject({
      authSessionId: repairedAuthSessionId,
      runtimeId,
      generation: 8,
    });
    expect(
      yield* registry
        .issue({
          authSessionId: repairedAuthSessionId,
          runtimeId,
          expectedCurrentGeneration: 7,
          generation: 8,
          provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("conflict-repaired-8"),
          ...authorityBase,
          expiresAt: now + 60_000,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "invalid-phase" });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reduces a completed runtime handoff to close-only child authority", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* insertActiveAuthSession();
    const runtimeGrants = yield* __testing.make;
    const childGrants = yield* VoiceRuntimeControlGrantRegistry;
    const now = yield* Clock.currentTimeMillis;
    yield* runtimeGrants.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("close-only-runtime"),
      ...authorityBase,
      expiresAt: now + 60_000,
    });
    const sessionId = VoiceSessionId.make("completed-handoff-session");
    const token = yield* childGrants.issue({
      authSessionId,
      runtimeId,
      runtimeGeneration: 1,
      sessionId,
      leaseGeneration: 1,
      expiresAt: now + 60_000,
      capabilities: new Set([
        "session-control",
        "handoff-actions",
        "webrtc-signaling",
        "session-close",
      ]),
    });

    yield* childGrants.completeHandoff(sessionId);

    expect(yield* childGrants.authorize(token)).toMatchObject({
      runtimeId,
      runtimeGeneration: 1,
      capabilities: new Set(["session-close"]),
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("immediately fences an existing child grant when its parent generation changes", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* insertActiveAuthSession();
    const runtimeGrants = yield* __testing.make;
    const childGrants = yield* VoiceRuntimeControlGrantRegistry;
    const now = yield* Clock.currentTimeMillis;
    yield* runtimeGrants.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
      ...authorityBase,
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
    yield* sql`UPDATE voice_runtime_grants SET generation = 2
      WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;

    expect(yield* childGrants.authorize(child)).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a runtime token after durable parent revocation across restart", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* insertActiveAuthSession();
    const beforeRestart = yield* __testing.make;
    const now = yield* Clock.currentTimeMillis;
    const issued = yield* beforeRestart.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
      ...authorityBase,
      expiresAt: now + 60_000,
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-07-13T00:00:00.000Z'
      WHERE session_id = ${authSessionId}`;

    const afterRestart = yield* __testing.make;
    expect(yield* afterRestart.authorize(issued.token)).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rotates hashed refresh authority idempotently and invalidates prior use", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* insertActiveAuthSession();
    const registry = yield* __testing.make;
    const now = yield* Clock.currentTimeMillis;
    const initialRefresh = "A".repeat(43);
    const candidateRefresh = "B".repeat(43);
    const nextRefresh = "C".repeat(43);
    const hashCredential = (value: string) =>
      VoiceRuntimeCredentialHash.make(NodeCrypto.createHash("sha256").update(value).digest("hex"));
    const provisioningOperationId = VoiceRuntimeProvisioningOperationId.make("provision-refresh-1");
    yield* registry.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId,
      ...authorityBase,
      readinessEnabled: true,
      refreshCredentialHash: hashCredential(initialRefresh),
      expiresAt: now + 60_000,
    });
    const request = {
      runtimeId,
      refreshRequestId: "refresh-request-1",
      provisioningOperationId,
      generation: 1,
      operation: "realtime-start" as const,
      targetDigest,
      expectedRotationCounter: 0,
      candidateCredentialHash: hashCredential(candidateRefresh),
      expiresAt: now + 120_000,
    };
    const first = yield* registry.refresh(initialRefresh, request);
    const lostResponseRetry = yield* registry.refresh(initialRefresh, request);
    expect(lostResponseRetry.token).toBe(first.token);
    expect(lostResponseRetry.refreshRotationCounter).toBe(1);
    expect(
      yield* registry
        .refresh(initialRefresh, {
          ...request,
          candidateCredentialHash: hashCredential(nextRefresh),
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "authorization-revoked" });

    expect((yield* registry.refresh(candidateRefresh, request)).token).toBe(first.token);
    expect(yield* registry.refresh(initialRefresh, request).pipe(Effect.flip)).toMatchObject({
      reason: "authorization-revoked",
    });
    const second = yield* registry.refresh(candidateRefresh, {
      ...request,
      refreshRequestId: "refresh-request-2",
      expectedRotationCounter: 1,
      candidateCredentialHash: hashCredential(nextRefresh),
    });
    expect(second.refreshRotationCounter).toBe(2);
    expect(second.token).not.toBe(first.token);

    const sql = yield* SqlClient.SqlClient;
    const persisted = encodeJson(
      yield* sql`SELECT * FROM voice_runtime_grants WHERE runtime_id = ${runtimeId}`,
    );
    expect(persisted).not.toContain(initialRefresh);
    expect(persisted).not.toContain(candidateRefresh);
    expect(persisted).not.toContain(nextRefresh);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("selects refresh authority by credential when auth sessions share a runtime id", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 54 });
    const otherAuthSessionId = AuthSessionId.make("auth-other");
    yield* insertActiveAuthSession();
    yield* insertActiveAuthSession(otherAuthSessionId);
    const registry = yield* __testing.make;
    const now = yield* Clock.currentTimeMillis;
    const firstRefresh = "D".repeat(43);
    const secondRefresh = "E".repeat(43);
    const candidateRefresh = "F".repeat(43);
    const hashCredential = (value: string) =>
      VoiceRuntimeCredentialHash.make(NodeCrypto.createHash("sha256").update(value).digest("hex"));

    yield* registry.issue({
      authSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-shared-1"),
      ...authorityBase,
      readinessEnabled: true,
      refreshCredentialHash: hashCredential(firstRefresh),
      expiresAt: now + 60_000,
    });
    const secondProvisioningOperationId =
      VoiceRuntimeProvisioningOperationId.make("provision-shared-2");
    yield* registry.issue({
      authSessionId: otherAuthSessionId,
      runtimeId,
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: secondProvisioningOperationId,
      ...authorityBase,
      readinessEnabled: true,
      refreshCredentialHash: hashCredential(secondRefresh),
      expiresAt: now + 60_000,
    });

    const refreshed = yield* registry.refresh(secondRefresh, {
      runtimeId,
      refreshRequestId: "refresh-shared-2",
      provisioningOperationId: secondProvisioningOperationId,
      generation: 1,
      operation: "realtime-start",
      targetDigest,
      expectedRotationCounter: 0,
      candidateCredentialHash: hashCredential(candidateRefresh),
      expiresAt: now + 120_000,
    });
    expect(refreshed.authSessionId).toBe(otherAuthSessionId);
    expect(refreshed.refreshRotationCounter).toBe(1);

    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql<{ readonly authSessionId: string; readonly refreshRotationCounter: number }>`
        SELECT auth_session_id AS "authSessionId",
          refresh_rotation_counter AS "refreshRotationCounter"
        FROM voice_runtime_grants WHERE runtime_id = ${runtimeId} ORDER BY auth_session_id`,
    ).toEqual([
      { authSessionId: "auth-main", refreshRotationCounter: 0 },
      { authSessionId: "auth-other", refreshRotationCounter: 1 },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "fences a retained thread operation when derived cleanup fails after runtime revoke",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* insertActiveAuthSession();
      const registry = yield* __testing.make;
      const threadTurns = yield* VoiceThreadTurnStore;
      const now = yield* Clock.currentTimeMillis;
      const issued = yield* registry.issue({
        authSessionId,
        runtimeId,
        expectedCurrentGeneration: 0,
        generation: 1,
        provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-main-1"),
        ...authorityBase,
        expiresAt: now + 60_000,
      });
      const operationId = VoiceThreadTurnOperationId.make("retained-thread-operation");
      const tokenHash = "retained-thread-operation-token-hash";
      yield* threadTurns.claim({
        operationId,
        authSessionId,
        runtimeId,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("retained-thread-runtime-instance"),
        runtimeGeneration: 1,
        modeSessionId: VoiceModeSessionId.make("retained-thread-mode-session"),
        turnClientOperationId: VoiceTurnClientOperationId.make("retained-thread-client-operation"),
        projectId: ProjectId.make("retained-thread-project"),
        threadId: ThreadId.make("retained-thread"),
        speechPreset: "default",
        speechEnabled: true,
        autoRearm: true,
        submissionPolicy: "auto-submit",
        speechPlanId: VoiceSpeechPlanId.make("retained-thread-speech-plan"),
        tokenHash,
        operationTokenExpiresAt: now + 60_000,
        retentionExpiresAt: now + 120_000,
        nowEpochMillis: now,
        now: DateTime.formatIso(DateTime.makeUnsafe(now)),
      });
      expect(yield* threadTurns.authorize(operationId, tokenHash, now)).toBeDefined();

      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_thread_turn_runtime_cleanup
      BEFORE UPDATE OF token_hash ON voice_thread_turn_operations
      BEGIN
        SELECT RAISE(FAIL, 'simulated derived cleanup failure');
      END`;

      expect(yield* registry.revokeRuntime(authSessionId, runtimeId)).toBe(true);
      expect(yield* registry.authorize(issued.token)).toBeUndefined();
      expect(yield* threadTurns.authorize(operationId, tokenHash, now)).toBeUndefined();
      expect(
        yield* sql<{ readonly tokenHash: string }>`SELECT token_hash AS "tokenHash"
        FROM voice_thread_turn_operations WHERE operation_id = ${operationId}`,
      ).toEqual([{ tokenHash }]);
      yield* sql`DROP TRIGGER fail_thread_turn_runtime_cleanup`;
    }).pipe(Effect.provide(testLayer)),
);

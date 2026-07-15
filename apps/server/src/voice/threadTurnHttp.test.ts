// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - HTTP integration exercises the Node boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthVoiceUseScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSpeechPlanId,
  VoiceThreadTurnOperationId,
  VoiceTurnClientOperationId,
  type VoiceRuntimeThreadTurnSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { VoiceRuntimeAuthorityRepositoryLive } from "../persistence/Layers/VoiceRuntimeAuthorities.ts";
import { VoiceThreadTurnStoreLive } from "../persistence/Layers/VoiceThreadTurns.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { VoiceRuntimeAuthorityRepository } from "../persistence/Services/VoiceRuntimeAuthorities.ts";
import { VoiceThreadTurnStore } from "../persistence/Services/VoiceThreadTurns.ts";
import { VoiceError } from "./Errors.ts";
import { VoiceThreadTurnService } from "./Services/VoiceThreadTurnService.ts";
import { voiceThreadTurnRoutesLayer } from "./threadTurnHttp.ts";

const ownerAuthSessionId = AuthSessionId.make("thread-route-owner");
const otherAuthSessionId = AuthSessionId.make("thread-route-other");
const runtimeId = VoiceRuntimeId.make("thread-route-runtime");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("thread-route-instance");
const operationId = VoiceThreadTurnOperationId.make("thread-route-operation");
const modeSessionId = VoiceModeSessionId.make("thread-route-mode");
const speechPlanId = VoiceSpeechPlanId.make("thread-route-speech-plan");
const threadTarget = {
  mode: "thread" as const,
  environmentId: EnvironmentId.make("thread-route-environment"),
  projectId: ProjectId.make("thread-route-project"),
  threadId: ThreadId.make("thread-route-thread"),
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

const ownershipHash = (authSessionId: string, ownedOperationId: string) =>
  NodeCrypto.createHash("sha256").update(`${authSessionId}\0${ownedOperationId}`).digest("hex");

const snapshot = (now: number): VoiceRuntimeThreadTurnSnapshot => ({
  operationId,
  runtimeId,
  runtimeInstanceId,
  generation: 1,
  modeSessionId,
  turnClientOperationId: VoiceTurnClientOperationId.make("thread-route-client-operation"),
  submissionPolicy: "draft",
  speechPlanId,
  projectId: threadTarget.projectId,
  threadId: threadTarget.threadId,
  speechPreset: threadTarget.speechPreset,
  autoRearm: threadTarget.autoRearm,
  phase: "created",
  userMessageId: null,
  turnId: null,
  assistantMessageIds: [],
  highestAdvertisedSegment: null,
  highestStartedSegment: null,
  highestDrainedSegment: null,
  segmentDispositions: [],
  lastSequence: 0,
  acknowledgedSequence: 0,
  speechTerminal: null,
  dispatchAccepted: false,
  detachedAt: null,
  operationTokenExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
  retentionExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 30 * 24 * 60 * 60 * 1_000)),
});

const authorizationError = () =>
  new VoiceError({
    reason: "authorization-revoked",
    operation: "thread-turn.authorize",
    detail: "Operation is not owned by this session or runtime identity",
    retryable: false,
  });

const threadServiceLayer = Layer.effect(
  VoiceThreadTurnService,
  Effect.gen(function* () {
    const store = yield* VoiceThreadTurnStore;
    const authorize = (authSessionId: string, requestedOperationId: VoiceThreadTurnOperationId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const record = yield* store
          .authorize(requestedOperationId, ownershipHash(authSessionId, requestedOperationId), now)
          .pipe(
            Effect.mapError(
              () =>
                new VoiceError({
                  reason: "provider-unavailable",
                  operation: "thread-turn.authorize",
                  detail: "Operation ownership storage is unavailable",
                  retryable: true,
                }),
            ),
          );
        if (record === undefined) return yield* authorizationError();
        return snapshot(now);
      });
    const unused = () => Effect.die("unused thread route test service operation");
    return VoiceThreadTurnService.of({
      authorizeOperation: authorize,
      beginAudioUpload: unused,
      create: unused,
      uploadAudio: unused,
      setDraftDisposition: unused,
      events: (authSessionId, requestedOperationId) =>
        authorize(authSessionId, requestedOperationId).pipe(
          Effect.map((authorizedSnapshot) => ({ snapshot: authorizedSnapshot, events: [] })),
        ),
      acknowledgeEvents: unused,
      speech: unused,
      cancel: unused,
      readDraft: unused,
      consumeDraft: unused,
      detach: unused,
      revokeRuntime: unused,
    });
  }),
);

const authenticateHttpRequest: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"] =
  (request) => {
    const authorization = request.headers.authorization;
    return Effect.succeed({
      sessionId: authorization === "Bearer other" ? otherAuthSessionId : ownerAuthSessionId,
      subject: "thread-route-test",
      method: "bearer-access-token" as const,
      scopes: authorization === "Bearer no-voice" ? [] : [AuthVoiceUseScope],
    });
  };

const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({ authenticateHttpRequest });
const sqlite = NodeSqliteClient.layerMemory();
const persistenceLayer = Layer.mergeAll(
  sqlite,
  VoiceThreadTurnStoreLive.pipe(Layer.provide(sqlite)),
  VoiceRuntimeAuthorityRepositoryLive.pipe(Layer.provide(sqlite)),
);

const initialize = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  yield* runMigrations({ toMigrationInclusive: 56 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_thread_turn_operations`;
  yield* sql`DELETE FROM voice_runtime_authorities`;
  yield* sql`DELETE FROM auth_sessions
    WHERE session_id IN (${ownerAuthSessionId}, ${otherAuthSessionId})`;
  yield* sql`INSERT INTO auth_sessions (
    session_id, subject, scopes, method, client_device_type, issued_at, expires_at
  ) VALUES
    (${ownerAuthSessionId}, 'thread-route-owner', '["voice:use"]',
      'bearer-access-token', 'mobile', '2026-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z'),
    (${otherAuthSessionId}, 'thread-route-other', '["voice:use"]',
      'bearer-access-token', 'mobile', '2026-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z')`;
  const authorities = yield* VoiceRuntimeAuthorityRepository;
  expect(
    (yield* authorities.configure(
      {
        authSessionId: ownerAuthSessionId,
        runtimeId,
        expectedCurrentGeneration: 0,
        generation: 1,
        target: threadTarget,
      },
      now,
    )).status,
  ).toBe("configured");
  const store = yield* VoiceThreadTurnStore;
  expect(
    (yield* store.claim({
      operationId,
      authSessionId: ownerAuthSessionId,
      runtimeId,
      runtimeInstanceId,
      runtimeGeneration: 1,
      modeSessionId,
      turnClientOperationId: VoiceTurnClientOperationId.make("thread-route-client-operation"),
      projectId: threadTarget.projectId,
      threadId: threadTarget.threadId,
      speechPreset: threadTarget.speechPreset,
      speechEnabled: threadTarget.speechEnabled,
      autoRearm: threadTarget.autoRearm,
      submissionPolicy: "draft",
      speechPlanId,
      tokenHash: ownershipHash(ownerAuthSessionId, operationId),
      operationTokenExpiresAt: now + 60_000,
      retentionExpiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      nowEpochMillis: now,
      now: DateTime.formatIso(DateTime.makeUnsafe(now)),
    })).status,
  ).toBe("claimed");
});

const withServer = (
  run: (baseUrl: string, advanceRuntimeIdentity: Effect.Effect<void>) => Effect.Effect<void>,
) => {
  const serverLayer = HttpRouter.serve(voiceThreadTurnRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(threadServiceLayer),
    Layer.provide(authLayer),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      yield* initialize;
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address))
        return yield* Effect.die("Expected a TCP test server address");
      const sql = yield* SqlClient.SqlClient;
      yield* run(
        `http://127.0.0.1:${address.port}`,
        sql`UPDATE voice_runtime_authorities SET generation = 2
          WHERE auth_session_id = ${ownerAuthSessionId} AND runtime_id = ${runtimeId}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      );
    }).pipe(Effect.provide(serverLayer)),
  );
};

const headers = (authorization: string) => ({
  authorization,
  "x-t3-voice-runtime-protocol-major": "2",
});

const events = (baseUrl: string, authorization: string) =>
  fetch(
    `${baseUrl}/api/voice/runtime/thread-turns/${operationId}/events?afterSequence=0&waitMilliseconds=0`,
    { headers: headers(authorization) },
  );

const postHeadersWithoutBody = (baseUrl: string, path: string, authorization: string) =>
  new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request(
      new URL(path, baseUrl),
      {
        method: "POST",
        headers: {
          ...headers(authorization),
          "content-type": "application/json",
          "content-length": "1048576",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
          request.destroy();
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(2_000, () => reject(new Error("Route consumed the unauthorized body")));
    request.flushHeaders();
  });

describe.sequential("Thread turn HTTP session authority", () => {
  it.effect("rejects missing voice:use scope before consuming the request body", () =>
    withServer((baseUrl) =>
      Effect.promise(async () => {
        expect(
          await postHeadersWithoutBody(
            baseUrl,
            `/api/voice/runtime/thread-turns/${operationId}/cancel`,
            "Bearer no-voice",
          ),
        ).toBe(403);
      }),
    ),
  );

  it.effect("requires both the owning auth session and current runtime identity", () =>
    withServer((baseUrl, advanceRuntimeIdentity) =>
      Effect.gen(function* () {
        expect((yield* Effect.promise(() => events(baseUrl, "Bearer owner"))).status).toBe(200);
        expect((yield* Effect.promise(() => events(baseUrl, "Bearer other"))).status).toBe(401);

        yield* advanceRuntimeIdentity;
        expect((yield* Effect.promise(() => events(baseUrl, "Bearer owner"))).status).toBe(401);
      }),
    ),
  );
});

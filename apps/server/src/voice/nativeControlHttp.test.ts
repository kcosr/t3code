// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - HTTP integration exercises the Node server boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  type VoiceNativeHandoffAction,
  VoiceConversationId,
  VoiceNativeRuntimeId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import {
  protectNativeRealtimeStartCriticalSection,
  voiceNativeControlRoutesLayer,
} from "./nativeControlHttp.ts";
import {
  VoiceNativeRealtimeStartRepository,
  type PersistedVoiceNativeRealtimeStart,
} from "../persistence/Services/VoiceNativeRealtimeStarts.ts";
import { VoiceError } from "./Errors.ts";
import {
  VoiceNativeControlGrantRegistry,
  type VoiceNativeControlGrantScope,
} from "./Services/VoiceNativeControlGrantRegistry.ts";
import { VoiceNativeRuntimeGrantRegistry } from "./Services/VoiceNativeRuntimeGrantRegistry.ts";
import type { VoiceNativeRuntimeGrantScope } from "./Services/VoiceNativeRuntimeGrantRegistry.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";

const sessionId = VoiceSessionId.make("voice-session-native-http");
const otherSessionId = VoiceSessionId.make("voice-session-native-http-other");
const token = "native-control-http-token";
const expiresAt = Date.parse("2026-07-12T18:00:00.000Z");
const unusedStartRepositoryMaintenance = {
  fail: () => Effect.succeed(true),
  revokeRuntime: () => Effect.void,
  revokeAuthSession: () => Effect.void,
  purgeExpired: () => Effect.void,
};

const grantScope = {
  authSessionId: AuthSessionId.make("native-http-auth"),
  sessionId,
  leaseGeneration: 4,
  expiresAt,
  capabilities: new Set(["session-control", "handoff-actions"] as const),
};

const runWithServer = <A>(
  run: (baseUrl: string, heartbeatCalls: () => number) => Promise<A>,
  options: {
    readonly authorize?: (
      candidate: string,
      call: number,
    ) => VoiceNativeControlGrantScope | undefined;
    readonly phase?: "listening" | "ended";
    readonly heartbeatFails?: boolean;
    readonly createError?: VoiceError | ((call: number) => VoiceError | undefined);
    readonly resumeError?: VoiceError;
    readonly offerError?: VoiceError;
    readonly closeError?: VoiceError;
    readonly grants?: VoiceNativeControlGrantRegistry["Service"];
    readonly pendingActions?: ReadonlyArray<VoiceNativeHandoffAction>;
    readonly runtimeAuthorize?: (candidate: string) => VoiceNativeRuntimeGrantScope | undefined;
    readonly onCreate?: Parameters<VoiceSessionService["Service"]["create"]>[1] extends infer Input
      ? (input: Input) => void
      : never;
    readonly startRepository?: VoiceNativeRealtimeStartRepository["Service"];
    readonly onResume?: (expectedSessionId: VoiceSessionId) => void;
    readonly bindFails?: boolean;
    readonly onRevokeRuntime?: () => void;
  } = {},
) => {
  let calls = 0;
  let authorizeCalls = 0;
  let createCalls = 0;
  let runtimeRevoked = false;
  let startRecord: PersistedVoiceNativeRealtimeStart | undefined;
  const startRepository = VoiceNativeRealtimeStartRepository.of({
    claim: (input) => {
      if (startRecord?.failure?.retryable === true && startRecord.sessionId === null) {
        startRecord = { ...input, sessionId: null, failure: null };
        return Effect.succeed({ status: "claimed" as const });
      }
      if (startRecord !== undefined)
        return Effect.succeed({ status: "existing" as const, record: startRecord });
      startRecord = { ...input, sessionId: null, failure: null };
      return Effect.succeed({ status: "claimed" as const });
    },
    bindSession: (_operationKey, boundSessionId) => {
      if (startRecord === undefined) return Effect.succeed(false);
      if (options.bindFails) return Effect.succeed(false);
      startRecord = { ...startRecord, sessionId: boundSessionId };
      return Effect.succeed(true);
    },
    fail: (_operationKey, failure) => {
      if (startRecord === undefined || startRecord.sessionId !== null) return Effect.succeed(false);
      startRecord = { ...startRecord, failure };
      return Effect.succeed(true);
    },
    revokeRuntime: () => Effect.void,
    revokeAuthSession: () => Effect.void,
    purgeExpired: () => Effect.void,
  });
  const grants = VoiceNativeControlGrantRegistry.of({
    issue: () => Effect.die("unused"),
    authorize: (candidate) => {
      authorizeCalls += 1;
      return Effect.succeed(
        options.authorize === undefined
          ? candidate === token
            ? grantScope
            : undefined
          : options.authorize(candidate, authorizeCalls),
      );
    },
    revokeSession: () => Effect.void,
    releaseSessionControl: () => Effect.void,
    revokeAuthSession: () => Effect.void,
    revokeRuntime: () => Effect.void,
  });
  const sessions = Layer.mock(VoiceSessionService)({
    create: (_principal, input) => {
      createCalls += 1;
      options.onCreate?.(input);
      const createError =
        typeof options.createError === "function"
          ? options.createError(createCalls)
          : options.createError;
      if (createError !== undefined) return Effect.fail(createError);
      return Effect.succeed({
        state: {
          sessionId,
          conversationId: VoiceConversationId.make("native-http-conversation"),
          mode: "realtime-agent",
          phase: "signaling",
          leaseGeneration: 4,
          sequence: 0,
        },
        transport: {
          kind: "webrtc-sdp-v1",
          signalingPath: `/api/voice/sessions/${sessionId}/webrtc-offer`,
        },
        expiresAt: "2026-07-12T18:00:00.000Z",
        heartbeatIntervalSeconds: 8,
        nativeControlGrant: {
          token,
          sessionId,
          leaseGeneration: 4,
          expiresAt: "2026-07-12T18:00:00.000Z",
          heartbeatIntervalSeconds: 8,
          failureGraceSeconds: 30,
        },
      });
    },
    resumeCreate: (_principal, _input, expectedSessionId) => {
      options.onResume?.(expectedSessionId);
      if (options.resumeError !== undefined) return Effect.fail(options.resumeError);
      return Effect.succeed({
        state: {
          sessionId: expectedSessionId,
          conversationId: VoiceConversationId.make("native-http-conversation"),
          mode: "realtime-agent",
          phase: "signaling",
          leaseGeneration: 4,
          sequence: 0,
        },
        transport: {
          kind: "webrtc-sdp-v1",
          signalingPath: `/api/voice/sessions/${expectedSessionId}/webrtc-offer`,
        },
        expiresAt: "2026-07-12T18:00:00.000Z",
        heartbeatIntervalSeconds: 8,
        nativeControlGrant: {
          token,
          sessionId: expectedSessionId,
          leaseGeneration: 4,
          expiresAt: "2026-07-12T18:00:00.000Z",
          heartbeatIntervalSeconds: 8,
          failureGraceSeconds: 30,
        },
      });
    },
    heartbeat: (_owner, heartbeatSessionId, leaseGeneration) => {
      calls += 1;
      if (options.heartbeatFails) {
        return Effect.fail(
          new VoiceError({
            reason: "invalid-phase",
            operation: "native-heartbeat-test",
            detail: "heartbeat failed",
            retryable: false,
          }),
        );
      }
      return Effect.succeed({
        sessionId: heartbeatSessionId,
        conversationId: VoiceConversationId.make("native-http-conversation"),
        mode: "realtime-agent",
        phase: options.phase ?? "listening",
        leaseGeneration,
        sequence: calls,
      });
    },
    listPendingHandoffActions: (owner, handoffSessionId, leaseGeneration, limit) => {
      expect(owner).toBe(grantScope.authSessionId);
      expect(handoffSessionId).toBe(grantScope.sessionId);
      expect(leaseGeneration).toBe(grantScope.leaseGeneration);
      expect(limit).toBe(20);
      return Effect.succeed(options.pendingActions ?? []);
    },
    acknowledgeNativeHandoffAction: (owner, handoffSessionId, leaseGeneration, actionId, input) => {
      expect(owner).toBe(grantScope.authSessionId);
      expect(handoffSessionId).toBe(grantScope.sessionId);
      expect(leaseGeneration).toBe(grantScope.leaseGeneration);
      return Effect.succeed({
        actionId,
        action: "handoff-to-thread-voice" as const,
        outcome: input.outcome,
      });
    },
    offer: (_owner, offeredSessionId, offer) => {
      calls += 1;
      if (options.offerError !== undefined) return Effect.fail(options.offerError);
      return Effect.succeed({
        sessionId: offeredSessionId,
        leaseGeneration: offer.leaseGeneration,
        sdp: "answer-sdp",
      });
    },
    close: (_owner, closedSessionId, leaseGeneration) => {
      calls += 1;
      if (options.closeError !== undefined) return Effect.fail(options.closeError);
      return Effect.succeed({
        state: {
          sessionId: closedSessionId,
          conversationId: VoiceConversationId.make("native-http-conversation"),
          mode: "realtime-agent",
          phase: "ended",
          leaseGeneration,
          sequence: 1,
        },
        closed: true,
      });
    },
    revokeNativeRuntime: () =>
      Effect.sync(() => {
        runtimeRevoked = true;
        options.onRevokeRuntime?.();
      }),
  });
  const serverLayer = HttpRouter.serve(voiceNativeControlRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(Layer.succeed(VoiceNativeControlGrantRegistry, options.grants ?? grants)),
    Layer.provide(
      Layer.succeed(
        VoiceNativeRuntimeGrantRegistry,
        VoiceNativeRuntimeGrantRegistry.of({
          issue: () => Effect.die("unused"),
          authorize: (candidate) =>
            Effect.succeed(runtimeRevoked ? undefined : options.runtimeAuthorize?.(candidate)),
          revokeRuntime: () => Effect.succeed(false),
          revokeAuthSession: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(sessions),
    Layer.provide(
      Layer.succeed(VoiceNativeRealtimeStartRepository, options.startRepository ?? startRepository),
    ),
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        throw new Error("Expected a TCP test server address");
      }
      return yield* Effect.promise(() => run(`http://127.0.0.1:${address.port}`, () => calls));
    }).pipe(Effect.provide(serverLayer)),
  );
};

const heartbeat = (
  baseUrl: string,
  input: {
    readonly pathSessionId?: string;
    readonly token?: string;
    readonly body?: string;
  },
) =>
  fetch(`${baseUrl}/api/voice/sessions/${input.pathSessionId ?? sessionId}/native-heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.token === undefined ? {} : { "x-t3-voice-control": input.token }),
    },
    body: input.body ?? '{"leaseGeneration":4}',
  });

const expectNoStore = (response: Response) =>
  expect(response.headers.get("cache-control")).toBe("no-store");

describe("native voice control HTTP", () => {
  const replayConversationId = VoiceConversationId.make("native-http-conversation");
  const runtimeScopeForReplay: VoiceNativeRuntimeGrantScope = {
    authSessionId: grantScope.authSessionId,
    runtimeId: VoiceNativeRuntimeId.make("android-runtime"),
    generation: 7,
    grantedScopes: new Set(),
    target: {
      mode: "realtime",
      conversation: {
        type: "continue",
        conversationId: replayConversationId,
      },
      focus: { type: "none" },
    },
    expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
  };

  it.effect("reports a recently unbound durable start as pending without creating", () => {
    let createCalls = 0;
    const record: PersistedVoiceNativeRealtimeStart = {
      operationKey: "native:android-runtime:7:ignored",
      authSessionId: runtimeScopeForReplay.authSessionId,
      runtimeId: runtimeScopeForReplay.runtimeId,
      runtimeGeneration: 7,
      clientOperationId: "ambiguous-start",
      conversationId: replayConversationId,
      sessionId: null,
      failure: null,
      claimExpiresAt: Number.MAX_SAFE_INTEGER,
      expiresAt: runtimeScopeForReplay.expiresAt,
    };
    const repository = VoiceNativeRealtimeStartRepository.of({
      ...unusedStartRepositoryMaintenance,
      claim: () => Effect.succeed({ status: "existing" as const, record }),
      bindSession: () => Effect.die("unused"),
    });
    return runWithServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/voice/native/realtime-sessions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-t3-voice-runtime": "runtime-token" },
          body: '{"runtimeId":"android-runtime","generation":7,"clientOperationId":"ambiguous-start"}',
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ reason: "lease-conflict", retryable: true });
        expect(createCalls).toBe(0);
      },
      {
        runtimeAuthorize: (candidate) =>
          candidate === "runtime-token" ? runtimeScopeForReplay : undefined,
        startRepository: repository,
        onCreate: () => {
          createCalls += 1;
        },
      },
    );
  });

  it.effect("reports an abandoned unbound durable start as no-session without creating", () => {
    let createCalls = 0;
    const repository = VoiceNativeRealtimeStartRepository.of({
      ...unusedStartRepositoryMaintenance,
      claim: (input) =>
        Effect.succeed({
          status: "existing" as const,
          record: { ...input, sessionId: null, failure: null, claimExpiresAt: -1 },
        }),
      bindSession: () => Effect.die("unused"),
    });
    return runWithServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/voice/native/realtime-sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-t3-voice-runtime": "runtime-token",
          },
          body: '{"runtimeId":"android-runtime","generation":7,"clientOperationId":"abandoned-start"}',
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          reason: "session-not-found",
          retryable: false,
        });
        expect(createCalls).toBe(0);
      },
      {
        runtimeAuthorize: (candidate) =>
          candidate === "runtime-token" ? runtimeScopeForReplay : undefined,
        startRepository: repository,
        onCreate: () => {
          createCalls += 1;
        },
      },
    );
  });

  it.effect("does not recreate a bound native start whose session is absent after restart", () => {
    let createCalls = 0;
    let resumed: VoiceSessionId | undefined;
    const priorSessionId = VoiceSessionId.make("prior-native-session");
    const repository = VoiceNativeRealtimeStartRepository.of({
      ...unusedStartRepositoryMaintenance,
      claim: (input) =>
        Effect.succeed({
          status: "existing" as const,
          record: { ...input, sessionId: priorSessionId, failure: null },
        }),
      bindSession: () => Effect.die("unused"),
    });
    return runWithServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/voice/native/realtime-sessions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-t3-voice-runtime": "runtime-token" },
          body: '{"runtimeId":"android-runtime","generation":7,"clientOperationId":"restart-replay"}',
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ reason: "session-not-found" });
        expect(resumed).toBe(priorSessionId);
        expect(createCalls).toBe(0);
      },
      {
        runtimeAuthorize: (candidate) =>
          candidate === "runtime-token" ? runtimeScopeForReplay : undefined,
        startRepository: repository,
        onCreate: () => {
          createCalls += 1;
        },
        onResume: (id) => {
          resumed = id;
        },
        resumeError: new VoiceError({
          reason: "session-not-found",
          operation: "session.resume-create",
          detail: "The original native voice session is no longer resident",
          retryable: false,
        }),
      },
    );
  });

  it.effect("starts fresh Realtime only for the exact grant-bound conversation and focus", () => {
    const runtimeId = VoiceNativeRuntimeId.make("android-runtime");
    const conversationId = VoiceConversationId.make("grant-bound-conversation");
    const inputs: Array<Parameters<VoiceSessionService["Service"]["create"]>[1]> = [];
    let resumedSessionId: VoiceSessionId | undefined;
    const runtimeScope: VoiceNativeRuntimeGrantScope = {
      authSessionId: grantScope.authSessionId,
      runtimeId,
      generation: 7,
      grantedScopes: new Set(),
      target: {
        mode: "realtime",
        conversation: { type: "continue", conversationId },
        focus: {
          type: "thread",
          projectId: ProjectId.make("project-bound"),
          threadId: ThreadId.make("thread-bound"),
        },
      },
      expiresAt,
    };
    return runWithServer(
      async (baseUrl) => {
        for (const clientOperationId of ["same-operation", "same-operation"]) {
          const response = await fetch(`${baseUrl}/api/voice/native/realtime-sessions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-t3-voice-runtime": "runtime-token",
            },
            body: `{"runtimeId":"${runtimeId}","generation":7,"clientOperationId":"${clientOperationId}"}`,
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            transport: {
              signalingPath: `/api/voice/native/realtime-sessions/${sessionId}/webrtc-offer`,
            },
          });
        }
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toMatchObject({
          conversation: { type: "continue", conversationId, takeover: false },
          projectId: "project-bound",
          threadId: "thread-bound",
        });
        expect(inputs[0]?.idempotencyKey).toContain(`native:${grantScope.authSessionId}:`);
        expect(resumedSessionId).toBe(sessionId);
      },
      {
        runtimeAuthorize: (candidate) => (candidate === "runtime-token" ? runtimeScope : undefined),
        onCreate: (input) => inputs.push(input),
        onResume: (id) => {
          resumedSessionId = id;
        },
      },
    );
  });

  it.effect("rejects malformed or oversized native start bodies as invalid requests", () => {
    const runtimeId = VoiceNativeRuntimeId.make("android-invalid-body");
    const created: Array<unknown> = [];
    const runtimeScope: VoiceNativeRuntimeGrantScope = {
      authSessionId: grantScope.authSessionId,
      runtimeId,
      generation: 2,
      grantedScopes: new Set(),
      target: {
        mode: "realtime",
        conversation: {
          type: "continue",
          conversationId: VoiceConversationId.make("invalid-body-conversation"),
        },
        focus: { type: "none" },
      },
      expiresAt,
    };
    return runWithServer(
      async (baseUrl) => {
        for (const body of ["{", `{"padding":"${"x".repeat(2_048)}"}`]) {
          const response = await fetch(`${baseUrl}/api/voice/native/realtime-sessions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-t3-voice-runtime": "runtime-token",
            },
            body,
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ code: "invalid_request" });
        }
        expect(created).toHaveLength(0);
      },
      {
        runtimeAuthorize: (candidate) => (candidate === "runtime-token" ? runtimeScope : undefined),
        onCreate: (input) => created.push(input),
      },
    );
  });

  it.effect("re-authorizes signaling and close immediately before mutation", () =>
    runWithServer(
      async (baseUrl, calls) => {
        const offer = await fetch(
          `${baseUrl}/api/voice/native/realtime-sessions/${sessionId}/webrtc-offer`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-t3-voice-control": token },
            body: `{"sessionId":"${sessionId}","leaseGeneration":4,"sdp":"offer-sdp"}`,
          },
        );
        expect(offer.status).toBe(401);
        expect(calls()).toBe(0);
      },
      {
        authorize: (candidate, call) =>
          candidate === token && call === 1
            ? {
                ...grantScope,
                capabilities: new Set(["webrtc-signaling", "session-close"]),
              }
            : undefined,
      },
    ),
  );

  it.effect("retries an authoritative retryable start failure with the same operation", () => {
    let createCalls = 0;
    const providerError = new VoiceError({
      reason: "provider-unavailable",
      operation: "native-http-test",
      detail: "Realtime provider is temporarily unavailable",
      retryable: true,
    });
    return runWithServer(
      async (baseUrl) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetch(`${baseUrl}/api/voice/native/realtime-sessions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-t3-voice-runtime": "runtime-token",
            },
            body: '{"runtimeId":"android-runtime","generation":7,"clientOperationId":"failed-start"}',
          });
          expect(response.status).toBe(attempt === 0 ? 503 : 200);
          expect(await response.json()).toMatchObject(
            attempt === 0
              ? {
                  code: "voice_operation_failed",
                  reason: "provider-unavailable",
                  message: "Realtime provider is temporarily unavailable",
                  retryable: true,
                }
              : { state: { sessionId } },
          );
        }
        expect(createCalls).toBe(2);
      },
      {
        runtimeAuthorize: (candidate) =>
          candidate === "runtime-token"
            ? {
                authSessionId: grantScope.authSessionId,
                runtimeId: VoiceNativeRuntimeId.make("android-runtime"),
                generation: 7,
                grantedScopes: new Set(),
                target: {
                  mode: "realtime",
                  conversation: {
                    type: "continue",
                    conversationId: VoiceConversationId.make("native-http-conversation"),
                  },
                  focus: { type: "none" },
                },
                expiresAt,
              }
            : undefined,
        createError: (call) => (call === 1 ? providerError : undefined),
        onCreate: () => {
          createCalls += 1;
        },
      },
    );
  });

  it.effect("closes only the orphaned session when durable binding is rejected", () => {
    let createCalls = 0;
    let runtimeRevocations = 0;
    return runWithServer(
      async (baseUrl, closeCalls) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetch(`${baseUrl}/api/voice/native/realtime-sessions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-t3-voice-runtime": "runtime-token",
            },
            body: '{"runtimeId":"android-runtime","generation":7,"clientOperationId":"bind-failure"}',
          });
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({
            reason: "provider-unavailable",
            retryable: true,
          });
        }
        expect(createCalls).toBe(2);
        expect(closeCalls()).toBe(2);
        expect(runtimeRevocations).toBe(0);
      },
      {
        runtimeAuthorize: (candidate) =>
          candidate === "runtime-token" ? runtimeScopeForReplay : undefined,
        bindFails: true,
        onCreate: () => {
          createCalls += 1;
        },
        onRevokeRuntime: () => {
          runtimeRevocations += 1;
        },
      },
    );
  });

  it.effect("finishes the create-to-bind critical section after interruption", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Ref.make(false);
      const operation = protectNativeRealtimeStartCriticalSection(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Ref.set(completed, true)),
        ),
      );
      const operationFiber = yield* operation.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const interruption = yield* Fiber.interrupt(operationFiber).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interruption);
      expect(yield* Ref.get(completed)).toBe(true);
    }),
  );

  it.effect(
    "does not collapse authorized signaling or close failures into authentication errors",
    () =>
      Effect.gen(function* () {
        yield* runWithServer(
          async (baseUrl) => {
            const response = await fetch(
              `${baseUrl}/api/voice/native/realtime-sessions/${sessionId}/webrtc-offer`,
              {
                method: "POST",
                headers: { "content-type": "application/json", "x-t3-voice-control": token },
                body: `{"sessionId":"${sessionId}","leaseGeneration":4,"sdp":"offer-sdp"}`,
              },
            );
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({
              reason: "lease-conflict",
              retryable: true,
            });
          },
          {
            authorize: (candidate) =>
              candidate === token
                ? { ...grantScope, capabilities: new Set(["webrtc-signaling"]) }
                : undefined,
            offerError: new VoiceError({
              reason: "lease-conflict",
              operation: "native-offer-test",
              detail: "The session lease changed",
              retryable: true,
            }),
          },
        );
        yield* runWithServer(
          async (baseUrl) => {
            const response = await fetch(
              `${baseUrl}/api/voice/native/realtime-sessions/${sessionId}/close`,
              {
                method: "POST",
                headers: { "content-type": "application/json", "x-t3-voice-control": token },
                body: '{"leaseGeneration":4}',
              },
            );
            expect(response.status).toBe(404);
            expect(await response.json()).toMatchObject({
              reason: "session-not-found",
              retryable: false,
            });
          },
          {
            authorize: (candidate) =>
              candidate === token
                ? { ...grantScope, capabilities: new Set(["session-close"]) }
                : undefined,
            closeError: new VoiceError({
              reason: "session-not-found",
              operation: "native-close-test",
              detail: "The voice session no longer exists",
              retryable: false,
            }),
          },
        );
      }),
  );

  it.effect("re-authorizes close immediately before mutation", () =>
    runWithServer(
      async (baseUrl, calls) => {
        const response = await fetch(
          `${baseUrl}/api/voice/native/realtime-sessions/${sessionId}/close`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-t3-voice-control": token },
            body: '{"leaseGeneration":4}',
          },
        );
        expect(response.status).toBe(401);
        expect(calls()).toBe(0);
      },
      {
        authorize: (candidate, call) =>
          candidate === token && call === 1
            ? { ...grantScope, capabilities: new Set(["session-close"]) }
            : undefined,
      },
    ),
  );
  it.effect("polls and acknowledges handoff actions with the native grant", () =>
    runWithServer(
      async (baseUrl) => {
        const pending = await fetch(`${baseUrl}/api/voice/native/handoff-actions`, {
          headers: { "x-t3-voice-control": token },
        });
        expect(pending.status).toBe(200);
        expect(await pending.json()).toMatchObject({
          actions: [{ actionId: "native-action-1", sessionId, autoRearm: true }],
        });
        const acknowledged = await fetch(
          `${baseUrl}/api/voice/native/handoff-actions/native-action-1/ack`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-t3-voice-control": token,
            },
            body: '{"outcome":"succeeded","state":"listening"}',
          },
        );
        expect(acknowledged.status).toBe(200);
        expect(await acknowledged.json()).toMatchObject({
          actionId: "native-action-1",
          action: "handoff-to-thread-voice",
          outcome: "succeeded",
        });
      },
      {
        pendingActions: [
          {
            actionId: VoiceClientActionId.make("native-action-1"),
            sessionId,
            leaseGeneration: 4,
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make("thread-1"),
            autoRearm: true,
            expiresAt: "2026-07-12T18:00:00.000Z",
          },
        ],
      },
    ),
  );

  it.effect(
    "rejects missing, wrong, and bearer-only credentials without a main-auth fallback",
    () =>
      runWithServer(async (baseUrl, calls) => {
        const missing = await heartbeat(baseUrl, {});
        const wrong = await heartbeat(baseUrl, { token: "wrong-token" });
        const bearerOnly = await fetch(
          `${baseUrl}/api/voice/sessions/${sessionId}/native-heartbeat`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer otherwise-valid-main-auth",
              "content-type": "application/json",
            },
            body: '{"leaseGeneration":4}',
          },
        );
        for (const response of [missing, wrong, bearerOnly]) {
          expect(response.status).toBe(401);
          expectNoStore(response);
        }
        expect(calls()).toBe(0);
      }),
  );

  it.effect("accepts repeated heartbeats with the same multi-use grant", () =>
    runWithServer(async (baseUrl, calls) => {
      for (const expectedSequence of [1, 2]) {
        const response = await heartbeat(baseUrl, { token });
        expect(response.status).toBe(200);
        expectNoStore(response);
        expect(await response.json()).toMatchObject({
          sessionId,
          leaseGeneration: 4,
          phase: "listening",
          disposition: "live",
          expiresAt: "2026-07-12T18:00:00.000Z",
        });
        expect(calls()).toBe(expectedSequence);
      }
    }),
  );

  it.effect("rejects a grant used for the wrong path session or lease generation", () =>
    runWithServer(async (baseUrl, calls) => {
      const wrongSession = await heartbeat(baseUrl, {
        token,
        pathSessionId: otherSessionId,
      });
      const wrongGeneration = await heartbeat(baseUrl, {
        token,
        body: '{"leaseGeneration":5}',
      });
      for (const response of [wrongSession, wrongGeneration]) {
        expect(response.status).toBe(401);
        expectNoStore(response);
      }
      expect(calls()).toBe(0);
    }),
  );

  it.effect("rejects malformed heartbeat bodies before session control", () =>
    runWithServer(async (baseUrl, calls) => {
      const malformed = await heartbeat(baseUrl, { token, body: "{" });
      expect(malformed.status).toBe(400);
      expectNoStore(malformed);
      expect(calls()).toBe(0);
    }),
  );

  it.effect("rejects promptly at byte 257 without waiting for sender completion", () =>
    runWithServer(async (baseUrl, calls) => {
      const url = new URL(`/api/voice/sessions/${sessionId}/native-heartbeat`, baseUrl);
      const response = await new Promise<
        | { status: number; cacheControl: string | undefined; reset?: never }
        | { reset: true; status?: never; cacheControl?: never }
      >((resolve, reject) => {
        const request = NodeHttp.request(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
              "x-t3-voice-control": token,
            },
          },
          (incoming) => {
            clearTimeout(timeout);
            resolve({
              status: incoming.statusCode ?? 0,
              cacheControl: incoming.headers["cache-control"],
            });
            request.destroy();
          },
        );
        request.on("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timeout);
          if (error.code === "ECONNRESET") resolve({ reset: true });
          else reject(error);
        });
        request.write("x".repeat(257));
        const timeout = setTimeout(() => {
          request.destroy();
          reject(new Error("oversized streaming request was not rejected"));
        }, 1_000);
      });
      if (response.reset !== true) {
        expect(response).toEqual({ status: 400, cacheControl: "no-store" });
      }
      expect(calls()).toBe(0);
    }),
  );

  it.effect("re-authorizes immediately before heartbeat to fence rotation or revocation", () =>
    runWithServer(
      async (baseUrl, calls) => {
        const response = await heartbeat(baseUrl, { token });
        expect(response.status).toBe(401);
        expectNoStore(response);
        expect(calls()).toBe(0);
      },
      {
        authorize: (candidate, call) =>
          candidate === token && call === 1 ? grantScope : undefined,
      },
    ),
  );

  it.effect(
    "returns terminal disposition and maps heartbeat service failures to unauthorized",
    () =>
      Effect.gen(function* () {
        yield* runWithServer(
          async (baseUrl) => {
            const response = await heartbeat(baseUrl, { token });
            expect(response.status).toBe(200);
            expectNoStore(response);
            expect(await response.json()).toMatchObject({
              phase: "ended",
              disposition: "terminal",
            });
          },
          { phase: "ended" },
        );
        yield* runWithServer(
          async (baseUrl) => {
            const response = await heartbeat(baseUrl, { token });
            expect(response.status).toBe(401);
            expectNoStore(response);
          },
          { heartbeatFails: true },
        );
      }),
  );
});

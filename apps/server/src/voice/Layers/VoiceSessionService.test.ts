import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthVoiceUseScope,
  type AuthEnvironmentScope,
  VoiceConfirmationId,
  VoiceConversationId,
  VoiceRequestId,
  type VoiceConversationSummary,
  VoiceSessionId,
  VoiceToolCallId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { VoiceContextCompiler } from "../Services/VoiceContextCompiler.ts";
import { VoiceConversationService } from "../Services/VoiceConversationService.ts";
import type { RealtimeProviderSession, VoiceProviderAdapter } from "../Services/VoiceProvider.ts";
import { voiceProviderRegistryLayer } from "../Services/VoiceProviderRegistry.ts";
import { VoiceSessionRegistryLive } from "../Services/VoiceSessionRegistry.ts";
import {
  VoiceMediaTicketRegistry,
  VoiceMediaTicketRegistryLive,
} from "../Services/VoiceMediaTicketRegistry.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";
import { VoiceToolExecutor } from "../Services/VoiceToolExecutor.ts";
import { VoiceSessionServiceLive } from "./VoiceSessionService.ts";

const conversationId = VoiceConversationId.make("conversation-test");
const summary: VoiceConversationSummary = {
  conversationId,
  retention: "ephemeral",
  title: null,
  activeEpoch: 1,
  createdAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-10T12:00:00.000Z",
};

const input = (takeover: boolean, idempotencyKey: string) => ({
  mode: "realtime-agent" as const,
  conversation: { type: "continue" as const, conversationId, takeover },
  media: {
    transports: ["webrtc-sdp-v1" as const],
    audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1" as const],
    supportsInputRouteSelection: true,
    supportsOutputRouteSelection: true,
  },
  idempotencyKey,
});

const principal = (
  sessionId: AuthSessionId,
  scopes: ReadonlySet<AuthEnvironmentScope> = new Set([
    AuthVoiceUseScope,
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
  ]),
) => ({ sessionId, scopes });

const makeLayer = Effect.fn("test.makeVoiceSessionLayer")(function* (
  provider: VoiceProviderAdapter,
  toolExecutor: VoiceToolExecutor["Service"] = VoiceToolExecutor.of({
    invoke: () => Effect.die("unused"),
    decide: () => Effect.die("unused"),
    expire: () => Effect.sync(() => undefined),
    discardSession: () => Effect.void,
  }),
  voiceSettings: { readonly enabled: boolean; readonly maxConcurrentSessions: number } = {
    enabled: true,
    maxConcurrentSessions: 16,
  },
) {
  const appended = yield* Ref.make<Array<{ readonly kind: string; readonly payload: unknown }>>([]);
  const conversations = VoiceConversationService.of({
    create: () => Effect.succeed(summary),
    listDurable: Effect.succeed([]),
    get: () => Effect.succeed(Option.some(summary)),
    delete: () => Effect.succeed(true),
    clearContext: () =>
      Effect.succeed({
        conversationId,
        activeEpoch: 2,
        clearedAt: "2026-07-10T12:01:00.000Z",
      }),
    listContext: () => Effect.succeed([]),
    appendContext: (entry) =>
      Ref.update(appended, (entries) => [...entries, entry]).pipe(
        Effect.as({
          entryId: "entry-test",
          conversationId,
          epoch: 1,
          sequence: 1,
          kind: entry.kind,
          payload: entry.payload,
          occurredAt: "2026-07-10T12:00:00.000Z",
        }),
      ),
    appendContextIdempotent: (entry) =>
      Ref.update(appended, (entries) => [...entries, entry]).pipe(
        Effect.as({
          entryId: entry.entryId,
          conversationId,
          epoch: 1,
          sequence: 1,
          kind: entry.kind,
          payload: entry.payload,
          occurredAt: "2026-07-10T12:00:00.000Z",
        }),
      ),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(VoiceConversationService, conversations),
    Layer.succeed(VoiceContextCompiler, {
      compile: () => Effect.succeed({ items: [], includedThroughSequence: 0, estimatedTokens: 0 }),
    }),
    voiceProviderRegistryLayer([provider], new Map([["agent.realtime", provider.id]])),
    VoiceSessionRegistryLive.pipe(Layer.provide(NodeServices.layer)),
    VoiceMediaTicketRegistryLive.pipe(Layer.provide(NodeServices.layer)),
    serverSettingsLayerTest({ voice: voiceSettings }),
    Layer.succeed(VoiceToolExecutor, toolExecutor),
  );
  return {
    appended,
    layer: VoiceSessionServiceLive.pipe(Layer.provideMerge(dependencies)),
  };
});

it.effect(
  "negotiates, normalizes events, journals final transcripts, and closes exactly once",
  () =>
    Effect.gen(function* () {
      const terminated = yield* Ref.make(0);
      const provider: VoiceProviderAdapter = {
        id: "fake",
        capabilities: new Set(["agent.realtime"]),
        realtime: {
          negotiate: (request) =>
            Effect.succeed({
              answer: {
                sessionId: request.sessionId,
                leaseGeneration: request.leaseGeneration,
                sdp: "fake-answer",
              },
              events: Stream.fromIterable([
                { type: "activity", activity: "listening" } as const,
                { type: "transcript", role: "user", text: "show threads", final: true } as const,
              ]),
              submitToolOutput: () => Effect.void,
              terminate: Ref.update(terminated, (count) => count + 1),
            }),
        },
      };
      const test = yield* makeLayer(provider);
      yield* Effect.gen(function* () {
        const sessions = yield* VoiceSessionService;
        const owner = AuthSessionId.make("phone");
        const created = yield* sessions.create(principal(owner), input(false, "create-one"));
        const retried = yield* sessions.create(principal(owner), input(false, "create-one"));
        expect(retried.state.sessionId).toBe(created.state.sessionId);
        const answer = yield* sessions.offer(owner, created.state.sessionId, {
          sessionId: created.state.sessionId,
          leaseGeneration: created.state.leaseGeneration,
          sdp: "fake-offer",
        });
        expect(answer.sdp).toBe("fake-answer");
        yield* Effect.yieldNow;
        const snapshot = yield* sessions.events(owner, created.state.sessionId, 0, 0);
        expect(snapshot.events.some((event) => event.type === "transcript" && event.final)).toBe(
          true,
        );
        expect(yield* Ref.get(test.appended)).toHaveLength(1);
        const closed = yield* sessions.close(
          owner,
          created.state.sessionId,
          created.state.leaseGeneration,
        );
        expect(closed.closed).toBe(true);
        expect(closed.state.phase).toBe("ended");
        const repeated = yield* sessions.close(
          owner,
          created.state.sessionId,
          created.state.leaseGeneration,
        );
        expect(repeated.closed).toBe(false);
        expect(yield* Ref.get(terminated)).toBe(1);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("takeover fences an in-flight negotiation and terminates its late provider call", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<RealtimeProviderSession>();
    const negotiationStarted = yield* Deferred.make<void>();
    const terminated = yield* Ref.make(0);
    const provider: VoiceProviderAdapter = {
      id: "fake-delayed",
      capabilities: new Set(["agent.realtime"]),
      realtime: {
        negotiate: () =>
          Deferred.succeed(negotiationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
          ),
      },
    };
    const test = yield* makeLayer(provider);
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const firstOwner = AuthSessionId.make("phone");
      const secondOwner = AuthSessionId.make("desktop");
      const first = yield* sessions.create(principal(firstOwner), input(false, "first"));
      const offering = yield* sessions
        .offer(firstOwner, first.state.sessionId, {
          sessionId: first.state.sessionId,
          leaseGeneration: first.state.leaseGeneration,
          sdp: "offer",
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(negotiationStarted);
      const replacement = yield* sessions.create(principal(secondOwner), input(true, "second"));
      expect(replacement.state.leaseGeneration).toBe(2);
      yield* Deferred.succeed(gate, {
        answer: {
          sessionId: VoiceSessionId.make("provider-late"),
          leaseGeneration: first.state.leaseGeneration,
          sdp: "late-answer",
        },
        events: Stream.empty,
        submitToolOutput: () => Effect.void,
        terminate: Ref.update(terminated, (count) => count + 1),
      });
      const error = yield* Fiber.join(offering);
      expect(error.reason).toBe("lease-conflict");
      expect(yield* Ref.get(terminated)).toBe(1);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("expires a session after three missed heartbeat intervals", () =>
  Effect.gen(function* () {
    const provider: VoiceProviderAdapter = {
      id: "fake-heartbeat",
      capabilities: new Set(["agent.realtime"]),
      realtime: { negotiate: () => Effect.die("unused") },
    };
    const test = yield* makeLayer(provider);
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const owner = AuthSessionId.make("phone-heartbeat");
      const created = yield* sessions.create(principal(owner), input(false, "heartbeat"));
      yield* TestClock.adjust("31 seconds");
      yield* Effect.yieldNow;
      const snapshot = yield* sessions.events(owner, created.state.sessionId, 0, 0);
      expect(snapshot.state.phase).toBe("ended");
      expect(snapshot.events.some((event) => event.type === "error")).toBe(true);
      const heartbeatError = yield* sessions
        .heartbeat(owner, created.state.sessionId, created.state.leaseGeneration)
        .pipe(Effect.flip);
      expect(heartbeatError.reason).toBe("invalid-phase");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("publishes confirmations and submits decided tool output to the provider", () =>
  Effect.gen(function* () {
    const outputs = yield* Ref.make<
      Array<{ readonly providerFunctionCallId: string; readonly output: string }>
    >([]);
    const capturedScopes = yield* Ref.make<ReadonlySet<AuthEnvironmentScope>>(new Set());
    const confirmationId = VoiceConfirmationId.make("confirmation-one");
    const toolCallId = VoiceToolCallId.make("provider-call-one");
    const provider: VoiceProviderAdapter = {
      id: "fake-tools",
      capabilities: new Set(["agent.realtime"]),
      realtime: {
        negotiate: (request) =>
          Effect.succeed({
            answer: {
              sessionId: request.sessionId,
              leaseGeneration: request.leaseGeneration,
              sdp: "fake-answer",
            },
            events: Stream.make({
              type: "function-call" as const,
              providerFunctionCallId: "provider-call-one",
              name: "archive_thread",
              argumentsJson: '{"threadId":"thread-one"}',
            }),
            submitToolOutput: (output) => Ref.update(outputs, (all) => [...all, output]),
            terminate: Effect.void,
          }),
      },
    };
    const executor = VoiceToolExecutor.of({
      invoke: (toolCall) =>
        Ref.set(capturedScopes, toolCall.grantedScopes).pipe(
          Effect.as({
            type: "confirmation-required" as const,
            confirmationId,
            toolCallId,
            providerFunctionCallId: toolCall.providerFunctionCallId,
            tool: "archive_thread" as const,
            summary: "Archive thread Voice implementation",
            expiresAt: "2099-01-01T00:00:00.000Z",
            newlyCreated: true,
          }),
        ),
      decide: () =>
        Effect.succeed({
          type: "completed" as const,
          toolCallId,
          providerFunctionCallId: "provider-call-one",
          tool: "archive_thread" as const,
          outcome: "succeeded" as const,
          output: '{"sequence":42}',
          submitOutput: true,
        }),
      expire: () => Effect.sync(() => undefined),
      discardSession: () => Effect.void,
    });
    const test = yield* makeLayer(provider, executor);
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const owner = AuthSessionId.make("phone-tools");
      const created = yield* sessions.create(principal(owner), input(false, "tools"));
      yield* sessions.offer(owner, created.state.sessionId, {
        sessionId: created.state.sessionId,
        leaseGeneration: created.state.leaseGeneration,
        sdp: "offer",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const before = yield* sessions.events(owner, created.state.sessionId, 0, 0);
      expect(before.state.phase).toBe("confirming");
      expect(before.events.some((event) => event.type === "confirmation-required")).toBe(true);
      expect([...(yield* Ref.get(capturedScopes))]).toEqual([
        AuthVoiceUseScope,
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
      ]);
      const decision = yield* sessions.confirm(owner, created.state.sessionId, confirmationId, {
        decision: "approve",
      });
      expect(decision.outcome).toBe("approved");
      expect(yield* Ref.get(outputs)).toEqual([
        { providerFunctionCallId: "provider-call-one", output: '{"sequence":42}' },
      ]);
      const after = yield* sessions.events(owner, created.state.sessionId, 0, 0);
      expect(after.state.phase).toBe("idle");
      expect(
        after.events.some((event) => event.type === "tool" && event.outcome === "approved"),
      ).toBe(true);
      expect(
        after.events.some((event) => event.type === "tool" && event.outcome === "succeeded"),
      ).toBe(true);
    }).pipe(Effect.provide(test.layer));
  }),
);

const unusedProvider: VoiceProviderAdapter = {
  id: "fake-unused",
  capabilities: new Set(["agent.realtime"]),
  realtime: { negotiate: () => Effect.die("unused") },
};

it.effect("rejects session creation when voice is disabled", () =>
  Effect.gen(function* () {
    const test = yield* makeLayer(unusedProvider, undefined, {
      enabled: false,
      maxConcurrentSessions: 1,
    });
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const result = yield* sessions
        .create(principal(AuthSessionId.make("disabled-owner")), input(false, "disabled"))
        .pipe(Effect.flip);
      expect(result.reason).toBe("disabled");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("atomically enforces the concurrent session limit", () =>
  Effect.gen(function* () {
    const test = yield* makeLayer(unusedProvider, undefined, {
      enabled: true,
      maxConcurrentSessions: 1,
    });
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const owner = AuthSessionId.make("limited-owner");
      const results = yield* Effect.all(
        [
          sessions.create(principal(owner), input(false, "concurrent-one")).pipe(Effect.result),
          sessions.create(principal(owner), input(false, "concurrent-two")).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const failures = results.filter(Result.isFailure);
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.failure.reason).toBe("quota-exceeded");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("wakes a bounded event wait when the session changes", () =>
  Effect.gen(function* () {
    const test = yield* makeLayer(unusedProvider);
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const owner = AuthSessionId.make("waiting-owner");
      const created = yield* sessions.create(principal(owner), input(false, "waiting"));
      const waiting = yield* sessions
        .events(owner, created.state.sessionId, 0, 20_000)
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* sessions.close(owner, created.state.sessionId, created.state.leaseGeneration);
      const result = yield* Fiber.join(waiting);
      expect(result.state.phase).toBe("ended");
      expect(result.events.some((event) => event.type === "state" && event.phase === "ended")).toBe(
        true,
      );
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("revokes provider sessions and media tickets with their auth session", () =>
  Effect.gen(function* () {
    const terminated = yield* Ref.make(0);
    const provider: VoiceProviderAdapter = {
      id: "fake-revocation",
      capabilities: new Set(["agent.realtime"]),
      realtime: {
        negotiate: (request) =>
          Effect.succeed({
            answer: {
              sessionId: request.sessionId,
              leaseGeneration: request.leaseGeneration,
              sdp: "answer",
            },
            events: Stream.empty,
            submitToolOutput: () => Effect.void,
            terminate: Ref.update(terminated, (count) => count + 1),
          }),
      },
    };
    const test = yield* makeLayer(provider);
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const mediaTickets = yield* VoiceMediaTicketRegistry;
      const owner = AuthSessionId.make("revoked-owner");
      const created = yield* sessions.create(principal(owner), input(false, "revoked"));
      yield* sessions.offer(owner, created.state.sessionId, {
        sessionId: created.state.sessionId,
        leaseGeneration: created.state.leaseGeneration,
        sdp: "offer",
      });
      const ticket = yield* mediaTickets.issue({
        authSessionId: owner,
        operation: "voice-heartbeat",
        requestId: VoiceRequestId.make("revoked-request"),
        voiceSessionId: created.state.sessionId,
      });
      yield* sessions.revokeAuthSession(owner);
      expect(yield* Ref.get(terminated)).toBe(1);
      expect((yield* sessions.get(owner, created.state.sessionId)).phase).toBe("ended");
      expect(yield* mediaTickets.consume(ticket.token, "voice-heartbeat")).toBeUndefined();
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("terminates an active call before clearing or deleting its conversation", () =>
  Effect.gen(function* () {
    const terminated = yield* Ref.make(0);
    const provider: VoiceProviderAdapter = {
      id: "fake-reset",
      capabilities: new Set(["agent.realtime"]),
      realtime: {
        negotiate: (request) =>
          Effect.succeed({
            answer: {
              sessionId: request.sessionId,
              leaseGeneration: request.leaseGeneration,
              sdp: "answer",
            },
            events: Stream.empty,
            submitToolOutput: () => Effect.void,
            terminate: Ref.update(terminated, (count) => count + 1),
          }),
      },
    };
    const test = yield* makeLayer(provider);
    yield* Effect.gen(function* () {
      const sessions = yield* VoiceSessionService;
      const owner = AuthSessionId.make("reset-owner");
      const clearing = yield* sessions.create(principal(owner), input(false, "clear-context"));
      yield* sessions.offer(owner, clearing.state.sessionId, {
        sessionId: clearing.state.sessionId,
        leaseGeneration: clearing.state.leaseGeneration,
        sdp: "offer",
      });
      const cleared = yield* sessions.clearConversationContext(conversationId);
      expect(cleared.activeEpoch).toBe(2);
      expect((yield* sessions.get(owner, clearing.state.sessionId)).phase).toBe("ended");

      const deleting = yield* sessions.create(
        principal(owner),
        input(false, "delete-conversation"),
      );
      yield* sessions.offer(owner, deleting.state.sessionId, {
        sessionId: deleting.state.sessionId,
        leaseGeneration: deleting.state.leaseGeneration,
        sdp: "offer",
      });
      expect(yield* sessions.deleteConversation(conversationId)).toBe(true);
      const deletedSession = yield* sessions.get(owner, deleting.state.sessionId).pipe(Effect.flip);
      expect(deletedSession.reason).toBe("session-not-found");
      expect(yield* Ref.get(terminated)).toBe(2);
    }).pipe(Effect.provide(test.layer));
  }),
);

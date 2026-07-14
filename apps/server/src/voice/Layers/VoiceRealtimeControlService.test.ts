import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceNativeRuntimeId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import {
  VoiceNativeRealtimeStartRepository,
  type PersistedVoiceNativeRealtimeStart,
} from "../../persistence/Services/VoiceNativeRealtimeStarts.ts";
import {
  VoiceRealtimeTransitionGrantRepository,
  type PersistedVoiceRealtimeTransitionGrant,
} from "../../persistence/Services/VoiceRealtimeTransitionGrants.ts";
import { VoiceError } from "../Errors.ts";
import { VoiceNativeControlGrantRegistry } from "../Services/VoiceNativeControlGrantRegistry.ts";
import { VoiceNativeRuntimeGrantRegistry } from "../Services/VoiceNativeRuntimeGrantRegistry.ts";
import type { VoiceNativeRuntimeGrantScope } from "../Services/VoiceNativeRuntimeGrantRegistry.ts";
import { VoiceRealtimeControlService } from "../Services/VoiceRealtimeControlService.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";
import { VoiceRealtimeControlServiceLive } from "./VoiceRealtimeControlService.ts";

const runtimeId = VoiceRuntimeId.make("runtime-one");
const nativeRuntimeId = VoiceNativeRuntimeId.make("runtime-one");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("instance-one");
const modeSessionId = VoiceModeSessionId.make("mode-one");
const sessionId = VoiceSessionId.make("session-one");
const authSessionId = AuthSessionId.make("auth-one");
const conversationId = VoiceConversationId.make("conversation-one");
const expiresAt = Date.parse("2099-01-01T00:00:00.000Z");
const runtimeToken = "runtime-token";
const controlToken = "control-token";

const createInput = {
  runtimeId,
  runtimeInstanceId,
  generation: 3,
  modeSessionId,
  clientOperationId: "start-one",
} as const;

const fence = {
  runtimeId,
  runtimeInstanceId,
  generation: 3,
  modeSessionId,
  leaseGeneration: 7,
} as const;

const handoffExchangeInput = {
  ...fence,
  clientOperationId: "handoff-exchange",
  actionSequence: 6,
  nextGeneration: 4,
  threadModeSessionId: VoiceModeSessionId.make("thread-mode-one"),
  environmentId: EnvironmentId.make("environment-one"),
  speechPreset: "default" as const,
  endpointPolicy: {
    endSilenceMs: 2_200,
    noSpeechTimeoutMs: null,
    maximumUtteranceMs: 600_000,
  },
  speechEnabled: true,
  rearmGuardMs: 500,
} as const;

const makeFixture = Effect.gen(function* () {
  const createCalls = yield* Ref.make(0);
  const resumeCalls = yield* Ref.make(0);
  const offerCalls = yield* Ref.make(0);
  const focusCalls = yield* Ref.make(0);
  const closeCalls = yield* Ref.make(0);
  const ackCalls = yield* Ref.make<Array<string>>([]);
  const handoffPending = yield* Ref.make(true);
  const startRecord = yield* Ref.make<PersistedVoiceNativeRealtimeStart | undefined>(undefined);
  const transitionRecord = yield* Ref.make<PersistedVoiceRealtimeTransitionGrant | undefined>(
    undefined,
  );
  const activatedTransitions = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const transitionActivated = yield* Ref.make(false);
  const crashAfterTransitionActivation = yield* Ref.make(false);
  const handoffAcknowledgementFailure = yield* Ref.make<VoiceError | undefined>(undefined);
  const reconciledHandoffs = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const controlCapabilities = yield* Ref.make<
    ReadonlySet<"session-control" | "handoff-actions" | "webrtc-signaling" | "session-close">
  >(new Set(["session-control", "handoff-actions", "webrtc-signaling", "session-close"]));

  const runtimeGrant: VoiceNativeRuntimeGrantScope = {
    authSessionId,
    runtimeId: nativeRuntimeId,
    generation: 3,
    provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-one"),
    grantedScopes: new Set(),
    target: {
      mode: "realtime" as const,
      conversation: { type: "continue" as const, conversationId },
      focus: { type: "none" as const },
    },
    expiresAt,
  };
  const controlGrant = {
    authSessionId,
    sessionId,
    leaseGeneration: 7,
    expiresAt,
    runtimeId: nativeRuntimeId,
    runtimeGeneration: 3,
  };
  const state = {
    sessionId,
    conversationId,
    mode: "realtime-agent" as const,
    phase: "listening" as const,
    leaseGeneration: 7,
    sequence: 6,
  };
  const createResult = {
    state: { ...state, phase: "signaling" as const, sequence: 0 },
    transport: { kind: "webrtc-sdp-v1" as const, signalingPath: "/legacy" },
    expiresAt: "2099-01-01T00:00:00.000Z",
    heartbeatIntervalSeconds: 10,
    nativeControlGrant: {
      token: controlToken,
      sessionId,
      leaseGeneration: 7,
      expiresAt: "2099-01-01T00:00:00.000Z",
      heartbeatIntervalSeconds: 10,
      failureGraceSeconds: 30,
    },
  };
  const actionOne = VoiceClientActionId.make("action-one");
  const actionTwo = VoiceClientActionId.make("action-two");
  const handoffAction = VoiceClientActionId.make("handoff-one");
  const events = [
    {
      type: "client-action" as const,
      action: "activate-thread" as const,
      actionId: actionOne,
      projectId: ProjectId.make("project-one"),
      threadId: ThreadId.make("thread-one"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      sessionId,
      leaseGeneration: 7,
      sequence: 2,
      occurredAt: "2026-07-14T00:00:00.000Z",
    },
    {
      type: "client-action" as const,
      action: "activate-thread" as const,
      actionId: actionTwo,
      projectId: ProjectId.make("project-two"),
      threadId: ThreadId.make("thread-two"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      sessionId,
      leaseGeneration: 7,
      sequence: 4,
      occurredAt: "2026-07-14T00:00:01.000Z",
    },
    {
      type: "client-action" as const,
      action: "handoff-to-thread-voice" as const,
      actionId: handoffAction,
      projectId: ProjectId.make("project-three"),
      threadId: ThreadId.make("thread-three"),
      autoRearm: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
      sessionId,
      leaseGeneration: 7,
      sequence: 6,
      occurredAt: "2026-07-14T00:00:02.000Z",
    },
  ];

  const startRepository = VoiceNativeRealtimeStartRepository.of({
    claim: (input) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(startRecord);
        if (current !== undefined) return { status: "existing" as const, record: current };
        const record: PersistedVoiceNativeRealtimeStart = {
          ...input,
          sessionId: null,
          leaseGeneration: null,
          failure: null,
        };
        yield* Ref.set(startRecord, record);
        return { status: "claimed" as const };
      }),
    bindSession: (_operationKey, boundSessionId, leaseGeneration) =>
      Ref.modify(startRecord, (current) => {
        if (current === undefined) return [false, current] as const;
        return [true, { ...current, sessionId: boundSessionId, leaseGeneration }] as const;
      }),
    findBySession: (candidateSessionId, now) =>
      Ref.get(startRecord).pipe(
        Effect.map((current) =>
          current?.sessionId === candidateSessionId && current.expiresAt > now
            ? current
            : undefined,
        ),
      ),
    fail: () => Effect.succeed(true),
    revokeRuntime: () => Effect.void,
    revokeAuthSession: () => Effect.void,
    purgeExpired: () => Effect.void,
  });
  const transitionRepository = VoiceRealtimeTransitionGrantRepository.of({
    claim: (input) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(transitionRecord);
        if (current === undefined) {
          const record: PersistedVoiceRealtimeTransitionGrant = {
            ...input,
            consumedAt: null,
          };
          yield* Ref.set(transitionRecord, record);
          return { status: "claimed" as const };
        }
        return current.operationKey === input.operationKey
          ? { status: "existing" as const, record: current }
          : { status: "mismatch" as const };
      }),
    findActive: () => Ref.get(transitionRecord),
    findByOperationKey: (operationKey) =>
      Ref.get(transitionRecord).pipe(
        Effect.map((current) => (current?.operationKey === operationKey ? current : undefined)),
      ),
    consume: (tokenHash, now) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(transitionRecord);
        if (current === undefined || current.tokenHash !== tokenHash)
          return { status: "missing" as const };
        if (current.consumedAt !== null) return { status: "already-consumed" as const };
        const consumed = { ...current, consumedAt: now };
        yield* Ref.set(transitionRecord, consumed);
        return { status: "consumed" as const, record: consumed };
      }),
    revoke: () => Ref.set(transitionRecord, undefined),
    purgeExpired: () => Effect.void,
  });
  const sessions = Layer.mock(VoiceSessionService)({
    create: () => Ref.update(createCalls, (count) => count + 1).pipe(Effect.as(createResult)),
    resumeCreate: () => Ref.update(resumeCalls, (count) => count + 1).pipe(Effect.as(createResult)),
    offer: () =>
      Ref.update(offerCalls, (count) => count + 1).pipe(
        Effect.as({ sessionId, leaseGeneration: 7, sdp: "answer" }),
      ),
    heartbeat: () => Effect.succeed(state),
    events: (_owner, _sessionId, afterSequence) =>
      Effect.succeed({
        state,
        events: events.filter((event) => event.sequence > afterSequence),
      }),
    acknowledgeClientAction: (_owner, _sessionId, actionId) =>
      Ref.update(ackCalls, (ids) => [...ids, actionId]).pipe(
        Effect.as({
          actionId,
          action: "activate-thread" as const,
          outcome: "succeeded" as const,
        }),
      ),
    updateFocus: (_owner, _sessionId, input) =>
      Ref.update(focusCalls, (count) => count + 1).pipe(
        Effect.as({
          state,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        }),
      ),
    listPendingHandoffActions: () =>
      Ref.get(handoffPending).pipe(
        Effect.map((pending) =>
          pending
            ? [
                {
                  actionId: handoffAction,
                  sessionId,
                  leaseGeneration: 7,
                  projectId: ProjectId.make("project-three"),
                  threadId: ThreadId.make("thread-three"),
                  autoRearm: true,
                  expiresAt: "2099-01-01T00:00:00.000Z",
                },
              ]
            : [],
        ),
      ),
    acknowledgeNativeHandoffAction: (_owner, _sessionId, _generation, actionId) =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(handoffAcknowledgementFailure);
        if (failure !== undefined) return yield* failure;
        yield* Ref.set(handoffPending, false);
        return {
          actionId,
          action: "handoff-to-thread-voice" as const,
          outcome: "succeeded" as const,
        };
      }),
    reconcileActivatedNativeHandoff: (owner, recoveredSessionId, generation, actionId, target) =>
      Ref.update(reconciledHandoffs, (all) => [
        ...all,
        { owner, sessionId: recoveredSessionId, generation, actionId, target },
      ]).pipe(
        Effect.as({
          actionId,
          action: "handoff-to-thread-voice" as const,
          outcome: "succeeded" as const,
        }),
      ),
    close: () =>
      Ref.update(closeCalls, (count) => count + 1).pipe(
        Effect.as({
          state: { ...state, phase: "ended" as const },
          closed: true,
        }),
      ),
    confirm: () => Effect.die("unused"),
  });
  const layer = VoiceRealtimeControlServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          VoiceNativeRuntimeGrantRegistry,
          VoiceNativeRuntimeGrantRegistry.of({
            issue: () => Effect.die("unused"),
            authorize: (token) => Effect.succeed(token === runtimeToken ? runtimeGrant : undefined),
            activateTransition: (_token, input) =>
              Effect.gen(function* () {
                if (yield* Ref.get(transitionActivated)) {
                  return { expiresAt, replayed: true } as const;
                }
                yield* Ref.set(transitionActivated, true);
                yield* Ref.update(activatedTransitions, (entries) => [...entries, input]);
                yield* Ref.set(controlCapabilities, new Set(["session-close"]));
                if (yield* Ref.getAndSet(crashAfterTransitionActivation, false)) {
                  return yield* Effect.die("simulated crash after transition activation");
                }
                return { expiresAt, replayed: false } as const;
              }),
            revokeRuntime: () => Effect.succeed(false),
            revokeAuthSession: () => Effect.void,
          }),
        ),
        Layer.succeed(
          VoiceNativeControlGrantRegistry,
          VoiceNativeControlGrantRegistry.of({
            issue: () => Effect.die("unused"),
            authorize: (token) =>
              token === controlToken
                ? Ref.get(controlCapabilities).pipe(
                    Effect.map((capabilities) => ({
                      ...controlGrant,
                      capabilities,
                    })),
                  )
                : Effect.succeed(undefined),
            revokeSession: () => Effect.void,
            releaseSessionControl: () => Effect.void,
            completeHandoff: () => Effect.void,
            revokeRuntime: () => Effect.void,
            revokeAuthSession: () => Effect.void,
          }),
        ),
        Layer.succeed(VoiceNativeRealtimeStartRepository, startRepository),
        Layer.succeed(VoiceRealtimeTransitionGrantRepository, transitionRepository),
        Layer.succeed(ServerSecretStore, {
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(9)),
        } as unknown as ServerSecretStore["Service"]),
        sessions,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    refs: {
      createCalls,
      resumeCalls,
      offerCalls,
      focusCalls,
      closeCalls,
      ackCalls,
      handoffPending,
      startRecord,
      transitionRecord,
      activatedTransitions,
      transitionActivated,
      crashAfterTransitionActivation,
      handoffAcknowledgementFailure,
      reconciledHandoffs,
      controlCapabilities,
    },
    ids: { actionOne, actionTwo, handoffAction },
  };
});

describe("VoiceRealtimeControlService", () => {
  it.effect("replays start and child mutations without duplicating provider work", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        const first = yield* service.create(runtimeToken, createInput);
        const second = yield* service.create(runtimeToken, createInput);
        expect(first.transport.signalingPath).toBe(
          `/api/voice/runtime/realtime-sessions/${sessionId}/webrtc-offer`,
        );
        expect(second.state.sessionId).toBe(sessionId);
        const offerInput = {
          ...fence,
          clientOperationId: "offer-one",
          sdp: "offer",
        } as const;
        expect((yield* service.offer(controlToken, sessionId, offerInput)).replayed).toBe(false);
        expect((yield* service.offer(controlToken, sessionId, offerInput)).replayed).toBe(true);
        const focusInput = {
          ...fence,
          clientOperationId: "focus-one",
          focus: { projectId: ProjectId.make("project-one"), threadId: null },
        } as const;
        expect((yield* service.updateFocus(controlToken, sessionId, focusInput)).replayed).toBe(
          false,
        );
        expect((yield* service.updateFocus(controlToken, sessionId, focusInput)).replayed).toBe(
          true,
        );
      }).pipe(Effect.provide(fixture.layer));
      expect(yield* Ref.get(fixture.refs.createCalls)).toBe(1);
      expect(yield* Ref.get(fixture.refs.resumeCalls)).toBe(1);
      expect(yield* Ref.get(fixture.refs.offerCalls)).toBe(1);
      expect(yield* Ref.get(fixture.refs.focusCalls)).toBe(1);
    }),
  );

  it.effect("rejects stale runtime instances and generations before provider mutation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
        for (const candidate of [
          {
            ...fence,
            runtimeInstanceId: VoiceRuntimeInstanceId.make("stale-instance"),
          },
          { ...fence, generation: 2 },
        ]) {
          const result = yield* service
            .offer(controlToken, sessionId, {
              ...candidate,
              clientOperationId: `stale-${candidate.generation}-${candidate.runtimeInstanceId}`,
              sdp: "offer",
            })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }
      }).pipe(Effect.provide(fixture.layer));
      expect(yield* Ref.get(fixture.refs.offerCalls)).toBe(0);
    }),
  );

  it.effect("reconstructs an exact persisted binding to close after process restart", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
      }).pipe(Effect.provide(fixture.layer));

      const restarted = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.close(controlToken, sessionId, {
          ...fence,
          clientOperationId: "restart-close",
        });
      }).pipe(Effect.provide(fixture.layer));
      expect(restarted).toMatchObject({ closed: true, replayed: false });
      expect(yield* Ref.get(fixture.refs.closeCalls)).toBe(1);
    }),
  );

  it.effect("rejects stale reconstructed runtime and mode identities", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
      }).pipe(Effect.provide(fixture.layer));

      for (const [clientOperationId, candidate] of [
        [
          "stale-restart-instance",
          {
            ...fence,
            runtimeInstanceId: VoiceRuntimeInstanceId.make("stale-instance"),
          },
        ],
        ["stale-restart-mode", { ...fence, modeSessionId: VoiceModeSessionId.make("stale-mode") }],
      ] as const) {
        const result = yield* Effect.gen(function* () {
          const service = yield* VoiceRealtimeControlService;
          return yield* service
            .close(controlToken, sessionId, { ...candidate, clientOperationId })
            .pipe(Effect.result);
        }).pipe(Effect.provide(fixture.layer));
        expect(result._tag).toBe("Failure");
      }
      expect(yield* Ref.get(fixture.refs.closeCalls)).toBe(0);
    }),
  );

  it.effect("rejects persisted auth and lease mismatches after process restart", () =>
    Effect.gen(function* () {
      for (const [name, corrupt] of [
        [
          "auth",
          (record: PersistedVoiceNativeRealtimeStart) => ({
            ...record,
            authSessionId: AuthSessionId.make("different-auth"),
          }),
        ],
        [
          "lease",
          (record: PersistedVoiceNativeRealtimeStart) => ({
            ...record,
            leaseGeneration: 8,
          }),
        ],
      ] as const) {
        const fixture = yield* makeFixture;
        yield* Effect.gen(function* () {
          const service = yield* VoiceRealtimeControlService;
          yield* service.create(runtimeToken, createInput);
        }).pipe(Effect.provide(fixture.layer));
        yield* Ref.update(fixture.refs.startRecord, (record) =>
          record === undefined ? undefined : corrupt(record),
        );

        const result = yield* Effect.gen(function* () {
          const service = yield* VoiceRealtimeControlService;
          return yield* service
            .close(controlToken, sessionId, {
              ...fence,
              clientOperationId: `restart-corrupt-${name}`,
            })
            .pipe(Effect.result);
        }).pipe(Effect.provide(fixture.layer));
        expect(result._tag).toBe("Failure");
        expect(yield* Ref.get(fixture.refs.closeCalls)).toBe(0);
      }
    }),
  );

  it.effect("performs a first handoff after reconstructing the binding on process restart", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
      }).pipe(Effect.provide(fixture.layer));

      const result = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          handoffExchangeInput,
        );
      }).pipe(Effect.provide(fixture.layer));
      expect(result).toMatchObject({
        replayed: false,
        transitionGrant: {
          generation: 4,
          modeSessionId: "thread-mode-one",
        },
      });
      expect(yield* Ref.get(fixture.refs.activatedTransitions)).toHaveLength(1);
    }),
  );

  it.effect("acknowledges independent actions and exchanges a handoff exactly once", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const exchangeInput = handoffExchangeInput;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
        const independent = yield* service
          .acknowledgeAction(controlToken, sessionId, fixture.ids.actionTwo, {
            ...fence,
            clientOperationId: "ack-two-too-soon",
            actionSequence: 4,
            action: "navigate-thread",
            outcome: "succeeded",
          })
          .pipe(Effect.result);
        expect(independent._tag).toBe("Success");
        const first = yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          exchangeInput,
        );
        const replay = yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          exchangeInput,
        );
        expect(first.replayed).toBe(false);
        expect(replay.replayed).toBe(true);
        expect(first.transitionGrant).toMatchObject({
          generation: 4,
          modeSessionId: "thread-mode-one",
          target: {
            projectId: "project-three",
            threadId: "thread-three",
            autoRearm: true,
          },
        });
        expect(replay.transitionGrant.token).toBe(first.transitionGrant.token);
        const persisted = yield* Ref.get(fixture.refs.transitionRecord);
        expect(persisted?.tokenHash).not.toBe(first.transitionGrant.token);
        expect(persisted?.sourceControlTokenHash).not.toBe(controlToken);
        expect(persisted).toMatchObject({
          sourceSessionId: sessionId,
          sourceLeaseGeneration: 7,
          runtimeId,
          runtimeInstanceId,
          sourceGeneration: 3,
          targetGeneration: 4,
          modeSessionId: "thread-mode-one",
        });
        expect(yield* Ref.get(fixture.refs.activatedTransitions)).toEqual([
          expect.objectContaining({
            sourceGeneration: 3,
            targetGeneration: 4,
            target: expect.objectContaining({
              mode: "thread",
              threadId: "thread-three",
            }),
          }),
        ]);
        const secondIdentity = yield* service
          .exchangeHandoff(controlToken, sessionId, fixture.ids.handoffAction, {
            ...exchangeInput,
            clientOperationId: "handoff-exchange-two",
          })
          .pipe(Effect.result);
        expect(secondIdentity._tag).toBe("Failure");
      }).pipe(Effect.provide(fixture.layer));
      const restartedReplay = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          exchangeInput,
        );
      }).pipe(Effect.provide(fixture.layer));
      expect(restartedReplay.replayed).toBe(true);
      const rejectedReplay = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service
          .exchangeHandoff(
            "different-control-token",
            sessionId,
            fixture.ids.handoffAction,
            exchangeInput,
          )
          .pipe(Effect.result);
      }).pipe(Effect.provide(fixture.layer));
      expect(rejectedReplay._tag).toBe("Failure");
      expect(yield* Ref.get(fixture.refs.ackCalls)).toEqual(["action-two"]);
    }),
  );

  it.effect("reconstructs only close authority after a handoff", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
        yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          handoffExchangeInput,
        );
      }).pipe(Effect.provide(fixture.layer));
      expect([...(yield* Ref.get(fixture.refs.controlCapabilities))]).toEqual(["session-close"]);

      const heartbeat = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.heartbeat(controlToken, sessionId, fence).pipe(Effect.result);
      }).pipe(Effect.provide(fixture.layer));
      expect(heartbeat._tag).toBe("Failure");

      const closed = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.close(controlToken, sessionId, {
          ...fence,
          clientOperationId: "post-handoff-close",
        });
      }).pipe(Effect.provide(fixture.layer));
      expect(closed).toMatchObject({ closed: true, replayed: false });
      expect(yield* Ref.get(fixture.refs.closeCalls)).toBe(1);
    }),
  );

  it.effect("replays an activated handoff receipt after a crash and action expiry", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Ref.set(fixture.refs.crashAfterTransitionActivation, true);
      const crashed = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
        return yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          handoffExchangeInput,
        );
      }).pipe(Effect.provide(fixture.layer), Effect.exit);
      expect(crashed._tag).toBe("Failure");
      expect(yield* Ref.get(fixture.refs.transitionActivated)).toBe(true);
      expect(yield* Ref.get(fixture.refs.transitionRecord)).toBeDefined();
      expect(yield* Ref.get(fixture.refs.ackCalls)).toEqual([]);

      yield* Ref.set(
        fixture.refs.handoffAcknowledgementFailure,
        new VoiceError({
          reason: "invalid-phase",
          operation: "session.client-action",
          detail: "Voice handoff action has expired",
          retryable: false,
        }),
      );
      yield* Ref.set(fixture.refs.handoffPending, false);
      const replay = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          handoffExchangeInput,
        );
      }).pipe(Effect.provide(fixture.layer));

      expect(replay).toMatchObject({
        replayed: true,
        transitionGrant: {
          generation: 4,
          modeSessionId: "thread-mode-one",
          target: { projectId: "project-three", threadId: "thread-three" },
        },
      });
      expect((yield* Ref.get(fixture.refs.transitionRecord))?.consumedAt).toEqual(
        expect.any(Number),
      );
      expect(yield* Ref.get(fixture.refs.reconciledHandoffs)).toEqual([
        {
          owner: authSessionId,
          sessionId,
          generation: 7,
          actionId: fixture.ids.handoffAction,
          target: {
            projectId: ProjectId.make("project-three"),
            threadId: ThreadId.make("thread-three"),
          },
        },
      ]);
      expect(yield* Ref.get(fixture.refs.activatedTransitions)).toHaveLength(1);
      expect([...(yield* Ref.get(fixture.refs.controlCapabilities))]).toEqual(["session-close"]);

      const heartbeat = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.heartbeat(controlToken, sessionId, fence).pipe(Effect.result);
      }).pipe(Effect.provide(fixture.layer));
      expect(heartbeat._tag).toBe("Failure");

      const closed = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service.close(controlToken, sessionId, {
          ...fence,
          clientOperationId: "post-crash-handoff-close",
        });
      }).pipe(Effect.provide(fixture.layer));
      expect(closed).toMatchObject({ closed: true, replayed: false });
    }),
  );

  it.effect("does not suppress other handoff acknowledgement failures on replay", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Ref.set(fixture.refs.crashAfterTransitionActivation, true);
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
        return yield* service.exchangeHandoff(
          controlToken,
          sessionId,
          fixture.ids.handoffAction,
          handoffExchangeInput,
        );
      }).pipe(Effect.provide(fixture.layer), Effect.exit);

      yield* Ref.set(
        fixture.refs.handoffAcknowledgementFailure,
        new VoiceError({
          reason: "provider-unavailable",
          operation: "session.client-action",
          detail: "Voice handoff action could not be acknowledged",
          retryable: true,
        }),
      );
      const replay = yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        return yield* service
          .exchangeHandoff(controlToken, sessionId, fixture.ids.handoffAction, handoffExchangeInput)
          .pipe(Effect.result);
      }).pipe(Effect.provide(fixture.layer));

      expect(replay._tag).toBe("Failure");
      if (replay._tag === "Failure") {
        expect(replay.failure).toMatchObject({
          reason: "provider-unavailable",
          operation: "session.client-action",
        });
      }
      expect(yield* Ref.get(fixture.refs.activatedTransitions)).toHaveLength(1);
      expect(yield* Ref.get(fixture.refs.reconciledHandoffs)).toEqual([]);
      expect([...(yield* Ref.get(fixture.refs.controlCapabilities))]).toEqual(["session-close"]);
    }),
  );

  it.effect("closes once and replays the terminal response after child authority teardown", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const service = yield* VoiceRealtimeControlService;
        yield* service.create(runtimeToken, createInput);
        const input = { ...fence, clientOperationId: "close-one" } as const;
        expect((yield* service.close(controlToken, sessionId, input)).replayed).toBe(false);
        expect((yield* service.close(controlToken, sessionId, input)).replayed).toBe(true);
      }).pipe(Effect.provide(fixture.layer));
      expect(yield* Ref.get(fixture.refs.closeCalls)).toBe(1);
    }),
  );
});

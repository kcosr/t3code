import {
  AuthSessionId,
  VoiceClientActionId,
  VoiceRuntimeId,
  VoiceRuntimeTarget,
  type VoiceThreadRuntimeTarget,
  type VoiceRuntimeRealtimeAction,
  type VoiceRuntimeRealtimeActionAckResult,
  type VoiceRuntimeRealtimeCloseResult,
  type VoiceRuntimeRealtimeFocusResult,
  type VoiceRuntimeRealtimeHandoffCommitResult,
  type VoiceRuntimeRealtimeHandoffExchangeResult,
  type VoiceRuntimeRealtimeSessionCreateResult,
  type VoiceRuntimeRealtimeWebRtcAnswer,
  type VoiceSessionEvent,
  type VoiceSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";

import { VoiceRuntimeAuthorityRepository } from "../../persistence/Services/VoiceRuntimeAuthorities.ts";
import { VoiceRuntimeRealtimeStartRepository } from "../../persistence/Services/VoiceRuntimeRealtimeStarts.ts";
import { VoiceRealtimeTransitionReservationRepository } from "../../persistence/Services/VoiceRealtimeTransitionReservations.ts";
import { VoiceError } from "../Errors.ts";
import {
  VoiceRealtimeControlService,
  type VoiceRealtimeControlServiceShape,
} from "../Services/VoiceRealtimeControlService.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";

const START_CLAIM_MILLIS = 60_000;
const OPERATION_CACHE_TTL_MILLIS = 5 * 60_000;
const OPERATION_CACHE_LIMIT = 512;

interface SessionBinding {
  readonly authSessionId: string;
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly generation: number;
  readonly modeSessionId: string;
  readonly leaseGeneration: number;
  readonly expiresAt: number;
  readonly closeOnly: boolean;
  readonly acknowledgedActionSequences: Set<number>;
}

interface CachedOperation {
  readonly authSessionId: string;
  readonly fingerprint: string;
  readonly result: unknown;
  readonly expiresAt: number;
}

const hash = (...parts: ReadonlyArray<string | number>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("base64url");
const encodeRuntimeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceRuntimeTarget));

const operationError = (
  reason: VoiceError["reason"],
  operation: string,
  detail: string,
  retryable = false,
) => new VoiceError({ reason, operation, detail, retryable });

const canonicalFence = (input: {
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly generation: number;
  readonly modeSessionId: string;
  readonly leaseGeneration?: number;
}) =>
  [
    input.runtimeId,
    input.runtimeInstanceId,
    input.generation,
    input.modeSessionId,
    input.leaseGeneration ?? "",
  ].join("\0");

const toAction = (event: VoiceSessionEvent): VoiceRuntimeRealtimeAction | undefined => {
  if (event.type === "client-action" && event.action === "activate-thread") {
    return {
      type: "navigate-thread",
      actionId: event.actionId,
      projectId: event.projectId,
      threadId: event.threadId,
      expiresAt: event.expiresAt,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    };
  }
  if (event.type === "client-action" && event.action === "handoff-to-thread-voice") {
    return {
      type: "handoff-to-thread-voice",
      actionId: event.actionId,
      projectId: event.projectId,
      threadId: event.threadId,
      autoRearm: event.autoRearm,
      expiresAt: event.expiresAt,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    };
  }
  if (event.type === "terminal-action") {
    return {
      type: "stop-realtime-voice",
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    };
  }
  if (event.type === "confirmation-required") {
    return {
      type: "confirmation-required",
      actionId: VoiceClientActionId.make(`confirmation:${event.confirmationId}`),
      confirmationId: event.confirmationId,
      toolCallId: event.toolCallId,
      tool: event.tool,
      summary: event.summary,
      expiresAt: event.expiresAt,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    };
  }
  return undefined;
};

export const protectRealtimeStartCriticalSection = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.uninterruptible);

const make = Effect.gen(function* () {
  const runtimeAuthorities = yield* VoiceRuntimeAuthorityRepository;
  const starts = yield* VoiceRuntimeRealtimeStartRepository;
  const transitions = yield* VoiceRealtimeTransitionReservationRepository;
  const sessions = yield* VoiceSessionService;
  const mutex = yield* Semaphore.make(1);
  const bindings = new Map<string, SessionBinding>();
  const operations = new Map<string, CachedOperation>();
  const sessionMutexes = new Map<string, Semaphore.Semaphore>();

  const maintainOperationCache = (now: number): void => {
    for (const [key, cached] of operations) {
      if (cached.expiresAt <= now) operations.delete(key);
    }
    while (operations.size > OPERATION_CACHE_LIMIT) {
      const oldest = operations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      operations.delete(oldest);
    }
    const retainedSessions = new Set(
      [...operations.keys()].map((key) => key.slice(0, key.indexOf("\0"))),
    );
    for (const sessionKey of sessionMutexes.keys()) {
      if (!bindings.has(sessionKey) && !retainedSessions.has(sessionKey)) {
        sessionMutexes.delete(sessionKey);
      }
    }
  };

  const sessionMutex = (sessionId: VoiceSessionId): Effect.Effect<Semaphore.Semaphore> =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const key = String(sessionId);
        const existing = sessionMutexes.get(key);
        if (existing !== undefined) return existing;
        const created = yield* Semaphore.make(1);
        sessionMutexes.set(key, created);
        return created;
      }),
    );

  const requireControl = Effect.fn("VoiceRealtimeControlService.requireControl")(function* (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    input: {
      readonly runtimeId: string;
      readonly runtimeInstanceId: string;
      readonly generation: number;
      readonly modeSessionId: string;
      readonly leaseGeneration: number;
    },
    capability:
      | "session-control"
      | "handoff-actions"
      | "handoff-commit"
      | "webrtc-signaling"
      | "session-close",
  ) {
    const cached = bindings.get(sessionId);
    const persisted = yield* starts
      .findBySession(sessionId, yield* Clock.currentTimeMillis)
      .pipe(
        Effect.mapError((cause) =>
          operationError(
            "provider-unavailable",
            "runtime-realtime.authorize",
            `Realtime start storage is unavailable: ${String(cause)}`,
            true,
          ),
        ),
      );
    const binding =
      persisted === undefined ||
      persisted.sessionId !== sessionId ||
      persisted.leaseGeneration === null
        ? undefined
        : {
            authSessionId: String(persisted.authSessionId),
            runtimeId: String(persisted.runtimeId),
            runtimeInstanceId: String(persisted.runtimeInstanceId),
            generation: persisted.runtimeGeneration,
            modeSessionId: String(persisted.modeSessionId),
            leaseGeneration: persisted.leaseGeneration,
            expiresAt: persisted.expiresAt,
            closeOnly: persisted.closeOnly,
            acknowledgedActionSequences:
              cached?.authSessionId === persisted.authSessionId &&
              cached.runtimeId === persisted.runtimeId &&
              cached.runtimeInstanceId === persisted.runtimeInstanceId &&
              cached.generation === persisted.runtimeGeneration &&
              cached.modeSessionId === persisted.modeSessionId &&
              cached.leaseGeneration === persisted.leaseGeneration
                ? cached.acknowledgedActionSequences
                : new Set<number>(),
          };
    if (binding === undefined) bindings.delete(sessionId);
    else bindings.set(sessionId, binding);
    if (
      binding === undefined ||
      binding.authSessionId !== authSessionId ||
      // A committed handoff replay must reach consumeHandoff so it can return the
      // stored exactly-once outcome; every other post-supersession operation is close-only.
      (binding.closeOnly && capability !== "session-close" && capability !== "handoff-commit") ||
      binding.runtimeId !== input.runtimeId ||
      binding.runtimeInstanceId !== input.runtimeInstanceId ||
      binding.generation !== input.generation ||
      binding.modeSessionId !== input.modeSessionId ||
      binding.leaseGeneration !== input.leaseGeneration
    ) {
      return yield* operationError(
        "authorization-revoked",
        "runtime-realtime.authorize",
        "Realtime child authority does not match the active runtime operation",
      );
    }
    return { authSessionId, binding };
  });

  const runCached = <A>(
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    clientOperationId: string,
    fingerprint: string,
    authorize: Effect.Effect<void, VoiceError>,
    effect: Effect.Effect<A, VoiceError>,
    replay: (value: A) => A,
  ): Effect.Effect<A, VoiceError> =>
    Effect.gen(function* () {
      const sessionLock = yield* sessionMutex(sessionId);
      return yield* sessionLock.withPermits(1)(
        Effect.gen(function* () {
          yield* authorize;
          const now = yield* Clock.currentTimeMillis;
          maintainOperationCache(now);
          const key = `${sessionId}\0${clientOperationId}`;
          const existing = operations.get(key);
          if (existing !== undefined) {
            if (existing.authSessionId !== authSessionId || existing.fingerprint !== fingerprint) {
              return yield* operationError(
                "invalid-phase",
                "runtime-realtime.idempotency",
                "Realtime operation identity was reused with different input",
              );
            }
            return replay(existing.result as A);
          }
          const value = yield* effect;
          operations.set(key, {
            authSessionId,
            fingerprint,
            result: value,
            expiresAt: now + OPERATION_CACHE_TTL_MILLIS,
          });
          maintainOperationCache(now);
          return value;
        }),
      );
    });

  const create: VoiceRealtimeControlServiceShape["create"] = (principal, input) =>
    Effect.gen(function* () {
      const runtimeId = VoiceRuntimeId.make(input.runtimeId);
      const authority = yield* runtimeAuthorities
        .find(principal.sessionId, runtimeId)
        .pipe(
          Effect.mapError((cause) =>
            operationError(
              "provider-unavailable",
              "runtime-realtime.authority",
              `Runtime authority storage is unavailable: ${String(cause)}`,
              true,
            ),
          ),
        );
      if (
        authority === undefined ||
        authority.target.mode !== "realtime" ||
        authority.generation !== input.generation ||
        encodeRuntimeTarget(authority.target) !== encodeRuntimeTarget(input.target)
      ) {
        return yield* operationError(
          "authorization-revoked",
          "runtime-realtime.create",
          "Realtime runtime authority is stale or does not match the requested target",
        );
      }
      const current = yield* runtimeAuthorities
        .find(principal.sessionId, runtimeId)
        .pipe(
          Effect.mapError((cause) =>
            operationError(
              "provider-unavailable",
              "runtime-realtime.authority",
              `Runtime authority storage is unavailable: ${String(cause)}`,
              true,
            ),
          ),
        );
      if (
        current === undefined ||
        current.generation !== authority.generation ||
        encodeRuntimeTarget(current.target) !== encodeRuntimeTarget(authority.target)
      ) {
        return yield* operationError(
          "authorization-revoked",
          "runtime-realtime.create",
          "Realtime runtime authority changed during start",
        );
      }
      const operationIdentity = hash(
        input.runtimeInstanceId,
        input.modeSessionId,
        input.clientOperationId,
      );
      const operationKey = `runtime-realtime:${hash(
        principal.sessionId,
        runtimeId,
        authority.generation,
        operationIdentity,
      )}`;
      const createInput = {
        mode: "realtime-agent" as const,
        conversation: {
          type: "continue" as const,
          conversationId: authority.target.conversationId,
          takeover: false,
        },
        media: {
          transports: ["webrtc-sdp-v1" as const],
          audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1" as const],
          supportsInputRouteSelection: true,
          supportsOutputRouteSelection: true,
        },
        idempotencyKey: operationKey,
      };
      const now = yield* Clock.currentTimeMillis;
      const claimed = yield* starts
        .claim({
          operationKey,
          authSessionId: principal.sessionId,
          runtimeId,
          runtimeInstanceId: input.runtimeInstanceId,
          runtimeGeneration: authority.generation,
          modeSessionId: input.modeSessionId,
          clientOperationId: operationIdentity,
          conversationId: authority.target.conversationId,
          claimExpiresAt: now + START_CLAIM_MILLIS,
          expiresAt: now + 55 * 60_000,
          now,
        })
        .pipe(
          Effect.mapError((cause) =>
            operationError(
              "provider-unavailable",
              "runtime-realtime.create",
              `Realtime start storage is unavailable: ${String(cause)}`,
              true,
            ),
          ),
        );
      if (claimed.status === "mismatch") {
        return yield* operationError(
          "invalid-phase",
          "runtime-realtime.create",
          "Realtime start identity was reused with different input",
        );
      }
      if (claimed.status === "existing" && claimed.record.failure !== null) {
        return yield* new VoiceError(claimed.record.failure);
      }
      if (claimed.status === "existing" && claimed.record.sessionId === null) {
        const pending = now <= claimed.record.claimExpiresAt;
        return yield* operationError(
          pending ? "lease-conflict" : "session-not-found",
          "runtime-realtime.create",
          pending
            ? "The original Realtime start is still pending"
            : "The original Realtime start did not create a session",
          pending,
        );
      }
      const existingSessionId =
        claimed.status === "existing" ? (claimed.record.sessionId ?? undefined) : undefined;
      const sessionPrincipal = {
        sessionId: principal.sessionId,
        scopes: principal.scopes,
        runtimeAuthority: {
          runtimeId,
          generation: authority.generation,
        },
      };
      const created = yield* (
        existingSessionId === undefined
          ? sessions.create(sessionPrincipal, createInput)
          : sessions.resumeCreate(sessionPrincipal, createInput, existingSessionId)
      ).pipe(Effect.result);
      if (Result.isFailure(created)) {
        if (claimed.status === "claimed") {
          yield* starts
            .fail(
              operationKey,
              {
                reason: created.failure.reason,
                operation: created.failure.operation,
                detail: created.failure.detail,
                retryable: created.failure.retryable,
              },
              yield* Clock.currentTimeMillis,
            )
            .pipe(Effect.ignore);
        }
        return yield* created.failure;
      }
      if (
        claimed.status === "existing" &&
        claimed.record.leaseGeneration !== created.success.state.leaseGeneration
      ) {
        return yield* operationError(
          "authorization-revoked",
          "runtime-realtime.create",
          "The persisted Realtime lease no longer matches the resident session",
        );
      }
      if (claimed.status === "claimed") {
        const bound = yield* starts
          .bindSession(
            operationKey,
            created.success.state.sessionId,
            created.success.state.leaseGeneration,
            yield* Clock.currentTimeMillis,
          )
          .pipe(
            Effect.mapError((cause) =>
              operationError(
                "provider-unavailable",
                "runtime-realtime.create",
                `Realtime start storage is unavailable: ${String(cause)}`,
                true,
              ),
            ),
          );
        if (!bound) {
          yield* sessions
            .close(
              principal.sessionId,
              created.success.state.sessionId,
              created.success.state.leaseGeneration,
            )
            .pipe(Effect.ignore);
          return yield* operationError(
            "provider-unavailable",
            "runtime-realtime.create",
            "Realtime start could not be durably bound to its session",
            true,
          );
        }
      }
      const priorBinding = bindings.get(created.success.state.sessionId);
      bindings.set(created.success.state.sessionId, {
        authSessionId: String(principal.sessionId),
        runtimeId: input.runtimeId,
        runtimeInstanceId: input.runtimeInstanceId,
        generation: input.generation,
        modeSessionId: input.modeSessionId,
        leaseGeneration: created.success.state.leaseGeneration,
        expiresAt: Date.parse(created.success.expiresAt),
        closeOnly: false,
        acknowledgedActionSequences:
          priorBinding?.authSessionId === principal.sessionId &&
          priorBinding.runtimeId === input.runtimeId &&
          priorBinding.runtimeInstanceId === input.runtimeInstanceId &&
          priorBinding.generation === input.generation &&
          priorBinding.modeSessionId === input.modeSessionId &&
          priorBinding.leaseGeneration === created.success.state.leaseGeneration
            ? priorBinding.acknowledgedActionSequences
            : new Set(),
      });
      const result: VoiceRuntimeRealtimeSessionCreateResult = {
        state: created.success.state,
        transport: {
          kind: "webrtc-sdp-v1",
          signalingPath: `/api/voice/runtime/realtime-sessions/${created.success.state.sessionId}/webrtc-offer`,
        },
        expiresAt: created.success.expiresAt,
        heartbeatIntervalSeconds: created.success.heartbeatIntervalSeconds,
      };
      return result;
    }).pipe(protectRealtimeStartCriticalSection);

  const offer: VoiceRealtimeControlServiceShape["offer"] = (authSessionId, sessionId, input) =>
    runCached<VoiceRuntimeRealtimeWebRtcAnswer>(
      authSessionId,
      sessionId,
      input.clientOperationId,
      `offer\0${canonicalFence(input)}\0${hash(input.sdp)}`,
      requireControl(authSessionId, sessionId, input, "webrtc-signaling").pipe(Effect.asVoid),
      Effect.gen(function* () {
        yield* requireControl(authSessionId, sessionId, input, "webrtc-signaling");
        const answer = yield* sessions.offer(authSessionId, sessionId, {
          sessionId,
          leaseGeneration: input.leaseGeneration,
          sdp: input.sdp,
        });
        return {
          ...answer,
          replayed: false,
        } satisfies VoiceRuntimeRealtimeWebRtcAnswer;
      }),
      (value) => ({ ...value, replayed: true as const }),
    );

  const heartbeat: VoiceRealtimeControlServiceShape["heartbeat"] = (
    authSessionId,
    sessionId,
    input,
  ) =>
    Effect.gen(function* () {
      const { binding } = yield* requireControl(authSessionId, sessionId, input, "session-control");
      const state = yield* sessions.heartbeat(authSessionId, sessionId, input.leaseGeneration);
      const terminal = state.phase === "ended" || state.phase === "error";
      const pending = terminal
        ? yield* sessions.listPendingHandoffActions(
            authSessionId,
            sessionId,
            input.leaseGeneration,
            20,
          )
        : [];
      return {
        state,
        disposition: terminal ? "terminal" : "live",
        handoffPending: pending.length > 0,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(binding.expiresAt)),
      };
    });

  const actions: VoiceRealtimeControlServiceShape["actions"] = (authSessionId, sessionId, query) =>
    Effect.gen(function* () {
      const { binding } = yield* requireControl(authSessionId, sessionId, query, "session-control");
      const backlog = yield* sessions.events(authSessionId, sessionId, 0, 0);
      const pending = backlog.events.flatMap((event): ReadonlyArray<VoiceRuntimeRealtimeAction> => {
        const action = toAction(event);
        if (action === undefined || !("actionId" in action)) return [];
        return binding.acknowledgedActionSequences.has(action.sequence) ? [] : [action];
      });
      if (pending.length > 0) return { state: backlog.state, actions: pending };
      const result = yield* sessions.events(
        authSessionId,
        sessionId,
        query.afterSequence,
        query.waitMilliseconds,
      );
      return {
        state: result.state,
        actions: result.events.flatMap((event): ReadonlyArray<VoiceRuntimeRealtimeAction> => {
          const action = toAction(event);
          if (action === undefined) return [];
          if (!("actionId" in action)) return action.sequence > query.afterSequence ? [action] : [];
          return binding.acknowledgedActionSequences.has(action.sequence) ? [] : [action];
        }),
      };
    });

  const acknowledgeAction: VoiceRealtimeControlServiceShape["acknowledgeAction"] = (
    authSessionId,
    sessionId,
    actionId,
    input,
  ) =>
    runCached<VoiceRuntimeRealtimeActionAckResult>(
      authSessionId,
      sessionId,
      input.clientOperationId,
      `action-ack\0${canonicalFence(input)}\0${actionId}\0${input.actionSequence}\0${
        input.action === "navigate-thread"
          ? `${input.action}\0${input.outcome}\0${input.message ?? ""}`
          : `${input.action}\0${input.confirmationId}\0${input.decision}`
      }`,
      requireControl(authSessionId, sessionId, input, "session-control").pipe(Effect.asVoid),
      Effect.gen(function* () {
        const { binding } = yield* requireControl(
          authSessionId,
          sessionId,
          input,
          "session-control",
        );
        const result = yield* sessions.events(authSessionId, sessionId, 0, 0);
        const actions = result.events.flatMap((event) => {
          const action = toAction(event);
          return action === undefined || !("actionId" in action) ? [] : [action];
        });
        const action = actions.find((candidate) => candidate.actionId === actionId);
        if (action === undefined || action.sequence !== input.actionSequence) {
          return yield* operationError(
            "invalid-phase",
            "runtime-realtime.action-ack",
            "Realtime action identity or sequence does not match",
          );
        }
        if (action.type === "navigate-thread") {
          if (input.action !== "navigate-thread") {
            return yield* operationError(
              "invalid-phase",
              "runtime-realtime.action-ack",
              "Realtime action acknowledgement kind does not match the pending action",
            );
          }
          yield* sessions.acknowledgeClientAction(authSessionId, sessionId, actionId, {
            leaseGeneration: input.leaseGeneration,
            action: "activate-thread",
            outcome: input.outcome,
            ...(input.message === undefined ? {} : { message: input.message }),
          });
        } else if (action.type === "confirmation-required") {
          if (
            input.action !== "confirmation-required" ||
            input.confirmationId !== action.confirmationId
          ) {
            return yield* operationError(
              "invalid-phase",
              "runtime-realtime.action-ack",
              "Realtime confirmation decision does not match the pending action",
            );
          }
          yield* sessions.confirm(authSessionId, sessionId, action.confirmationId, {
            decision: input.decision,
          });
        } else {
          return yield* operationError(
            "invalid-phase",
            "runtime-realtime.action-ack",
            "This Realtime action requires its dedicated transition operation",
          );
        }
        binding.acknowledgedActionSequences.add(action.sequence);
        return {
          actionId,
          actionSequence: action.sequence,
          outcome: input.action === "navigate-thread" ? input.outcome : "succeeded",
          replayed: false,
        } satisfies VoiceRuntimeRealtimeActionAckResult;
      }),
      (value) => ({ ...value, replayed: true as const }),
    );

  const updateFocus: VoiceRealtimeControlServiceShape["updateFocus"] = (
    authSessionId,
    sessionId,
    input,
  ) =>
    runCached<VoiceRuntimeRealtimeFocusResult>(
      authSessionId,
      sessionId,
      input.clientOperationId,
      `focus\0${canonicalFence(input)}\0${JSON.stringify(input.focus)}`,
      requireControl(authSessionId, sessionId, input, "session-control").pipe(Effect.asVoid),
      Effect.gen(function* () {
        yield* requireControl(authSessionId, sessionId, input, "session-control");
        const result = yield* sessions.updateFocus(authSessionId, sessionId, {
          leaseGeneration: input.leaseGeneration,
          ...(input.focus === null
            ? {}
            : {
                projectId: input.focus.projectId,
                ...(input.focus.threadId === null ? {} : { threadId: input.focus.threadId }),
              }),
        });
        const response: VoiceRuntimeRealtimeFocusResult = {
          state: result.state,
          focus:
            result.projectId === undefined
              ? null
              : {
                  projectId: result.projectId,
                  threadId: result.threadId ?? null,
                },
          replayed: false,
        };
        return response;
      }),
      (value) => ({ ...value, replayed: true as const }),
    );

  const exchangeHandoff: VoiceRealtimeControlServiceShape["exchangeHandoff"] = (
    authSessionId,
    sessionId,
    actionId,
    input,
  ) => {
    const fingerprint = `handoff\0${canonicalFence(input)}\0${actionId}\0${input.actionSequence}\0${input.nextGeneration}\0${input.threadModeSessionId}\0${input.environmentId}\0${input.speechPreset}\0${JSON.stringify(input.endpointPolicy)}\0${input.speechEnabled}\0${input.rearmGuardMs}`;
    return runCached<VoiceRuntimeRealtimeHandoffExchangeResult>(
      authSessionId,
      sessionId,
      input.clientOperationId,
      fingerprint,
      requireControl(authSessionId, sessionId, input, "handoff-actions").pipe(Effect.asVoid),
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* requireControl(authSessionId, sessionId, input, "handoff-actions");
        const events = yield* sessions.events(authSessionId, sessionId, 0, 0);
        const event = events.events.find(
          (candidate) =>
            candidate.type === "client-action" &&
            candidate.action === "handoff-to-thread-voice" &&
            candidate.actionId === actionId,
        );
        const pending = yield* sessions.listPendingHandoffActions(
          authSessionId,
          sessionId,
          input.leaseGeneration,
          20,
        );
        const action = pending.find((candidate) => candidate.actionId === actionId);
        if (
          event === undefined ||
          event.sequence !== input.actionSequence ||
          action === undefined ||
          Date.parse(action.expiresAt) <= now ||
          input.nextGeneration !== input.generation + 1
        ) {
          return yield* operationError(
            "invalid-phase",
            "runtime-realtime.handoff",
            "Realtime handoff action is not pending for this session",
          );
        }
        const target: VoiceThreadRuntimeTarget = {
          mode: "thread",
          environmentId: input.environmentId,
          projectId: action.projectId,
          threadId: action.threadId,
          speechPreset: input.speechPreset,
          autoRearm: action.autoRearm,
          endpointPolicy: input.endpointPolicy,
          speechEnabled: input.speechEnabled,
          rearmGuardMs: input.rearmGuardMs,
        };
        const candidate = {
          authSessionId,
          sourceSessionId: sessionId,
          sourceLeaseGeneration: input.leaseGeneration,
          actionId,
          actionSequence: input.actionSequence,
          runtimeId: VoiceRuntimeId.make(input.runtimeId),
          runtimeInstanceId: input.runtimeInstanceId,
          sourceGeneration: input.generation,
          nextGeneration: input.nextGeneration,
          modeSessionId: input.threadModeSessionId,
          target,
        };
        const claimed = yield* transitions
          .claim(candidate, now)
          .pipe(
            Effect.mapError((cause) =>
              operationError(
                "provider-unavailable",
                "runtime-realtime.handoff",
                `Realtime transition reservation storage is unavailable: ${String(cause)}`,
                true,
              ),
            ),
          );
        if (claimed.status === "mismatch") {
          return yield* operationError(
            "invalid-phase",
            "runtime-realtime.handoff",
            "Realtime handoff reservation conflicts with an existing exchange",
          );
        }
        const receipt =
          claimed.status === "existing" ? claimed.record : { ...candidate, consumedAt: null };
        return {
          actionId,
          actionSequence: receipt.actionSequence,
          projectId: receipt.target.projectId,
          threadId: receipt.target.threadId,
          autoRearm: receipt.target.autoRearm,
          reservation: {
            generation: input.nextGeneration,
            modeSessionId: input.threadModeSessionId,
            target: receipt.target,
          },
          replayed: claimed.status === "existing",
        } satisfies VoiceRuntimeRealtimeHandoffExchangeResult;
      }).pipe(Effect.uninterruptible),
      (value) => ({ ...value, replayed: true as const }),
    ).pipe(Effect.uninterruptible);
  };

  const commitHandoff: VoiceRealtimeControlServiceShape["commitHandoff"] = (
    authSessionId,
    sessionId,
    actionId,
    input,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const binding = (yield* requireControl(authSessionId, sessionId, input, "handoff-commit"))
        .binding;
      const consumed = yield* runtimeAuthorities
        .consumeHandoff(
          {
            authSessionId,
            runtimeId: VoiceRuntimeId.make(input.runtimeId),
            runtimeInstanceId: input.runtimeInstanceId,
            sourceSessionId: sessionId,
            sourceLeaseGeneration: input.leaseGeneration,
            actionId,
            actionSequence: input.actionSequence,
            sourceGeneration: input.generation,
            nextGeneration: input.nextGeneration,
            modeSessionId: input.threadModeSessionId,
          },
          now,
        )
        .pipe(
          Effect.mapError((cause) =>
            operationError(
              "provider-unavailable",
              "runtime-realtime.handoff-commit",
              `Runtime authority storage is unavailable: ${String(cause)}`,
              true,
            ),
          ),
        );
      if (consumed.status === "stale")
        return yield* operationError(
          "authorization-revoked",
          "runtime-realtime.handoff-commit",
          "Realtime handoff reservation does not match this commit",
        );
      const acknowledged = yield* sessions
        .acknowledgeRuntimeHandoffAction(
          authSessionId,
          sessionId,
          input.leaseGeneration,
          actionId,
          { outcome: "succeeded", state: "accepted" },
        )
        .pipe(Effect.result);
      if (Result.isFailure(acknowledged)) {
        yield* sessions
          .reconcileActivatedRuntimeHandoff(
            authSessionId,
            sessionId,
            input.leaseGeneration,
            actionId,
            { projectId: consumed.target.projectId, threadId: consumed.target.threadId },
          )
          .pipe(Effect.result);
      }
      bindings.set(sessionId, { ...binding, closeOnly: true });
      bindings.get(sessionId)?.acknowledgedActionSequences.add(input.actionSequence);
      return {
        actionId,
        actionSequence: input.actionSequence,
        committed: true,
        replayed: consumed.status === "existing",
      } satisfies VoiceRuntimeRealtimeHandoffCommitResult;
    }).pipe(Effect.uninterruptible);

  const close: VoiceRealtimeControlServiceShape["close"] = (authSessionId, sessionId, input) =>
    runCached<VoiceRuntimeRealtimeCloseResult>(
      authSessionId,
      sessionId,
      input.clientOperationId,
      `close\0${canonicalFence(input)}`,
      requireControl(authSessionId, sessionId, input, "session-close").pipe(Effect.asVoid),
      Effect.gen(function* () {
        yield* requireControl(authSessionId, sessionId, input, "session-close");
        const result = yield* sessions.close(authSessionId, sessionId, input.leaseGeneration);
        bindings.delete(sessionId);
        return {
          ...result,
          replayed: false,
        } satisfies VoiceRuntimeRealtimeCloseResult;
      }),
      (value) => ({ ...value, replayed: true as const }),
    );

  return VoiceRealtimeControlService.of({
    create,
    offer,
    heartbeat,
    actions,
    acknowledgeAction,
    updateFocus,
    exchangeHandoff,
    commitHandoff,
    close,
  });
});

export const VoiceRealtimeControlServiceLive = Layer.effect(VoiceRealtimeControlService, make);

export const __testing = { make };

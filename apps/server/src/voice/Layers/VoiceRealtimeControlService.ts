import {
  VoiceClientActionId,
  VoiceRuntimeId,
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
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { VoiceRuntimeRealtimeStartRepository } from "../../persistence/Services/VoiceRuntimeRealtimeStarts.ts";
import { VoiceRealtimeTransitionGrantRepository } from "../../persistence/Services/VoiceRealtimeTransitionGrants.ts";
import { VoiceError } from "../Errors.ts";
import { VoiceRuntimeControlGrantRegistry } from "../Services/VoiceRuntimeControlGrantRegistry.ts";
import { VoiceRuntimeGrantRegistry } from "../Services/VoiceRuntimeGrantRegistry.ts";
import {
  VoiceRealtimeControlService,
  type VoiceRealtimeControlServiceShape,
} from "../Services/VoiceRealtimeControlService.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";

const START_CLAIM_MILLIS = 60_000;
const TRANSITION_TOKEN_KEY_NAME = "voice-realtime-transition-token-key-v1";
const OPERATION_CACHE_TTL_MILLIS = 5 * 60_000;
const OPERATION_CACHE_LIMIT = 512;

interface SessionBinding {
  readonly authSessionId: string;
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly generation: number;
  readonly modeSessionId: string;
  readonly leaseGeneration: number;
  readonly acknowledgedActionSequences: Set<number>;
}

interface CachedOperation {
  readonly tokenHash: string;
  readonly fingerprint: string;
  readonly result: unknown;
  readonly expiresAt: number;
}

const hash = (...parts: ReadonlyArray<string | number>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("base64url");

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
  const runtimeGrants = yield* VoiceRuntimeGrantRegistry;
  const controlGrants = yield* VoiceRuntimeControlGrantRegistry;
  const starts = yield* VoiceRuntimeRealtimeStartRepository;
  const transitions = yield* VoiceRealtimeTransitionGrantRepository;
  const sessions = yield* VoiceSessionService;
  const secretStore = yield* ServerSecretStore;
  const transitionTokenKey = yield* secretStore
    .getOrCreateRandom(TRANSITION_TOKEN_KEY_NAME, 32)
    .pipe(Effect.orDie);
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
    token: string,
    sessionId: VoiceSessionId,
    input: {
      readonly runtimeId: string;
      readonly runtimeInstanceId: string;
      readonly generation: number;
      readonly modeSessionId: string;
      readonly leaseGeneration: number;
    },
    capability: "session-control" | "handoff-actions" | "webrtc-signaling" | "session-close",
  ) {
    const grant = yield* controlGrants.authorize(token);
    let binding = bindings.get(sessionId);
    if (grant !== undefined && binding === undefined) {
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
      if (
        persisted !== undefined &&
        persisted.sessionId === sessionId &&
        persisted.leaseGeneration !== null
      ) {
        binding = {
          authSessionId: String(persisted.authSessionId),
          runtimeId: String(persisted.runtimeId),
          runtimeInstanceId: String(persisted.runtimeInstanceId),
          generation: persisted.runtimeGeneration,
          modeSessionId: String(persisted.modeSessionId),
          leaseGeneration: persisted.leaseGeneration,
          acknowledgedActionSequences: new Set(),
        };
        bindings.set(sessionId, binding);
      }
    }
    if (
      grant === undefined ||
      binding === undefined ||
      !grant.capabilities.has(capability) ||
      grant.sessionId !== sessionId ||
      grant.leaseGeneration !== input.leaseGeneration ||
      grant.runtimeId === undefined ||
      String(grant.runtimeId) !== input.runtimeId ||
      grant.runtimeGeneration !== input.generation ||
      binding.authSessionId !== grant.authSessionId ||
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
    return { grant, binding };
  });

  const runCached = <A>(
    token: string,
    sessionId: VoiceSessionId,
    clientOperationId: string,
    fingerprint: string,
    effect: Effect.Effect<A, VoiceError>,
    replay: (value: A) => A,
  ): Effect.Effect<A, VoiceError> =>
    Effect.gen(function* () {
      const sessionLock = yield* sessionMutex(sessionId);
      return yield* sessionLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          maintainOperationCache(now);
          const key = `${sessionId}\0${clientOperationId}`;
          const existing = operations.get(key);
          const tokenHash = hash(token);
          if (existing !== undefined) {
            if (existing.tokenHash !== tokenHash || existing.fingerprint !== fingerprint) {
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
            tokenHash,
            fingerprint,
            result: value,
            expiresAt: now + OPERATION_CACHE_TTL_MILLIS,
          });
          maintainOperationCache(now);
          return value;
        }),
      );
    });

  const create: VoiceRealtimeControlServiceShape["create"] = (runtimeToken, input) =>
    Effect.gen(function* () {
      const grant = yield* runtimeGrants.authorize(runtimeToken);
      if (
        grant === undefined ||
        grant.target.mode !== "realtime" ||
        String(grant.runtimeId) !== input.runtimeId ||
        grant.generation !== input.generation
      ) {
        return yield* operationError(
          "authorization-revoked",
          "runtime-realtime.create",
          "Realtime runtime authority is stale or does not match the requested target",
        );
      }
      const current = yield* runtimeGrants.authorize(runtimeToken);
      if (
        current === undefined ||
        current.authSessionId !== grant.authSessionId ||
        current.runtimeId !== grant.runtimeId ||
        current.generation !== grant.generation
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
        grant.authSessionId,
        grant.runtimeId,
        grant.generation,
        operationIdentity,
      )}`;
      const createInput = {
        mode: "realtime-agent" as const,
        conversation: {
          type: "continue" as const,
          conversationId: grant.target.conversationId,
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
          authSessionId: grant.authSessionId,
          runtimeId: grant.runtimeId,
          runtimeInstanceId: input.runtimeInstanceId,
          runtimeGeneration: grant.generation,
          modeSessionId: input.modeSessionId,
          clientOperationId: operationIdentity,
          conversationId: grant.target.conversationId,
          claimExpiresAt: Math.min(grant.expiresAt, now + START_CLAIM_MILLIS),
          expiresAt: grant.expiresAt,
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
      const principal = {
        sessionId: grant.authSessionId,
        scopes: grant.grantedScopes,
        runtimeAuthority: {
          runtimeId: grant.runtimeId,
          generation: grant.generation,
        },
      };
      const created = yield* (
        existingSessionId === undefined
          ? sessions.create(principal, createInput)
          : sessions.resumeCreate(principal, createInput, existingSessionId)
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
              grant.authSessionId,
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
        authSessionId: String(grant.authSessionId),
        runtimeId: input.runtimeId,
        runtimeInstanceId: input.runtimeInstanceId,
        generation: input.generation,
        modeSessionId: input.modeSessionId,
        leaseGeneration: created.success.state.leaseGeneration,
        acknowledgedActionSequences:
          priorBinding?.authSessionId === grant.authSessionId &&
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
        controlGrant: created.success.runtimeControlGrant,
      };
      return result;
    }).pipe(protectRealtimeStartCriticalSection);

  const offer: VoiceRealtimeControlServiceShape["offer"] = (token, sessionId, input) =>
    runCached<VoiceRuntimeRealtimeWebRtcAnswer>(
      token,
      sessionId,
      input.clientOperationId,
      `offer\0${canonicalFence(input)}\0${hash(input.sdp)}`,
      Effect.gen(function* () {
        const { grant } = yield* requireControl(token, sessionId, input, "webrtc-signaling");
        const answer = yield* sessions.offer(grant.authSessionId, sessionId, {
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

  const heartbeat: VoiceRealtimeControlServiceShape["heartbeat"] = (token, sessionId, input) =>
    Effect.gen(function* () {
      const { grant } = yield* requireControl(token, sessionId, input, "session-control");
      const state = yield* sessions.heartbeat(
        grant.authSessionId,
        sessionId,
        input.leaseGeneration,
      );
      const terminal = state.phase === "ended" || state.phase === "error";
      const pending = terminal
        ? yield* sessions.listPendingHandoffActions(
            grant.authSessionId,
            sessionId,
            input.leaseGeneration,
            20,
          )
        : [];
      return {
        state,
        disposition: terminal ? "terminal" : "live",
        handoffPending: pending.length > 0,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(grant.expiresAt)),
      };
    });

  const actions: VoiceRealtimeControlServiceShape["actions"] = (token, sessionId, query) =>
    Effect.gen(function* () {
      const { grant, binding } = yield* requireControl(token, sessionId, query, "session-control");
      const backlog = yield* sessions.events(grant.authSessionId, sessionId, 0, 0);
      const pending = backlog.events.flatMap((event): ReadonlyArray<VoiceRuntimeRealtimeAction> => {
        const action = toAction(event);
        if (action === undefined || !("actionId" in action)) return [];
        return binding.acknowledgedActionSequences.has(action.sequence) ? [] : [action];
      });
      if (pending.length > 0) return { state: backlog.state, actions: pending };
      const result = yield* sessions.events(
        grant.authSessionId,
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
    token,
    sessionId,
    actionId,
    input,
  ) =>
    runCached<VoiceRuntimeRealtimeActionAckResult>(
      token,
      sessionId,
      input.clientOperationId,
      `action-ack\0${canonicalFence(input)}\0${actionId}\0${input.actionSequence}\0${
        input.action === "navigate-thread"
          ? `${input.action}\0${input.outcome}\0${input.message ?? ""}`
          : `${input.action}\0${input.confirmationId}\0${input.decision}`
      }`,
      Effect.gen(function* () {
        const { grant, binding } = yield* requireControl(
          token,
          sessionId,
          input,
          "session-control",
        );
        const result = yield* sessions.events(grant.authSessionId, sessionId, 0, 0);
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
          yield* sessions.acknowledgeClientAction(grant.authSessionId, sessionId, actionId, {
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
          yield* sessions.confirm(grant.authSessionId, sessionId, action.confirmationId, {
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

  const updateFocus: VoiceRealtimeControlServiceShape["updateFocus"] = (token, sessionId, input) =>
    runCached<VoiceRuntimeRealtimeFocusResult>(
      token,
      sessionId,
      input.clientOperationId,
      `focus\0${canonicalFence(input)}\0${JSON.stringify(input.focus)}`,
      Effect.gen(function* () {
        const { grant } = yield* requireControl(token, sessionId, input, "session-control");
        const result = yield* sessions.updateFocus(grant.authSessionId, sessionId, {
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
    token,
    sessionId,
    actionId,
    input,
  ) => {
    const fingerprint = `handoff\0${canonicalFence(input)}\0${actionId}\0${input.actionSequence}\0${input.nextGeneration}\0${input.threadModeSessionId}\0${input.environmentId}\0${input.speechPreset}\0${JSON.stringify(input.endpointPolicy)}\0${input.speechEnabled}\0${input.rearmGuardMs}`;
    const operationKey = `runtime-realtime-handoff:${hash(
      sessionId,
      input.leaseGeneration,
      actionId,
      input.runtimeId,
      input.runtimeInstanceId,
      input.generation,
      input.nextGeneration,
      input.threadModeSessionId,
      input.clientOperationId,
      fingerprint,
    )}`;
    const sourceControlTokenHash = NodeCrypto.createHash("sha256").update(token).digest("hex");
    const transitionToken = NodeCrypto.createHmac("sha256", transitionTokenKey)
      .update(operationKey)
      .digest("base64url");
    const transitionTokenHash = NodeCrypto.createHash("sha256")
      .update(transitionToken)
      .digest("hex");
    return runCached<VoiceRuntimeRealtimeHandoffExchangeResult>(
      token,
      sessionId,
      input.clientOperationId,
      fingerprint,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const stored = yield* transitions
          .findByOperationKey(operationKey, now)
          .pipe(
            Effect.mapError((cause) =>
              operationError(
                "provider-unavailable",
                "runtime-realtime.handoff",
                `Realtime transition authority storage is unavailable: ${String(cause)}`,
                true,
              ),
            ),
          );
        let receipt = stored;
        let replayed = stored !== undefined;
        if (receipt !== undefined) {
          if (
            receipt.sourceControlTokenHash !== sourceControlTokenHash ||
            receipt.sourceSessionId !== sessionId ||
            receipt.sourceLeaseGeneration !== input.leaseGeneration ||
            receipt.actionId !== actionId ||
            receipt.actionSequence !== input.actionSequence ||
            receipt.runtimeId !== input.runtimeId ||
            receipt.runtimeInstanceId !== input.runtimeInstanceId ||
            receipt.sourceGeneration !== input.generation ||
            receipt.targetGeneration !== input.nextGeneration ||
            receipt.modeSessionId !== input.threadModeSessionId
          ) {
            return yield* operationError(
              "authorization-revoked",
              "runtime-realtime.handoff",
              "Realtime handoff replay authority does not match this exchange",
            );
          }
        } else {
          const authorized = yield* requireControl(token, sessionId, input, "handoff-actions");
          const events = yield* sessions.events(authorized.grant.authSessionId, sessionId, 0, 0);
          const event = events.events.find(
            (candidate) =>
              candidate.type === "client-action" &&
              candidate.action === "handoff-to-thread-voice" &&
              candidate.actionId === actionId,
          );
          const pending = yield* sessions.listPendingHandoffActions(
            authorized.grant.authSessionId,
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
            operationKey,
            tokenHash: transitionTokenHash,
            sourceControlTokenHash,
            authSessionId: authorized.grant.authSessionId,
            sourceSessionId: sessionId,
            sourceLeaseGeneration: input.leaseGeneration,
            actionId,
            actionSequence: input.actionSequence,
            runtimeId: input.runtimeId,
            runtimeInstanceId: input.runtimeInstanceId,
            sourceGeneration: input.generation,
            targetGeneration: input.nextGeneration,
            modeSessionId: input.threadModeSessionId,
            target,
            expiresAt: Math.min(Date.parse(action.expiresAt), now + 60_000),
            authorityExpiresAt: authorized.grant.expiresAt,
          };
          const claimed = yield* transitions
            .claim(candidate, now)
            .pipe(
              Effect.mapError((cause) =>
                operationError(
                  "provider-unavailable",
                  "runtime-realtime.handoff",
                  `Realtime transition authority storage is unavailable: ${String(cause)}`,
                  true,
                ),
              ),
            );
          if (claimed.status === "mismatch") {
            return yield* operationError(
              "invalid-phase",
              "runtime-realtime.handoff",
              "Realtime handoff transition identity conflicts with an existing exchange",
            );
          }
          receipt =
            claimed.status === "existing" ? claimed.record : { ...candidate, consumedAt: null };
          replayed = claimed.status === "existing";
        }
        return {
          actionId,
          actionSequence: receipt.actionSequence,
          projectId: receipt.target.projectId,
          threadId: receipt.target.threadId,
          autoRearm: receipt.target.autoRearm,
          transitionGrant: {
            token: transitionToken,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(receipt.authorityExpiresAt)),
            generation: input.nextGeneration,
            modeSessionId: input.threadModeSessionId,
            target: receipt.target,
          },
          replayed,
        } satisfies VoiceRuntimeRealtimeHandoffExchangeResult;
      }).pipe(Effect.uninterruptible),
      (value) => ({ ...value, replayed: true as const }),
    ).pipe(Effect.uninterruptible);
  };

  const commitHandoff: VoiceRealtimeControlServiceShape["commitHandoff"] = (
    transitionToken,
    sessionId,
    actionId,
    input,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const tokenHash = NodeCrypto.createHash("sha256").update(transitionToken).digest("hex");
      const receipt = yield* transitions
        .findByToken(tokenHash, now)
        .pipe(
          Effect.mapError((cause) =>
            operationError(
              "provider-unavailable",
              "runtime-realtime.handoff-commit",
              `Realtime transition authority storage is unavailable: ${String(cause)}`,
              true,
            ),
          ),
        );
      if (
        receipt === undefined ||
        receipt.sourceSessionId !== sessionId ||
        receipt.actionId !== actionId ||
        receipt.sourceLeaseGeneration !== input.leaseGeneration ||
        receipt.runtimeId !== input.runtimeId ||
        receipt.runtimeInstanceId !== input.runtimeInstanceId ||
        receipt.sourceGeneration !== input.generation ||
        receipt.targetGeneration !== input.nextGeneration ||
        receipt.modeSessionId !== input.threadModeSessionId ||
        receipt.actionSequence !== input.actionSequence
      )
        return yield* operationError(
          "authorization-revoked",
          "runtime-realtime.handoff-commit",
          "Realtime transition authority does not match this commit",
        );
      const activated = yield* runtimeGrants.activateTransition(transitionToken, {
        authSessionId: receipt.authSessionId,
        runtimeId: VoiceRuntimeId.make(receipt.runtimeId),
        sourceGeneration: receipt.sourceGeneration,
        targetGeneration: receipt.targetGeneration,
        target: receipt.target,
        authorityExpiresAt: receipt.authorityExpiresAt,
      });
      const acknowledged = yield* sessions
        .acknowledgeRuntimeHandoffAction(
          receipt.authSessionId,
          sessionId,
          input.leaseGeneration,
          actionId,
          { outcome: "succeeded", state: "accepted" },
        )
        .pipe(Effect.result);
      if (Result.isFailure(acknowledged)) {
        yield* sessions
          .reconcileActivatedRuntimeHandoff(
            receipt.authSessionId,
            sessionId,
            input.leaseGeneration,
            actionId,
            { projectId: receipt.target.projectId, threadId: receipt.target.threadId },
          )
          .pipe(Effect.result);
      }
      bindings.get(sessionId)?.acknowledgedActionSequences.add(receipt.actionSequence);
      return {
        actionId,
        actionSequence: receipt.actionSequence,
        committed: true,
        replayed: activated.replayed || receipt.consumedAt !== null,
      } satisfies VoiceRuntimeRealtimeHandoffCommitResult;
    }).pipe(Effect.uninterruptible);

  const close: VoiceRealtimeControlServiceShape["close"] = (token, sessionId, input) =>
    runCached<VoiceRuntimeRealtimeCloseResult>(
      token,
      sessionId,
      input.clientOperationId,
      `close\0${canonicalFence(input)}`,
      Effect.gen(function* () {
        const { grant } = yield* requireControl(token, sessionId, input, "session-close");
        const result = yield* sessions.close(grant.authSessionId, sessionId, input.leaseGeneration);
        yield* controlGrants.revokeSession(sessionId);
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

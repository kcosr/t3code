import { VoiceToolCallId } from "@t3tools/contracts";
import type {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceCapability,
  VoiceConfirmationId,
  VoiceSessionCreateInput,
  VoiceSessionEvent,
  VoiceSessionId,
  VoiceSessionPhase,
  VoiceSessionState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { VoiceError } from "../Errors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VoiceContextCompiler } from "../Services/VoiceContextCompiler.ts";
import { VoiceConversationService } from "../Services/VoiceConversationService.ts";
import type { RealtimeProviderEvent, RealtimeProviderSession } from "../Services/VoiceProvider.ts";
import { VoiceProviderRegistry } from "../Services/VoiceProviderRegistry.ts";
import { VoiceMediaTicketRegistry } from "../Services/VoiceMediaTicketRegistry.ts";
import { VoiceSessionRegistry, type VoiceSessionLease } from "../Services/VoiceSessionRegistry.ts";
import {
  VoiceSessionService,
  type VoiceSessionServiceShape,
} from "../Services/VoiceSessionService.ts";
import {
  VoiceToolExecutor,
  type VoiceToolCompletedResult,
  type VoiceToolConfirmationResult,
} from "../Services/VoiceToolExecutor.ts";

const HEARTBEAT_INTERVAL_SECONDS = 10;
const SESSION_DURATION_SECONDS = 55 * 60;
const MAX_BUFFERED_EVENTS = 512;
const MAX_RETAINED_TERMINAL_SESSIONS = 128;
const INSTRUCTIONS =
  "You are the T3 voice agent. Be concise, state what you are about to do before using a tool, and use only the supplied T3 tools.";

interface RuntimeSession {
  readonly lease: VoiceSessionLease;
  readonly input: VoiceSessionCreateInput;
  readonly state: VoiceSessionState;
  readonly events: ReadonlyArray<VoiceSessionEvent>;
  readonly expiresAt: string;
  readonly idempotencyId: string;
  readonly lastHeartbeatAt: number;
  readonly pendingConfirmations: ReadonlySet<VoiceConfirmationId>;
  readonly grantedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly eventSignal: Deferred.Deferred<void>;
  readonly terminalAt?: number;
  readonly terminalOrder?: number;
  readonly terminating?: boolean;
  readonly providerSession?: RealtimeProviderSession;
  readonly eventFiber?: Fiber.Fiber<void, never>;
  readonly heartbeatFiber?: Fiber.Fiber<void, never>;
}

interface RuntimeState {
  readonly sessions: ReadonlyMap<VoiceSessionId, RuntimeSession>;
  readonly idempotency: ReadonlyMap<string, VoiceSessionId>;
  readonly nextTerminalOrder: number;
}

const sessionError = (
  reason: VoiceError["reason"],
  operation: string,
  detail: string,
  retryable = false,
) => new VoiceError({ reason, operation, detail, retryable });

type PendingVoiceSessionEvent<T = VoiceSessionEvent> = T extends VoiceSessionEvent
  ? Omit<T, "sessionId" | "leaseGeneration" | "sequence" | "occurredAt">
  : never;

const make = Effect.gen(function* () {
  const registry = yield* VoiceSessionRegistry;
  const conversations = yield* VoiceConversationService;
  const compiler = yield* VoiceContextCompiler;
  const providers = yield* VoiceProviderRegistry;
  const tools = yield* VoiceToolExecutor;
  const settingsService = yield* ServerSettingsService;
  const tickets = yield* VoiceMediaTicketRegistry;
  const serviceScope = yield* Scope.make("sequential");
  const lifecycleMutex = yield* Semaphore.make(1);
  const runtime = yield* SynchronizedRef.make<RuntimeState>({
    sessions: new Map(),
    idempotency: new Map(),
    nextTerminalOrder: 1,
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const mutateSession = <A>(
    sessionId: VoiceSessionId,
    f: (session: RuntimeSession) => readonly [A, RuntimeSession],
  ): Effect.Effect<Option.Option<A>> =>
    SynchronizedRef.modify(runtime, (current) => {
      const session = current.sessions.get(sessionId);
      if (session === undefined) return [Option.none(), current] as const;
      const [value, updated] = f(session);
      const sessions = new Map(current.sessions);
      sessions.set(sessionId, updated);
      return [Option.some(value), { ...current, sessions }] as const;
    });

  const emit = Effect.fn("VoiceSessionService.emit")(function* (
    lease: VoiceSessionLease,
    event: PendingVoiceSessionEvent,
  ) {
    if (!(yield* registry.isCurrent(lease)) && event.type !== "lease-fenced") return;
    const occurredAt = yield* nowIso;
    const nextSignal = yield* Deferred.make<void>();
    const previousSignal = yield* mutateSession(lease.sessionId, (session) => {
      const sequence = session.state.sequence + 1;
      const normalized = {
        ...event,
        sessionId: lease.sessionId,
        leaseGeneration: lease.generation,
        sequence,
        occurredAt,
      } as VoiceSessionEvent;
      const phase = event.type === "state" ? event.phase : session.state.phase;
      const updated = {
        ...session,
        state: { ...session.state, phase, sequence },
        events: [...session.events, normalized].slice(-MAX_BUFFERED_EVENTS),
        eventSignal: nextSignal,
      };
      return [session.eventSignal, updated] as const;
    });
    if (Option.isSome(previousSignal)) {
      yield* Deferred.succeed(previousSignal.value, undefined).pipe(Effect.ignore);
    }
  });

  const terminateProvider = (
    session: RuntimeSession,
    options: {
      readonly interruptEventFiber?: boolean;
      readonly interruptHeartbeatFiber?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      if (options.interruptHeartbeatFiber !== false && session.heartbeatFiber !== undefined) {
        yield* Fiber.interrupt(session.heartbeatFiber);
      }
      if (options.interruptEventFiber !== false && session.eventFiber !== undefined) {
        yield* Fiber.interrupt(session.eventFiber);
      }
      if (session.providerSession !== undefined)
        yield* session.providerSession.terminate.pipe(Effect.ignore);
      yield* tools.discardSession(session.lease.sessionId);
    });

  const retainTerminalSession = Effect.fn("VoiceSessionService.retainTerminalSession")(function* (
    sessionId: VoiceSessionId,
  ) {
    const terminalAt = yield* Clock.currentTimeMillis;
    yield* SynchronizedRef.update(runtime, (current) => {
      const terminal = current.sessions.get(sessionId);
      if (terminal === undefined) return current;
      const sessions = new Map(current.sessions);
      sessions.set(sessionId, {
        ...terminal,
        terminalAt,
        terminalOrder: current.nextTerminalOrder,
        terminating: false,
      });
      const retained = Array.from(sessions.values())
        .filter((session) => session.terminalAt !== undefined)
        .sort((left, right) => (right.terminalOrder ?? 0) - (left.terminalOrder ?? 0));
      for (const expired of retained.slice(MAX_RETAINED_TERMINAL_SESSIONS)) {
        sessions.delete(expired.lease.sessionId);
      }
      return { ...current, sessions, nextTerminalOrder: current.nextTerminalOrder + 1 };
    });
  });

  const endRuntimeSession = Effect.fn("VoiceSessionService.endRuntimeSession")(function* (
    session: RuntimeSession,
    phase: "ended" | "error",
    options: {
      readonly interruptEventFiber?: boolean;
      readonly interruptHeartbeatFiber?: boolean;
    } = {},
  ) {
    const claimed = yield* mutateSession(session.lease.sessionId, (current) => {
      if (current.terminating || current.terminalAt !== undefined) return [false, current] as const;
      return [true, { ...current, terminating: true }] as const;
    });
    if (Option.isNone(claimed) || !claimed.value) return false;
    yield* emit(session.lease, { type: "state", phase });
    const current = (yield* SynchronizedRef.get(runtime)).sessions.get(session.lease.sessionId);
    yield* terminateProvider(current ?? session, options);
    yield* registry.release(session.lease);
    yield* tickets.revokeVoiceSession(session.lease.sessionId);
    yield* SynchronizedRef.update(runtime, (current) => {
      const idempotency = new Map(current.idempotency);
      idempotency.delete(session.idempotencyId);
      return { ...current, idempotency };
    });
    yield* retainTerminalSession(session.lease.sessionId);
    return true;
  });

  yield* Effect.addFinalizer(() =>
    SynchronizedRef.get(runtime).pipe(
      Effect.flatMap((state) =>
        Effect.forEach(
          state.sessions.values(),
          (session) => session.providerSession?.terminate.pipe(Effect.ignore) ?? Effect.void,
        ),
      ),
      Effect.andThen(Scope.close(serviceScope, Exit.void)),
    ),
  );

  const requireOwned = Effect.fn("VoiceSessionService.requireOwned")(function* (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    leaseGeneration?: number,
  ) {
    const state = yield* SynchronizedRef.get(runtime);
    const session = state.sessions.get(sessionId);
    if (session === undefined) {
      return yield* sessionError(
        "session-not-found",
        "session.lookup",
        "Voice session was not found",
      );
    }
    if (session.lease.ownerAuthSessionId !== ownerAuthSessionId) {
      return yield* sessionError(
        "authorization-revoked",
        "session.lookup",
        "Voice session is owned by another authenticated client",
      );
    }
    if (leaseGeneration !== undefined && session.lease.generation !== leaseGeneration) {
      return yield* sessionError(
        "lease-conflict",
        "session.lookup",
        "Voice session lease generation is stale",
      );
    }
    if (
      !(yield* registry.isCurrent(session.lease)) &&
      session.state.phase !== "ended" &&
      session.state.phase !== "error"
    ) {
      return yield* sessionError(
        "lease-conflict",
        "session.lookup",
        "Voice session lease has been fenced",
      );
    }
    return session;
  });

  const setPhase = (lease: VoiceSessionLease, phase: VoiceSessionPhase) =>
    emit(lease, { type: "state", phase });

  const addPendingConfirmation = Effect.fn("VoiceSessionService.addPendingConfirmation")(function* (
    lease: VoiceSessionLease,
    confirmationId: VoiceConfirmationId,
  ) {
    yield* mutateSession(
      lease.sessionId,
      (session) =>
        [
          undefined,
          {
            ...session,
            pendingConfirmations: new Set(session.pendingConfirmations).add(confirmationId),
          },
        ] as const,
    );
    yield* setPhase(lease, "confirming");
  });

  const resolvePendingConfirmation = Effect.fn("VoiceSessionService.resolvePendingConfirmation")(
    function* (lease: VoiceSessionLease, confirmationId: VoiceConfirmationId) {
      const remaining = yield* mutateSession(lease.sessionId, (session) => {
        const pendingConfirmations = new Set(session.pendingConfirmations);
        pendingConfirmations.delete(confirmationId);
        return [pendingConfirmations.size, { ...session, pendingConfirmations }] as const;
      });
      const phase = (yield* SynchronizedRef.get(runtime)).sessions.get(lease.sessionId)?.state
        .phase;
      if (
        Option.isSome(remaining) &&
        (yield* registry.isCurrent(lease)) &&
        phase !== "ended" &&
        phase !== "error"
      ) {
        yield* setPhase(lease, remaining.value === 0 ? "idle" : "confirming");
      }
    },
  );

  const submitCompletedTool = Effect.fn("VoiceSessionService.submitCompletedTool")(function* (
    lease: VoiceSessionLease,
    providerSession: RealtimeProviderSession,
    result: VoiceToolCompletedResult,
  ) {
    if (result.tool !== "unknown") {
      yield* emit(lease, {
        type: "tool",
        toolCallId: result.toolCallId,
        tool: result.tool,
        outcome: result.outcome,
      });
    }
    if (result.submitOutput) {
      yield* providerSession.submitToolOutput({
        providerFunctionCallId: result.providerFunctionCallId,
        output: result.output,
      });
    }
  });

  const scheduleConfirmationExpiry = Effect.fn("VoiceSessionService.scheduleConfirmationExpiry")(
    function* (
      lease: VoiceSessionLease,
      providerSession: RealtimeProviderSession,
      confirmation: VoiceToolConfirmationResult,
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(`${Math.max(0, Date.parse(confirmation.expiresAt) - now)} millis`);
      if (!(yield* registry.isCurrent(lease))) return;
      const result = yield* tools.expire({
        sessionId: lease.sessionId,
        confirmationId: confirmation.confirmationId,
      });
      if (result !== undefined) {
        yield* submitCompletedTool(lease, providerSession, result).pipe(
          Effect.ensuring(resolvePendingConfirmation(lease, confirmation.confirmationId)),
        );
      }
    },
  );

  const handleProviderEvent = Effect.fn("VoiceSessionService.handleProviderEvent")(function* (
    lease: VoiceSessionLease,
    providerSession: RealtimeProviderSession,
    event: RealtimeProviderEvent,
  ) {
    if (!(yield* registry.isCurrent(lease))) return;
    const grantedScopes = (yield* SynchronizedRef.get(runtime)).sessions.get(
      lease.sessionId,
    )?.grantedScopes;
    if (grantedScopes === undefined) return;
    switch (event.type) {
      case "activity":
        if (
          (yield* SynchronizedRef.get(runtime)).sessions.get(lease.sessionId)?.pendingConfirmations
            .size
        ) {
          return;
        }
        return yield* setPhase(lease, event.activity);
      case "transcript":
        yield* emit(lease, {
          type: "transcript",
          role: event.role,
          text: event.text,
          final: event.final,
        });
        if (event.final) {
          yield* conversations.appendContext({
            conversationId: lease.conversationId,
            kind: event.role === "user" ? "transcript.user" : "transcript.assistant",
            payload: { text: event.text },
          });
        }
        return;
      case "function-call":
        const result = yield* tools.invoke({
          sessionId: lease.sessionId,
          conversationId: lease.conversationId,
          toolCallId: VoiceToolCallId.make(event.providerFunctionCallId),
          providerFunctionCallId: event.providerFunctionCallId,
          name: event.name,
          argumentsJson: event.argumentsJson,
          grantedScopes,
        });
        if (result.type === "completed") {
          yield* submitCompletedTool(lease, providerSession, result);
          return;
        }
        if (result.newlyCreated) {
          yield* addPendingConfirmation(lease, result.confirmationId);
          yield* emit(lease, {
            type: "tool",
            toolCallId: result.toolCallId,
            tool: result.tool,
            outcome: "pending-confirmation",
          });
          yield* emit(lease, {
            type: "confirmation-required",
            confirmationId: result.confirmationId,
            toolCallId: result.toolCallId,
            tool: result.tool,
            summary: result.summary,
            expiresAt: result.expiresAt,
          });
          yield* scheduleConfirmationExpiry(lease, providerSession, result).pipe(
            Effect.catch((error) =>
              emit(lease, { type: "error", reason: error.detail, recoverable: error.retryable }),
            ),
            Effect.forkIn(serviceScope),
          );
        }
        return;
      case "error":
        yield* emit(lease, { type: "error", reason: event.detail, recoverable: event.recoverable });
        if (!event.recoverable) {
          const session = (yield* SynchronizedRef.get(runtime)).sessions.get(lease.sessionId);
          if (session !== undefined) {
            yield* endRuntimeSession(session, "error", { interruptEventFiber: false });
          }
        }
        return;
      case "closed": {
        const session = (yield* SynchronizedRef.get(runtime)).sessions.get(lease.sessionId);
        if (session !== undefined) {
          yield* endRuntimeSession(session, "ended", { interruptEventFiber: false });
        }
        return;
      }
    }
  });

  const createUnlocked: VoiceSessionServiceShape["create"] = Effect.fn(
    "VoiceSessionService.createUnlocked",
  )(function* (principal, input) {
    const ownerAuthSessionId = principal.sessionId;
    if (!input.media.transports.includes("webrtc-sdp-v1")) {
      return yield* sessionError(
        "unsupported-media",
        "session.create",
        "Client does not support WebRTC SDP v1",
      );
    }
    const idempotencyId = `${ownerAuthSessionId}:${input.idempotencyKey}`;
    const existingId = (yield* SynchronizedRef.get(runtime)).idempotency.get(idempotencyId);
    if (existingId !== undefined) {
      const existing = yield* requireOwned(ownerAuthSessionId, existingId);
      return {
        state: existing.state,
        transport: {
          kind: "webrtc-sdp-v1",
          signalingPath: `/api/voice/sessions/${existingId}/webrtc-offer`,
        },
        expiresAt: existing.expiresAt,
        heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      };
    }
    const voiceSettings = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.voice),
      Effect.mapError(
        (cause) =>
          new VoiceError({
            reason: "provider-unavailable",
            operation: "session.create.settings",
            detail: "Voice settings are unavailable",
            retryable: true,
            cause,
          }),
      ),
    );
    if (!voiceSettings.enabled) {
      return yield* sessionError(
        "disabled",
        "session.create",
        "Voice sessions are disabled by server configuration",
      );
    }
    const runtimeBeforeCreate = yield* SynchronizedRef.get(runtime);
    const activeSessions = Array.from(runtimeBeforeCreate.sessions.values()).filter(
      (session) =>
        session.terminalAt === undefined &&
        !session.terminating &&
        session.state.phase !== "ended" &&
        session.state.phase !== "error",
    );
    const continuedConversation =
      input.conversation.type === "continue" ? input.conversation : undefined;
    const replacesActiveConversation =
      continuedConversation?.takeover === true &&
      activeSessions.some(
        (session) => session.lease.conversationId === continuedConversation.conversationId,
      );
    if (
      activeSessions.length - (replacesActiveConversation ? 1 : 0) >=
      voiceSettings.maxConcurrentSessions
    ) {
      return yield* sessionError(
        "quota-exceeded",
        "session.create",
        "The configured concurrent voice session limit has been reached",
        true,
      );
    }
    const conversation =
      input.conversation.type === "new"
        ? yield* conversations.create(input.conversation)
        : yield* conversations.get(input.conversation.conversationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    sessionError(
                      "conversation-not-found",
                      "session.create",
                      "Voice conversation was not found",
                    ),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
    const acquired = yield* registry.acquire({
      conversationId: conversation.conversationId,
      ownerAuthSessionId,
      takeover: input.conversation.type === "continue" && input.conversation.takeover,
    });
    if (Option.isSome(acquired.replacedSessionId)) {
      const displaced = (yield* SynchronizedRef.get(runtime)).sessions.get(
        acquired.replacedSessionId.value,
      );
      if (displaced !== undefined) {
        yield* emit(displaced.lease, {
          type: "lease-fenced",
          replacementGeneration: acquired.lease.generation,
        });
        yield* terminateProvider(displaced);
        yield* tickets.revokeVoiceSession(displaced.lease.sessionId);
        const occurredAt = yield* nowIso;
        yield* mutateSession(
          displaced.lease.sessionId,
          (current) =>
            [
              undefined,
              {
                ...current,
                state: {
                  ...current.state,
                  phase: "ended",
                  sequence: current.state.sequence + 1,
                },
                events: [
                  ...current.events,
                  {
                    type: "state",
                    sessionId: current.lease.sessionId,
                    leaseGeneration: current.lease.generation,
                    sequence: current.state.sequence + 1,
                    occurredAt,
                    phase: "ended",
                  } as VoiceSessionEvent,
                ].slice(-MAX_BUFFERED_EVENTS),
              },
            ] as const,
        );
        yield* SynchronizedRef.update(runtime, (current) => {
          const idempotency = new Map(current.idempotency);
          idempotency.delete(displaced.idempotencyId);
          return { ...current, idempotency };
        });
        yield* retainTerminalSession(displaced.lease.sessionId);
      }
    }
    const createdAt = yield* DateTime.now;
    const createdAtMillis = yield* Clock.currentTimeMillis;
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(createdAt, `${SESSION_DURATION_SECONDS} seconds`),
    );
    const state: VoiceSessionState = {
      sessionId: acquired.lease.sessionId,
      conversationId: conversation.conversationId,
      mode: input.mode,
      phase: "signaling",
      leaseGeneration: acquired.lease.generation,
      sequence: 0,
    };
    const eventSignal = yield* Deferred.make<void>();
    yield* SynchronizedRef.update(runtime, (current) => {
      const sessions = new Map(current.sessions);
      sessions.set(acquired.lease.sessionId, {
        lease: acquired.lease,
        input,
        state,
        events: [],
        expiresAt,
        idempotencyId,
        lastHeartbeatAt: createdAtMillis,
        pendingConfirmations: new Set(),
        grantedScopes: new Set(principal.scopes),
        eventSignal,
      });
      const idempotency = new Map(current.idempotency);
      idempotency.set(idempotencyId, acquired.lease.sessionId);
      return { ...current, sessions, idempotency };
    });
    const heartbeatFiber = yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(`${HEARTBEAT_INTERVAL_SECONDS} seconds`);
        const current = (yield* SynchronizedRef.get(runtime)).sessions.get(
          acquired.lease.sessionId,
        );
        if (
          current === undefined ||
          current.state.phase === "ended" ||
          current.state.phase === "error"
        )
          return;
        const now = yield* Clock.currentTimeMillis;
        const heartbeatExpired =
          now - current.lastHeartbeatAt >= HEARTBEAT_INTERVAL_SECONDS * 3 * 1_000;
        const durationExpired = now >= Date.parse(current.expiresAt);
        if (!heartbeatExpired && !durationExpired) continue;
        if (durationExpired) {
          yield* emit(current.lease, {
            type: "rotation-required",
            reason: "duration-limit",
          });
        }
        yield* emit(current.lease, {
          type: "error",
          reason: durationExpired
            ? "Voice session duration limit reached"
            : "Voice session heartbeat timed out",
          recoverable: false,
        });
        yield* endRuntimeSession(current, "ended", { interruptHeartbeatFiber: false });
        return;
      }
    }).pipe(Effect.forkIn(serviceScope));
    yield* mutateSession(
      acquired.lease.sessionId,
      (current) => [undefined, { ...current, heartbeatFiber }] as const,
    );
    return {
      state,
      transport: {
        kind: "webrtc-sdp-v1",
        signalingPath: `/api/voice/sessions/${acquired.lease.sessionId}/webrtc-offer`,
      },
      expiresAt,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
    };
  });

  const create: VoiceSessionServiceShape["create"] = (principal, input) =>
    lifecycleMutex.withPermits(1)(createUnlocked(principal, input));

  const get: VoiceSessionServiceShape["get"] = (owner, sessionId) =>
    requireOwned(owner, sessionId).pipe(Effect.map((session) => session.state));

  const heartbeat: VoiceSessionServiceShape["heartbeat"] = Effect.fn(
    "VoiceSessionService.heartbeat",
  )(function* (owner, sessionId, generation) {
    const session = yield* requireOwned(owner, sessionId, generation);
    if (session.state.phase === "ended" || session.state.phase === "error") {
      return yield* sessionError(
        "invalid-phase",
        "session.heartbeat",
        "Voice session is no longer active",
      );
    }
    const heartbeatAt = yield* Clock.currentTimeMillis;
    const updated = yield* mutateSession(sessionId, (current) => {
      const next = { ...current, lastHeartbeatAt: heartbeatAt };
      return [next.state, next] as const;
    });
    return Option.getOrThrow(updated);
  });

  const closeUnlocked: VoiceSessionServiceShape["close"] = Effect.fn(
    "VoiceSessionService.closeUnlocked",
  )(function* (owner, sessionId, generation) {
    const session = yield* requireOwned(owner, sessionId, generation);
    if (session.state.phase === "ended") return { state: session.state, closed: false };
    const closed = yield* endRuntimeSession(session, "ended");
    const ended = yield* SynchronizedRef.get(runtime).pipe(
      Effect.map((state) => state.sessions.get(sessionId)!),
    );
    return { state: ended.state, closed };
  });

  const close: VoiceSessionServiceShape["close"] = (owner, sessionId, generation) =>
    lifecycleMutex.withPermits(1)(closeUnlocked(owner, sessionId, generation));

  const offer: VoiceSessionServiceShape["offer"] = Effect.fn("VoiceSessionService.offer")(
    function* (owner, sessionId, offer) {
      if (offer.sessionId !== sessionId) {
        return yield* sessionError(
          "lease-conflict",
          "session.offer",
          "SDP offer session ID does not match the route",
        );
      }
      const session = yield* requireOwned(owner, sessionId, offer.leaseGeneration);
      if (session.state.phase !== "signaling") {
        return yield* sessionError(
          "invalid-phase",
          "session.offer",
          "Voice session is not awaiting an SDP offer",
        );
      }
      const capability: VoiceCapability =
        session.input.mode === "realtime-agent" ? "agent.realtime" : "transcription.realtime";
      const adapter = yield* providers.resolve(capability);
      if (adapter.realtime === undefined) {
        return yield* sessionError(
          "provider-unavailable",
          "session.offer",
          "Configured provider has no realtime implementation",
          true,
        );
      }
      yield* setPhase(session.lease, "connecting");
      const entries = yield* conversations.listContext(session.lease.conversationId);
      const contextTokenBudget = yield* settingsService.getSettings.pipe(
        Effect.map((settings) => settings.voice.contextTokenBudget),
        Effect.mapError(
          (cause) =>
            new VoiceError({
              reason: "provider-unavailable",
              operation: "session.offer.settings",
              detail: "Voice settings are unavailable",
              retryable: true,
              cause,
            }),
        ),
      );
      const context = yield* compiler.compile({ entries, tokenBudget: contextTokenBudget });
      const providerSession = yield* adapter.realtime
        .negotiate({
          sessionId,
          leaseGeneration: session.lease.generation,
          offer,
          instructions: INSTRUCTIONS,
          continuationContext: context.items,
        })
        .pipe(Effect.tapError(() => endRuntimeSession(session, "error")));
      const providerAttached = yield* mutateSession(sessionId, (current) => {
        if (current.terminating || current.terminalAt !== undefined) {
          return [false, current] as const;
        }
        return [true, { ...current, providerSession }] as const;
      });
      if (Option.isNone(providerAttached) || !providerAttached.value) {
        yield* providerSession.terminate.pipe(Effect.ignore);
        return yield* sessionError(
          "lease-conflict",
          "session.offer",
          "Voice session was replaced during signaling",
        );
      }
      if (!(yield* registry.isCurrent(session.lease))) {
        return yield* sessionError(
          "lease-conflict",
          "session.offer",
          "Voice session was replaced during signaling",
        );
      }
      const eventFiber = yield* providerSession.events.pipe(
        Stream.runForEach((event) => handleProviderEvent(session.lease, providerSession, event)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* emit(session.lease, {
              type: "error",
              reason: error.detail,
              recoverable: error.retryable,
            });
            const current = (yield* SynchronizedRef.get(runtime)).sessions.get(sessionId);
            if (current !== undefined) {
              yield* endRuntimeSession(current, "error", { interruptEventFiber: false });
            }
          }),
        ),
        Effect.forkIn(serviceScope),
      );
      const eventFiberAttached = yield* mutateSession(sessionId, (current) => {
        if (current.terminating || current.terminalAt !== undefined) {
          return [false, current] as const;
        }
        return [true, { ...current, eventFiber }] as const;
      });
      if (
        Option.isNone(eventFiberAttached) ||
        !eventFiberAttached.value ||
        !(yield* registry.isCurrent(session.lease))
      ) {
        yield* Fiber.interrupt(eventFiber);
        return yield* sessionError(
          "lease-conflict",
          "session.offer",
          "Voice session ended while signaling",
        );
      }
      yield* setPhase(session.lease, "idle");
      return providerSession.answer;
    },
  );

  const events: VoiceSessionServiceShape["events"] = Effect.fn("VoiceSessionService.events")(
    function* (owner, sessionId, afterSequence, waitMilliseconds) {
      const initial = yield* requireOwned(owner, sessionId);
      const initialEvents = initial.events.filter((event) => event.sequence > afterSequence);
      if (
        initialEvents.length > 0 ||
        waitMilliseconds === 0 ||
        initial.state.phase === "ended" ||
        initial.state.phase === "error"
      ) {
        return { state: initial.state, events: initialEvents };
      }
      yield* Deferred.await(initial.eventSignal).pipe(
        Effect.timeoutOption(`${waitMilliseconds} millis`),
      );
      const current = yield* requireOwned(owner, sessionId);
      return {
        state: current.state,
        events: current.events.filter((event) => event.sequence > afterSequence),
      };
    },
  );

  const revokeAuthSession: VoiceSessionServiceShape["revokeAuthSession"] = (owner) =>
    lifecycleMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* tickets.revokeAuthSession(owner);
        const owned = Array.from((yield* SynchronizedRef.get(runtime)).sessions.values()).filter(
          (session) =>
            session.lease.ownerAuthSessionId === owner && session.terminalAt === undefined,
        );
        yield* Effect.forEach(owned, (session) => endRuntimeSession(session, "ended"), {
          discard: true,
        });
      }),
    );

  const deleteConversation: VoiceSessionServiceShape["deleteConversation"] = (conversationId) =>
    lifecycleMutex.withPermits(1)(
      Effect.gen(function* () {
        const matching = Array.from((yield* SynchronizedRef.get(runtime)).sessions.values()).filter(
          (session) =>
            session.lease.conversationId === conversationId && session.terminalAt === undefined,
        );
        yield* Effect.forEach(matching, (session) => endRuntimeSession(session, "ended"), {
          discard: true,
        });
        const deleted = yield* conversations.delete(conversationId);
        if (deleted) {
          yield* SynchronizedRef.update(runtime, (current) => {
            const sessions = new Map(current.sessions);
            for (const session of sessions.values()) {
              if (session.lease.conversationId === conversationId) {
                sessions.delete(session.lease.sessionId);
              }
            }
            return { ...current, sessions };
          });
        }
        return deleted;
      }),
    );

  const clearConversationContext: VoiceSessionServiceShape["clearConversationContext"] = (
    conversationId,
  ) =>
    lifecycleMutex.withPermits(1)(
      Effect.gen(function* () {
        const matching = Array.from((yield* SynchronizedRef.get(runtime)).sessions.values()).filter(
          (session) =>
            session.lease.conversationId === conversationId && session.terminalAt === undefined,
        );
        yield* Effect.forEach(matching, (session) => endRuntimeSession(session, "ended"), {
          discard: true,
        });
        return yield* conversations.clearContext(conversationId);
      }),
    );

  const confirm: VoiceSessionServiceShape["confirm"] = Effect.fn("VoiceSessionService.confirm")(
    function* (owner, sessionId, confirmationId, input) {
      const session = yield* requireOwned(owner, sessionId);
      if (
        session.providerSession === undefined ||
        session.state.phase === "ended" ||
        session.state.phase === "error"
      ) {
        return yield* sessionError(
          "invalid-phase",
          "session.confirmation",
          "Voice session does not have an active provider call",
        );
      }
      const result = yield* tools.decide({ sessionId, confirmationId, decision: input.decision });
      if (result.tool === "unknown") {
        return yield* sessionError(
          "invalid-phase",
          "session.confirmation",
          "Voice tool confirmation resolved to an unknown tool",
        );
      }
      if (input.decision === "approve") {
        yield* emit(session.lease, {
          type: "tool",
          toolCallId: result.toolCallId,
          tool: result.tool,
          outcome: "approved",
        });
      }
      yield* submitCompletedTool(session.lease, session.providerSession, result).pipe(
        Effect.ensuring(resolvePendingConfirmation(session.lease, confirmationId)),
      );
      return {
        confirmationId,
        toolCallId: result.toolCallId,
        outcome: input.decision === "approve" ? "approved" : "rejected",
      };
    },
  );

  return VoiceSessionService.of({
    create,
    get,
    heartbeat,
    close,
    offer,
    events,
    confirm,
    revokeAuthSession,
    deleteConversation,
    clearConversationContext,
  });
});

export const VoiceSessionServiceLive = Layer.effect(VoiceSessionService, make);

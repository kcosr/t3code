import type {
  ProjectId,
  ThreadId,
  VoiceConfirmationDecision,
  VoiceConfirmationId,
  VoiceConfirmationResult,
  VoiceClientActionAckInput,
  VoiceClientActionAckResult,
  VoiceClientActionId,
  VoiceSessionCreateInput,
  VoiceSessionCreateResult,
  VoiceSessionEvent,
  VoiceSessionState,
} from "@t3tools/contracts";
import { VoiceSessionId } from "@t3tools/contracts";
import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import type {
  T3VoiceAudioRoute,
  T3VoiceAudioRouteChangedEvent,
  T3VoiceNativeModule,
  T3VoiceRealtimeTerminatedEvent,
  T3VoiceRuntimeErrorEvent,
  T3VoiceRuntimeState,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";

export type RealtimeVoiceControllerPhase = "idle" | "starting" | "active" | "stopping" | "error";

export interface RealtimeVoiceControllerSnapshot {
  readonly phase: RealtimeVoiceControllerPhase;
  readonly session: VoiceSessionState | null;
  readonly native: T3VoiceRuntimeState | null;
  readonly error: string | null;
}

export interface RealtimeVoiceControllerListener {
  readonly onSnapshot: (snapshot: RealtimeVoiceControllerSnapshot) => void;
  readonly onSessionEvents?: (events: ReadonlyArray<VoiceSessionEvent>) => void;
  readonly onAudioRouteChanged?: (event: T3VoiceAudioRouteChangedEvent) => void;
}

interface ActiveSession {
  readonly sessionId: VoiceSessionState["sessionId"];
  readonly nativeSessionId: string;
  readonly leaseGeneration: number;
  serverState: VoiceSessionState;
  afterSequence: number;
  lastServerError: string | null;
}

interface TimerScheduler {
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

type ControlOperation = "events";

export interface RealtimeVoiceControllerOptions {
  readonly scheduler?: TimerScheduler;
  readonly eventPollIntervalMs?: number;
  readonly serverCleanupTimeoutMs?: number;
  readonly cleanupCoordinator?: RealtimeServerCleanupCoordinator;
}

const defaultScheduler: TimerScheduler = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

const messageFor = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const errorTag = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "_tag" in cause
    ? String((cause as { readonly _tag: unknown })._tag)
    : null;

const controlFailureMessage = (operation: ControlOperation, cause: unknown): string => {
  if (operation === "events" && errorTag(cause) === "RemoteEnvironmentAuthInvalidJsonError") {
    return `Realtime event stream returned an invalid response: ${messageFor(cause)}`;
  }
  return `Realtime control connection failed during ${operation}: ${messageFor(cause)}`;
};

const nativeTerminationMessage = (code: string, retryable = false): string => {
  switch (code) {
    case "realtime-connection-failed":
      return "The Realtime media connection failed";
    case "realtime-ice-timeout":
      return "The Realtime connection timed out";
    case "realtime-answer-rejected":
      return "The Realtime answer was rejected";
    case "realtime-offer-failed":
      return "The Realtime offer could not be created";
    case "realtime-prepare-failed":
      return "The Realtime media session could not be prepared";
    case "native-control-lost":
      return retryable
        ? "The Realtime control connection was lost. Resume to reconnect"
        : "The Realtime session lost native control";
    default:
      return "The Realtime media session ended unexpectedly";
  }
};

const nativeRuntimeErrorMessage = (code: string): string => {
  switch (code) {
    case "realtime-connection-failed":
    case "realtime-ice-timeout":
    case "realtime-answer-rejected":
    case "realtime-offer-failed":
    case "realtime-prepare-failed":
      return nativeTerminationMessage(code);
    default:
      return "The Realtime media connection reported an error";
  }
};

type ServerCleanup = Pick<ActiveSession, "sessionId" | "leaseGeneration">;
interface PendingServerCleanup extends ServerCleanup {
  readonly client: VoiceHttpClient;
  readonly enqueuedAtMonotonicMillis: number;
}

const MAX_BLOCKING_SERVER_CLEANUP_AGE_MILLIS = 40_000;
const monotonicNow = (): number => globalThis.performance.now();

const TERMINAL_CLEANUP_ERROR_TAGS = new Set([
  "EnvironmentAuthInvalidError",
  "EnvironmentOperationForbiddenError",
  "EnvironmentResourceNotFoundError",
  "EnvironmentScopeRequiredError",
]);

const cleanupFailureIsTerminal = (cause: unknown): boolean => {
  const tag = errorTag(cause);
  if (tag !== null && TERMINAL_CLEANUP_ERROR_TAGS.has(tag)) return true;
  return (
    tag === "EnvironmentVoiceOperationError" &&
    typeof cause === "object" &&
    cause !== null &&
    "retryable" in cause &&
    (cause as { readonly retryable: unknown }).retryable === false
  );
};

export class RealtimeServerCleanupCoordinator {
  private readonly pending = new Map<VoiceSessionState["sessionId"], PendingServerCleanup>();
  private barrier: Promise<void> = Promise.resolve();

  constructor(
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = monotonicNow,
  ) {}

  enqueue(client: VoiceHttpClient, cleanup: ServerCleanup) {
    const pending = { ...cleanup, client, enqueuedAtMonotonicMillis: this.now() };
    this.pending.set(cleanup.sessionId, pending);
    const previous = this.barrier;
    this.barrier = previous.then(async () => {
      if (!this.pending.has(cleanup.sessionId)) return;
      if (await this.tryCleanup(pending)) this.pending.delete(cleanup.sessionId);
    });
  }

  async drain(): Promise<void> {
    await this.barrier;
    for (const cleanup of this.pending.values()) {
      if (
        this.now() - cleanup.enqueuedAtMonotonicMillis >=
        MAX_BLOCKING_SERVER_CLEANUP_AGE_MILLIS
      ) {
        this.pending.delete(cleanup.sessionId);
        continue;
      }
      if (!(await this.tryCleanup(cleanup))) {
        throw new Error(
          "The previous Realtime session could not be released. Check connectivity and try again",
        );
      }
      this.pending.delete(cleanup.sessionId);
    }
  }

  settled(): Promise<void> {
    return this.barrier;
  }

  private async tryCleanup(cleanup: PendingServerCleanup): Promise<boolean> {
    try {
      await Effect.runPromise(
        cleanup.client
          .closeSession(cleanup.sessionId, cleanup.leaseGeneration)
          .pipe(Effect.timeout(`${this.timeoutMs} millis`)),
      );
      return true;
    } catch (cause) {
      if (cleanupFailureIsTerminal(cause)) return true;
      console.warn("[voice] server session cleanup failed", {
        sessionId: cleanup.sessionId,
        leaseGeneration: cleanup.leaseGeneration,
        errorTag: errorTag(cause) ?? "unknown",
      });
      return false;
    }
  }
}

export class RealtimeControllerHandoff {
  private tail: Promise<void> = Promise.resolve();

  reserve(): { readonly ready: Promise<void>; readonly release: () => void } {
    const ready = this.tail;
    let resolve!: () => void;
    const occupied = new Promise<void>((completion) => {
      resolve = completion;
    });
    this.tail = ready.then(() => occupied);
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        resolve();
      },
    };
  }
}

export class RealtimeVoiceController {
  private readonly scheduler: TimerScheduler;
  private readonly eventPollIntervalMs: number;
  private readonly subscriptions: ReadonlyArray<{
    readonly remove: () => void;
  }>;
  private active: ActiveSession | null = null;
  private eventTimer: unknown | null = null;
  private startGeneration = 0;
  private startingNativeSessionId: string | null = null;
  private refreshInFlight = false;
  private nativeRuntimeReconciliation: Promise<void> | null = null;
  private readonly cleanupCoordinator: RealtimeServerCleanupCoordinator;
  private startInFlight: Promise<void> | null = null;
  private detached = false;
  private subscriptionsRemoved = false;
  private controlFailures: Record<ControlOperation, number> = {
    events: 0,
  };
  private snapshot: RealtimeVoiceControllerSnapshot = {
    phase: "idle",
    session: null,
    native: null,
    error: null,
  };

  constructor(
    private readonly native: T3VoiceNativeModule,
    private readonly client: VoiceHttpClient,
    private readonly environmentOrigin: string,
    private readonly listener: RealtimeVoiceControllerListener,
    options: RealtimeVoiceControllerOptions = {},
  ) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.eventPollIntervalMs = options.eventPollIntervalMs ?? 1_000;
    this.cleanupCoordinator =
      options.cleanupCoordinator ??
      new RealtimeServerCleanupCoordinator(options.serverCleanupTimeoutMs ?? 10_000);
    this.subscriptions = [
      native.addListener("stateChanged", (state) => this.handleNativeState(state)),
      native.addListener("runtimeError", (event) => this.handleNativeError(event)),
      native.addListener("audioRouteChanged", (event) => {
        if (event.nativeSessionId === this.active?.nativeSessionId) {
          listener.onAudioRouteChanged?.(event);
        }
      }),
      native.addListener("realtimeTerminated", (event) => this.handleNativeTermination(event)),
    ];
  }

  getSnapshot(): RealtimeVoiceControllerSnapshot {
    return this.snapshot;
  }

  reconcileNativeRuntime(): Promise<void> {
    if (this.detached) {
      return Promise.reject(new Error("Cannot reconcile a detached Realtime controller"));
    }
    if (this.active !== null || this.snapshot.phase === "starting") {
      return Promise.reject(new Error("Cannot reconcile native media during an active session"));
    }
    if (this.nativeRuntimeReconciliation === null) {
      const reconciliation = this.reconcileNativeRuntimeOnce();
      this.nativeRuntimeReconciliation = reconciliation.then(
        () => {
          if (this.nativeRuntimeReconciliation !== null) this.nativeRuntimeReconciliation = null;
        },
        (cause) => {
          if (this.nativeRuntimeReconciliation !== null) this.nativeRuntimeReconciliation = null;
          throw cause;
        },
      );
    }
    return this.nativeRuntimeReconciliation;
  }

  async start(input: VoiceSessionCreateInput): Promise<RealtimeVoiceControllerSnapshot> {
    if (this.detached) throw new Error("Cannot start a detached Realtime controller");
    if (this.startInFlight !== null) {
      throw new Error("A Realtime voice session is already starting");
    }
    const operation = this.startOnce(input);
    const completion = operation.then(
      () => undefined,
      () => undefined,
    );
    this.startInFlight = completion;
    try {
      return await operation;
    } finally {
      if (this.startInFlight === completion) this.startInFlight = null;
    }
  }

  private async startOnce(
    input: VoiceSessionCreateInput,
  ): Promise<RealtimeVoiceControllerSnapshot> {
    const generation = ++this.startGeneration;
    await this.reconcileNativeRuntime();
    this.ensureCurrentStart(generation);
    if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") {
      throw new Error("A Realtime voice session is already starting or active");
    }
    this.setSnapshot({ phase: "starting", session: null, error: null });
    let serverSession: VoiceSessionCreateResult | null = null;
    let serverState: VoiceSessionState | null = null;
    let nativeSessionId: string | null = null;
    try {
      await this.cleanupCoordinator.drain();
      this.ensureCurrentStart(generation);
      const existingPermission = await this.native.getMicrophonePermissionAsync();
      const permission = existingPermission.granted
        ? existingPermission
        : await this.native.requestMicrophonePermissionAsync();
      if (!permission.granted) throw new Error("Microphone permission was not granted");
      // Notification denial must not block voice, but request while Android is visible so the
      // foreground service can expose its Stop action in the notification drawer.
      await this.native.requestNotificationPermissionAsync().catch(() => undefined);
      this.ensureCurrentStart(generation);

      serverSession = await Effect.runPromise(this.client.createSession(input));
      serverState = serverSession.state;
      this.ensureCurrentStart(generation);
      nativeSessionId = serverSession.state.sessionId;
      this.startingNativeSessionId = nativeSessionId;
      let nativeControlGrant: VoiceSessionCreateResult["nativeControlGrant"] | null =
        serverSession.nativeControlGrant;
      let nativeOffer;
      try {
        nativeOffer = await this.native.prepareRealtimeSessionAsync({
          nativeSessionId,
          environmentOrigin: this.environmentOrigin,
          nativeControlGrant,
        });
      } finally {
        nativeControlGrant = null;
        serverSession = null;
      }
      this.ensureCurrentStart(generation);
      const answer = await Effect.runPromise(
        this.client.offerSession({
          sessionId: serverState.sessionId,
          leaseGeneration: serverState.leaseGeneration,
          sdp: nativeOffer.sdp,
        }),
      );
      this.ensureCurrentStart(generation);
      await this.native.applyRealtimeAnswerAsync({
        nativeSessionId,
        sdp: answer.sdp,
      });
      this.ensureCurrentStart(generation);
      const nativeState = await this.native.getStateAsync();
      this.ensureCurrentStart(generation);
      if (
        nativeState.activeRealtimeSessionId !== nativeSessionId ||
        nativeState.realtimeConnectionState === "failed" ||
        nativeState.realtimeConnectionState === "closed"
      ) {
        throw new Error("The Realtime media session ended during startup");
      }

      const active: ActiveSession = {
        sessionId: serverState.sessionId,
        nativeSessionId,
        leaseGeneration: serverState.leaseGeneration,
        serverState,
        afterSequence: serverState.sequence,
        lastServerError: null,
      };
      this.startingNativeSessionId = null;
      this.active = active;
      this.resetControlFailures();
      this.setSnapshot({
        phase: "active",
        session: active.serverState,
        native: nativeState,
        error: null,
      });
      this.startControlTimers();
      return this.snapshot;
    } catch (cause) {
      await this.cleanupPartialSession(serverState, nativeSessionId);
      if (generation !== this.startGeneration) return this.snapshot;
      this.startingNativeSessionId = null;
      this.setSnapshot({
        phase: "error",
        session: null,
        error: messageFor(cause),
      });
      throw cause;
    }
  }

  async stop(): Promise<void> {
    const startInFlight = this.startInFlight;
    const generation = ++this.startGeneration;
    this.startingNativeSessionId = null;
    this.clearControlTimers();
    const active = this.active;
    this.active = null;
    if (active === null) {
      this.setSnapshot({ phase: "idle", session: null, error: null });
      await startInFlight;
      return;
    }
    this.setSnapshot({
      phase: "stopping",
      session: active.serverState,
      error: null,
    });
    this.beginServerCleanup(active);
    await this.native
      .stopRealtimeSessionAsync({
        nativeSessionId: active.nativeSessionId,
      })
      .catch(() => undefined);
    if (generation !== this.startGeneration) return;
    const nativeState = await this.native.getStateAsync();
    if (generation !== this.startGeneration) return;
    this.setSnapshot({ native: nativeState });
    if (nativeState.activeRealtimeSessionId !== null) {
      this.setSnapshot({
        phase: "error",
        session: active.serverState,
        error: "The Realtime media session could not be stopped",
      });
      return;
    }
    this.setSnapshot({ phase: "idle", session: null, error: null });
  }

  async setMuted(muted: boolean): Promise<void> {
    const active = this.requireActive();
    await this.native.setRealtimeMutedAsync({
      nativeSessionId: active.nativeSessionId,
      muted,
    });
  }

  async updateFocus(projectId: ProjectId, threadId: ThreadId): Promise<void> {
    const active = this.requireActive();
    const result = await Effect.runPromise(
      this.client.updateSessionFocus(active.sessionId, active.leaseGeneration, {
        projectId,
        threadId,
      }),
    );
    if (this.active !== active)
      throw new Error("Realtime voice session changed during focus update");
    active.serverState = result.state;
    this.setSnapshot({ session: result.state });
  }

  getAudioRoutes(): Promise<ReadonlyArray<T3VoiceAudioRoute>> {
    this.requireActive();
    return this.native.getAudioRoutesAsync();
  }

  setAudioRoute(routeId: T3VoiceAudioRoute["id"]): Promise<ReadonlyArray<T3VoiceAudioRoute>> {
    const active = this.requireActive();
    return this.native.setAudioRouteAsync({
      nativeSessionId: active.nativeSessionId,
      routeId,
    });
  }

  decideConfirmation(
    confirmationId: VoiceConfirmationId,
    decision: VoiceConfirmationDecision,
  ): Promise<VoiceConfirmationResult> {
    const active = this.requireActive();
    return Effect.runPromise(
      this.client.decideConfirmation(active.sessionId, confirmationId, decision),
    );
  }

  acknowledgeClientAction(
    actionId: VoiceClientActionId,
    input: Omit<
      Extract<VoiceClientActionAckInput, { readonly action: "activate-thread" }>,
      "leaseGeneration"
    >,
  ): Promise<VoiceClientActionAckResult> {
    const active = this.requireActive();
    return Effect.runPromise(
      this.client.acknowledgeClientAction(active.sessionId, actionId, {
        ...input,
        leaseGeneration: active.leaseGeneration,
      }),
    );
  }

  async refreshEvents(): Promise<void> {
    if (this.detached) return;
    const active = this.active;
    if (active === null || this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      const result = await Effect.runPromise(
        this.client.sessionEvents(active.sessionId, active.afterSequence),
      );
      if (this.detached || this.active !== active) return;
      const terminalHandoff = result.events.some(
        (event) => event.type === "client-action" && event.action === "handoff-to-thread-voice",
      );
      if (terminalHandoff) {
        await this.native
          .armThreadVoiceHandoffAsync({ nativeSessionId: active.nativeSessionId })
          .catch(() => undefined);
        if (this.active !== active) return;
      }
      active.serverState = result.state;
      active.afterSequence = result.events.reduce(
        (sequence, event) => Math.max(sequence, event.sequence),
        active.afterSequence,
      );
      this.controlFailures.events = 0;
      this.setSnapshot({ session: result.state });
      if (result.events.length > 0) this.listener.onSessionEvents?.(result.events);
      const serverError = result.events.toReversed().find((event) => event.type === "error");
      if (serverError !== undefined) active.lastServerError = serverError.reason;
      const fenced = result.events.some((event) => event.type === "lease-fenced");
      if (fenced || result.state.phase === "ended" || result.state.phase === "error") {
        await this.cleanupAfterServerTermination(
          active,
          result.state.phase === "error"
            ? (active.lastServerError ?? "The Realtime voice session ended with an error")
            : null,
        );
      }
    } catch (cause) {
      if (this.active === active) this.handleControlFailure("events", cause);
    } finally {
      this.refreshInFlight = false;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.cleanupCoordinator.settled();
    this.removeSubscriptions();
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.startGeneration += 1;
    this.startingNativeSessionId = null;
    this.clearControlTimers();
    this.removeSubscriptions();
    const reconciliation = this.nativeRuntimeReconciliation;
    await Promise.all([
      this.startInFlight ?? Promise.resolve(),
      reconciliation?.catch(() => undefined) ?? Promise.resolve(),
    ]);
  }

  private startControlTimers() {
    this.clearControlTimers();
    this.eventTimer = this.scheduler.setInterval(() => {
      void this.refreshEvents();
    }, this.eventPollIntervalMs);
  }

  private handleControlFailure(operation: ControlOperation, cause: unknown) {
    this.controlFailures[operation] += 1;
    if (this.controlFailures[operation] < 3 || this.active === null) return;
    const message = controlFailureMessage(operation, cause);
    const active = this.active;
    this.active = null;
    this.clearControlTimers();
    void this.cleanupAfterControlFailure(active, message);
  }

  private async cleanupAfterControlFailure(active: ActiveSession, message: string) {
    const generation = ++this.startGeneration;
    this.beginServerCleanup(active);
    await this.native
      .stopRealtimeSessionAsync({ nativeSessionId: active.nativeSessionId })
      .catch(() => undefined);
    if (generation !== this.startGeneration) return;
    const nativeState = await this.native.getStateAsync().catch(() => null);
    if (generation !== this.startGeneration) return;
    if (nativeState === null || nativeState.activeRealtimeSessionId !== null) {
      this.setSnapshot({
        ...(nativeState === null ? {} : { native: nativeState }),
        phase: "error",
        session: active.serverState,
        error:
          nativeState === null
            ? `${message}. Native media shutdown could not be verified`
            : `${message}. The Realtime media session could not be stopped`,
      });
      return;
    }
    this.setSnapshot({
      native: nativeState,
      phase: "error",
      session: active.serverState,
      error: message,
    });
  }

  private handleNativeState(state: T3VoiceRuntimeState) {
    const currentSequence = this.snapshot.native?.sequence ?? -1;
    if (state.sequence < currentSequence) return;
    const expectedSessionId = this.active?.nativeSessionId ?? this.startingNativeSessionId;
    if (expectedSessionId !== null && state.activeRealtimeSessionId !== expectedSessionId) {
      return;
    }
    this.setSnapshot({ native: state });
  }

  private handleNativeError(event: T3VoiceRuntimeErrorEvent) {
    const active = this.active;
    if (active === null || event.operation !== `realtime:${active.nativeSessionId}`) return;
    this.setSnapshot({ error: nativeRuntimeErrorMessage(event.code) });
  }

  private handleNativeTermination(event: T3VoiceRealtimeTerminatedEvent) {
    const active = this.active;
    if (active === null || event.nativeSessionId !== active.nativeSessionId) return;
    void this.closeServerAfterNativeTermination(
      active,
      event.outcome === "ended" ? null : nativeTerminationMessage(event.code, event.retryable),
    );
  }

  private closeServerAfterNativeTermination(active: ActiveSession, error: string | null) {
    if (this.active !== active) return;
    this.startGeneration += 1;
    this.active = null;
    this.clearControlTimers();
    this.setSnapshot({
      phase: error === null ? "idle" : "error",
      session: null,
      error,
    });
    this.beginServerCleanup(active);
  }

  private beginServerCleanup(active: ServerCleanup) {
    this.cleanupCoordinator.enqueue(this.client, active);
  }

  private async cleanupAfterServerTermination(active: ActiveSession, error: string | null) {
    if (this.active !== active) return;
    const generation = ++this.startGeneration;
    this.active = null;
    this.clearControlTimers();
    await this.native
      .stopRealtimeSessionAsync({ nativeSessionId: active.nativeSessionId })
      .catch(() => undefined);
    if (generation !== this.startGeneration) return;
    const nativeState = await this.native.getStateAsync();
    if (generation !== this.startGeneration) return;
    this.setSnapshot({ native: nativeState });
    if (nativeState.activeRealtimeSessionId !== null) {
      this.setSnapshot({
        phase: "error",
        session: active.serverState,
        error: "The Realtime media session could not be stopped",
      });
      return;
    }
    this.setSnapshot({
      phase: error === null ? "idle" : "error",
      session: error === null ? null : active.serverState,
      error,
    });
  }

  private async cleanupPartialSession(
    serverState: VoiceSessionState | null,
    nativeSessionId: string | null,
  ) {
    if (serverState !== null) {
      this.beginServerCleanup({
        sessionId: serverState.sessionId,
        leaseGeneration: serverState.leaseGeneration,
      });
    }
    if (nativeSessionId !== null) {
      await this.native.stopRealtimeSessionAsync({ nativeSessionId }).catch(() => undefined);
    }
    await this.cleanupCoordinator.settled();
  }

  private clearControlTimers() {
    if (this.eventTimer !== null) this.scheduler.clearInterval(this.eventTimer);
    this.eventTimer = null;
  }

  private async reconcileNativeRuntimeOnce(): Promise<void> {
    const before = await this.native.getStateAsync();
    if (this.detached) return;
    this.setSnapshot({ native: before });
    const nativeSessionId = before.activeRealtimeSessionId;
    if (nativeSessionId === null) return;

    const sessionId = VoiceSessionId.make(nativeSessionId);
    const state = await Effect.runPromise(this.client.getSession(sessionId));
    if (this.detached) return;
    if (state.phase === "ended" || state.phase === "error") {
      let stopFailure: unknown = null;
      try {
        await this.native.stopRealtimeSessionAsync({ nativeSessionId });
      } catch (cause) {
        stopFailure = cause;
      }
      const after = await this.native.getStateAsync();
      this.setSnapshot({ native: after });
      if (after.activeRealtimeSessionId !== null) {
        throw stopFailure ?? new Error("The stale Realtime media session could not be stopped");
      }
      return;
    }

    const after = await this.native.getStateAsync();
    if (this.detached) return;
    this.setSnapshot({ native: after });
    if (after.activeRealtimeSessionId === null) return;
    if (after.activeRealtimeSessionId !== nativeSessionId) {
      throw new Error("The native Realtime session changed during attachment");
    }

    const active: ActiveSession = {
      sessionId: state.sessionId,
      nativeSessionId,
      leaseGeneration: state.leaseGeneration,
      serverState: state,
      // Native may have received server events while React was suspended. Replaying from the
      // beginning avoids creating an observation gap during attachment.
      afterSequence: 0,
      lastServerError: null,
    };
    this.active = active;
    this.resetControlFailures();
    this.setSnapshot({ phase: "active", session: state, native: after, error: null });
    this.startControlTimers();
  }

  private removeSubscriptions() {
    if (this.subscriptionsRemoved) return;
    this.subscriptionsRemoved = true;
    this.subscriptions.forEach((subscription) => subscription.remove());
  }

  private resetControlFailures() {
    this.controlFailures.events = 0;
  }

  private requireActive(): ActiveSession {
    const active = this.active;
    if (active === null) throw new Error("No Realtime voice session is active");
    return active;
  }

  private ensureCurrentStart(generation: number) {
    if (generation !== this.startGeneration)
      throw new Error("Realtime voice session start was cancelled");
  }

  private setSnapshot(update: Partial<RealtimeVoiceControllerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    if (!this.detached) this.listener.onSnapshot(this.snapshot);
  }
}

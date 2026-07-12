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
  readonly heartbeatIntervalMs: number;
  serverState: VoiceSessionState;
  afterSequence: number;
  lastServerError: string | null;
}

interface TimerScheduler {
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

type ControlOperation = "events" | "heartbeat";

export interface RealtimeVoiceControllerOptions {
  readonly scheduler?: TimerScheduler;
  readonly eventPollIntervalMs?: number;
  readonly serverCleanupTimeoutMs?: number;
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

const nativeTerminationMessage = (code: string): string => {
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

export class RealtimeVoiceController {
  private readonly scheduler: TimerScheduler;
  private readonly eventPollIntervalMs: number;
  private readonly serverCleanupTimeoutMs: number;
  private readonly subscriptions: ReadonlyArray<{
    readonly remove: () => void;
  }>;
  private active: ActiveSession | null = null;
  private heartbeatTimer: unknown | null = null;
  private eventTimer: unknown | null = null;
  private startGeneration = 0;
  private startingNativeSessionId: string | null = null;
  private refreshInFlight = false;
  private heartbeatInFlight = false;
  private nativeRuntimeReconciliation: Promise<void> | null = null;
  private serverCleanupBarrier: Promise<void> = Promise.resolve();
  private startInFlight: Promise<void> | null = null;
  private controlFailures: Record<ControlOperation, number> = {
    events: 0,
    heartbeat: 0,
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
    private readonly listener: RealtimeVoiceControllerListener,
    options: RealtimeVoiceControllerOptions = {},
  ) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.eventPollIntervalMs = options.eventPollIntervalMs ?? 1_000;
    this.serverCleanupTimeoutMs = options.serverCleanupTimeoutMs ?? 10_000;
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
    await this.serverCleanupBarrier;
    this.ensureCurrentStart(generation);

    let serverSession: VoiceSessionCreateResult | null = null;
    let nativeSessionId: string | null = null;
    try {
      const existingPermission = await this.native.getMicrophonePermissionAsync();
      const permission = existingPermission.granted
        ? existingPermission
        : await this.native.requestMicrophonePermissionAsync();
      if (!permission.granted) throw new Error("Microphone permission was not granted");
      this.ensureCurrentStart(generation);

      serverSession = await Effect.runPromise(this.client.createSession(input));
      this.ensureCurrentStart(generation);
      nativeSessionId = serverSession.state.sessionId;
      this.startingNativeSessionId = nativeSessionId;
      const nativeOffer = await this.native.prepareRealtimeSessionAsync({
        nativeSessionId,
      });
      this.ensureCurrentStart(generation);
      const answer = await Effect.runPromise(
        this.client.offerSession({
          sessionId: serverSession.state.sessionId,
          leaseGeneration: serverSession.state.leaseGeneration,
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
        sessionId: serverSession.state.sessionId,
        nativeSessionId,
        leaseGeneration: serverSession.state.leaseGeneration,
        heartbeatIntervalMs: serverSession.heartbeatIntervalSeconds * 1_000,
        serverState: serverSession.state,
        afterSequence: serverSession.state.sequence,
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
      this.startControlTimers(active);
      return this.snapshot;
    } catch (cause) {
      await this.cleanupPartialSession(serverSession?.state ?? null, nativeSessionId);
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
    input: Omit<VoiceClientActionAckInput, "leaseGeneration">,
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
    const active = this.active;
    if (active === null || this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      const result = await Effect.runPromise(
        this.client.sessionEvents(active.sessionId, active.afterSequence),
      );
      if (this.active !== active) return;
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
    await this.serverCleanupBarrier;
    this.subscriptions.forEach((subscription) => subscription.remove());
  }

  private startControlTimers(active: ActiveSession) {
    this.clearControlTimers();
    this.heartbeatTimer = this.scheduler.setInterval(() => {
      void this.heartbeat(active);
    }, active.heartbeatIntervalMs);
    this.eventTimer = this.scheduler.setInterval(() => {
      void this.refreshEvents();
    }, this.eventPollIntervalMs);
  }

  private async heartbeat(active: ActiveSession) {
    if (this.active !== active || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const state = await Effect.runPromise(
        this.client.heartbeatSession(active.sessionId, active.leaseGeneration),
      );
      if (this.active !== active) return;
      active.serverState = state;
      this.controlFailures.heartbeat = 0;
      this.setSnapshot({ session: state });
    } catch (cause) {
      if (this.active === active) this.handleControlFailure("heartbeat", cause);
    } finally {
      this.heartbeatInFlight = false;
    }
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
      event.outcome === "ended" ? null : nativeTerminationMessage(event.code),
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

  private beginServerCleanup(active: Pick<ActiveSession, "sessionId" | "leaseGeneration">) {
    const previous = this.serverCleanupBarrier;
    this.serverCleanupBarrier = previous
      .then(() =>
        Effect.runPromise(
          this.client
            .closeSession(active.sessionId, active.leaseGeneration)
            .pipe(Effect.timeout(`${this.serverCleanupTimeoutMs} millis`)),
        ),
      )
      .then(
        () => undefined,
        (cause) => {
          console.warn("[voice] server session cleanup failed", {
            sessionId: active.sessionId,
            leaseGeneration: active.leaseGeneration,
            errorTag: errorTag(cause) ?? "unknown",
          });
        },
      );
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
    await this.serverCleanupBarrier;
  }

  private clearControlTimers() {
    if (this.heartbeatTimer !== null) this.scheduler.clearInterval(this.heartbeatTimer);
    if (this.eventTimer !== null) this.scheduler.clearInterval(this.eventTimer);
    this.heartbeatTimer = null;
    this.eventTimer = null;
  }

  private async reconcileNativeRuntimeOnce(): Promise<void> {
    const before = await this.native.getStateAsync();
    this.setSnapshot({ native: before });
    const nativeSessionId = before.activeRealtimeSessionId;
    if (nativeSessionId === null) return;

    const sessionId = VoiceSessionId.make(nativeSessionId);
    const closeServer = async () => {
      try {
        const state = await Effect.runPromise(this.client.getSession(sessionId));
        await Effect.runPromise(this.client.closeSession(sessionId, state.leaseGeneration));
      } catch {
        // The native peer must still be stopped when its original environment or auth is unavailable.
      }
    };

    let stopFailure: unknown = null;
    try {
      await this.native.stopRealtimeSessionAsync({ nativeSessionId });
    } catch (cause) {
      stopFailure = cause;
    }
    await closeServer();

    const after = await this.native.getStateAsync();
    this.setSnapshot({ native: after });
    if (after.activeRealtimeSessionId !== null) {
      throw stopFailure ?? new Error("The orphaned Realtime media session could not be stopped");
    }
  }

  private resetControlFailures() {
    this.controlFailures.events = 0;
    this.controlFailures.heartbeat = 0;
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
    this.listener.onSnapshot(this.snapshot);
  }
}

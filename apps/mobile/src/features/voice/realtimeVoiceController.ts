import type {
  ProjectId,
  ThreadId,
  VoiceConfirmationDecision,
  VoiceConfirmationId,
  VoiceConfirmationResult,
  VoiceSessionCreateInput,
  VoiceSessionCreateResult,
  VoiceSessionEvent,
  VoiceSessionState,
} from "@t3tools/contracts";
import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import type {
  T3VoiceAudioRoute,
  T3VoiceNativeModule,
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
}

interface ActiveSession {
  readonly sessionId: VoiceSessionState["sessionId"];
  readonly nativeSessionId: string;
  readonly leaseGeneration: number;
  readonly heartbeatIntervalMs: number;
  serverState: VoiceSessionState;
  afterSequence: number;
}

interface TimerScheduler {
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface RealtimeVoiceControllerOptions {
  readonly scheduler?: TimerScheduler;
  readonly eventPollIntervalMs?: number;
}

const defaultScheduler: TimerScheduler = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

const messageFor = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class RealtimeVoiceController {
  private readonly scheduler: TimerScheduler;
  private readonly eventPollIntervalMs: number;
  private readonly subscriptions: ReadonlyArray<{ readonly remove: () => void }>;
  private active: ActiveSession | null = null;
  private heartbeatTimer: unknown | null = null;
  private eventTimer: unknown | null = null;
  private startGeneration = 0;
  private refreshInFlight = false;
  private consecutiveControlFailures = 0;
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
    this.subscriptions = [
      native.addListener("stateChanged", (state) => this.handleNativeState(state)),
      native.addListener("runtimeError", (event) => this.handleNativeError(event)),
    ];
  }

  getSnapshot(): RealtimeVoiceControllerSnapshot {
    return this.snapshot;
  }

  async start(input: VoiceSessionCreateInput): Promise<RealtimeVoiceControllerSnapshot> {
    if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") {
      throw new Error("A Realtime voice session is already starting or active");
    }
    const generation = ++this.startGeneration;
    this.setSnapshot({ phase: "starting", session: null, error: null });

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
      const nativeOffer = await this.native.prepareRealtimeSessionAsync({ nativeSessionId });
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

      const active: ActiveSession = {
        sessionId: serverSession.state.sessionId,
        nativeSessionId,
        leaseGeneration: serverSession.state.leaseGeneration,
        heartbeatIntervalMs: serverSession.heartbeatIntervalSeconds * 1_000,
        serverState: serverSession.state,
        afterSequence: serverSession.state.sequence,
      };
      this.active = active;
      this.consecutiveControlFailures = 0;
      this.setSnapshot({ phase: "active", session: active.serverState, error: null });
      this.startControlTimers(active);
      return this.snapshot;
    } catch (cause) {
      await this.cleanupPartialSession(serverSession?.state ?? null, nativeSessionId);
      if (generation !== this.startGeneration) return this.snapshot;
      this.setSnapshot({ phase: "error", session: null, error: messageFor(cause) });
      throw cause;
    }
  }

  async stop(): Promise<void> {
    ++this.startGeneration;
    this.clearControlTimers();
    const active = this.active;
    this.active = null;
    if (active === null) {
      this.setSnapshot({ phase: "idle", session: null, error: null });
      return;
    }
    this.setSnapshot({ phase: "stopping", session: active.serverState, error: null });
    await Promise.allSettled([
      this.native.stopRealtimeSessionAsync({ nativeSessionId: active.nativeSessionId }),
      Effect.runPromise(this.client.closeSession(active.sessionId, active.leaseGeneration)),
    ]);
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
      this.consecutiveControlFailures = 0;
      this.setSnapshot({ session: result.state });
      if (result.events.length > 0) this.listener.onSessionEvents?.(result.events);
      const fenced = result.events.some((event) => event.type === "lease-fenced");
      if (fenced || result.state.phase === "ended" || result.state.phase === "error") {
        await this.stop();
      }
    } catch (cause) {
      this.handleControlFailure(cause);
    } finally {
      this.refreshInFlight = false;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
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
    if (this.active !== active) return;
    try {
      const state = await Effect.runPromise(
        this.client.heartbeatSession(active.sessionId, active.leaseGeneration),
      );
      if (this.active !== active) return;
      active.serverState = state;
      this.consecutiveControlFailures = 0;
      this.setSnapshot({ session: state });
    } catch (cause) {
      this.handleControlFailure(cause);
    }
  }

  private handleControlFailure(cause: unknown) {
    this.consecutiveControlFailures += 1;
    if (this.consecutiveControlFailures < 3 || this.active === null) return;
    const message = `Realtime control connection failed: ${messageFor(cause)}`;
    const active = this.active;
    this.active = null;
    this.clearControlTimers();
    void Promise.allSettled([
      this.native.stopRealtimeSessionAsync({ nativeSessionId: active.nativeSessionId }),
      Effect.runPromise(this.client.closeSession(active.sessionId, active.leaseGeneration)),
    ]);
    this.setSnapshot({ phase: "error", session: active.serverState, error: message });
  }

  private handleNativeState(state: T3VoiceRuntimeState) {
    const active = this.active;
    this.setSnapshot({ native: state });
    if (
      active !== null &&
      this.snapshot.phase === "active" &&
      state.activeRealtimeSessionId === null
    ) {
      if (state.realtimeConnectionState === "closed") {
        void this.closeServerAfterNativeTermination(active, null);
      } else if (state.realtimeConnectionState === "failed") {
        void this.closeServerAfterNativeTermination(active, "The Realtime media connection failed");
      }
    }
  }

  private handleNativeError(event: T3VoiceRuntimeErrorEvent) {
    const active = this.active;
    if (active === null) {
      if (this.snapshot.phase === "error" && event.operation.startsWith("realtime:")) {
        this.setSnapshot({ error: event.message });
      }
      return;
    }
    if (event.operation !== `realtime:${active.nativeSessionId}`) return;
    this.setSnapshot({ error: event.message });
    if (!event.recoverable) void this.stop();
  }

  private async closeServerAfterNativeTermination(active: ActiveSession, error: string | null) {
    if (this.active !== active) return;
    this.active = null;
    this.clearControlTimers();
    await Effect.runPromise(
      this.client.closeSession(active.sessionId, active.leaseGeneration),
    ).catch(() => undefined);
    this.setSnapshot({
      phase: error === null ? "idle" : "error",
      session: null,
      error,
    });
  }

  private async cleanupPartialSession(
    serverState: VoiceSessionState | null,
    nativeSessionId: string | null,
  ) {
    await Promise.allSettled([
      ...(nativeSessionId === null
        ? []
        : [this.native.stopRealtimeSessionAsync({ nativeSessionId })]),
      ...(serverState === null
        ? []
        : [
            Effect.runPromise(
              this.client.closeSession(serverState.sessionId, serverState.leaseGeneration),
            ),
          ]),
    ]);
  }

  private clearControlTimers() {
    if (this.heartbeatTimer !== null) this.scheduler.clearInterval(this.heartbeatTimer);
    if (this.eventTimer !== null) this.scheduler.clearInterval(this.eventTimer);
    this.heartbeatTimer = null;
    this.eventTimer = null;
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

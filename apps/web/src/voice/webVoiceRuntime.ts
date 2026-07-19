import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  VoiceHttpClient,
  VoiceRealtimeContext,
  VoiceRealtimeTarget,
  VoiceRealtimeTranscriptTurn,
  VoiceRuntimeAdmissionOptions,
  VoiceRuntimeAdapter,
  VoiceRuntimeFailure,
  VoiceRuntimeSnapshot,
  VoiceRuntimeSnapshotListener,
  VoiceThreadStartInput,
  VoiceThreadReviewToken,
} from "@t3tools/client-runtime/voice";
import {
  CommandId,
  MessageId,
  VoicePlaybackId,
  VoiceRequestId,
  type EnvironmentId,
  type VoiceClientActionId,
  type VoiceClientActionOutcome,
  type VoiceConfirmationDecision,
  type VoiceConfirmationId,
  type VoiceConversationId,
  type VoiceSessionEvent,
  type VoiceSessionId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import { requestMicrophoneStream, startAudioCapture, waitForEndpoint } from "./audioCapture";
import { DEFAULT_WEB_VOICE_THREAD_SETTINGS } from "./defaultThreadSettings";
import { ExclusiveTransition } from "./exclusiveTransition";
import { makeVoiceLeaseTimers, type VoiceLeaseTimers } from "./leaseTimers";
import { VoiceMediaOwnerGate } from "./mediaOwner";
import { encodeMonoPcmToAacMp4 } from "./mp4Encode";
import { makeVoiceMultiTabLock, type VoiceMultiTabLockSnapshot } from "./multiTabLock";
import { makePcmPlayer, type PcmPlayer } from "./pcmPlayer";
import { makeWebVoiceHttpClient } from "./webVoiceHttpClient";

export type WebVoiceTerminalActions = ReadonlyArray<"stop-realtime" | "switch-to-thread">;

export interface WebThreadTurnDispatchInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: VoiceThreadStartInput["target"]["threadId"];
  readonly projectId: VoiceThreadStartInput["target"]["projectId"];
  readonly modelSelection: VoiceThreadStartInput["target"]["modelSelection"];
  readonly runtimeMode: VoiceThreadStartInput["target"]["runtimeMode"];
  readonly interactionMode: VoiceThreadStartInput["target"]["interactionMode"];
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
}

export interface WebThreadTurnWaitInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: VoiceThreadStartInput["target"]["threadId"];
  readonly messageId: MessageId;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * When true, keep waiting through approval/user-input attention instead of
   * returning early — used after the cycle has already surfaced attention once.
   */
  readonly ignoreAttention?: boolean;
}

export type WebThreadTurnWaitResult =
  | { readonly status: "completed"; readonly assistantText: string | null }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "attention"; readonly kind: "approval-required" | "user-input-required" }
  | { readonly status: "timeout" };

export interface WebVoiceRuntimeHooks {
  readonly getPrepared: (environmentId: EnvironmentId) => PreparedConnection | null;
  readonly makeClient?: (prepared: PreparedConnection) => Promise<VoiceHttpClient>;
  readonly dispatchThreadTurn?: (input: WebThreadTurnDispatchInput) => Promise<void>;
  readonly waitForThreadTurn?: (input: WebThreadTurnWaitInput) => Promise<WebThreadTurnWaitResult>;
  readonly onActivateThread?: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: VoiceThreadStartInput["target"]["projectId"];
    readonly threadId: VoiceThreadStartInput["target"]["threadId"];
  }) => Promise<void> | void;
  readonly createMessageId?: () => MessageId;
  readonly createCommandId?: () => CommandId;
  readonly createRequestId?: () => VoiceRequestId;
  /** When true, advertise switch-to-thread after Thread start handoff is available. */
  readonly advertiseSwitchToThread?: boolean;
}

export interface WebVoiceRuntime extends VoiceRuntimeAdapter {
  readonly getMultiTabSnapshot: () => VoiceMultiTabLockSnapshot;
  readonly subscribeMultiTab: (
    listener: (snapshot: VoiceMultiTabLockSnapshot) => void,
  ) => () => void;
  readonly requestMultiTabTakeover: () => Promise<boolean>;
  /**
   * One-shot composer dictation under exclusive media ownership.
   * Returns the final transcript, or null if empty/cancelled.
   */
  readonly dictate: (environmentId: EnvironmentId) => Promise<string | null>;
  readonly dispose: () => Promise<void>;
}

const WEB_MEDIA_CAPABILITIES = {
  transports: ["webrtc-sdp-v1"] as const,
  audioFormats: ["audio/mp4", "audio/pcm;rate=24000;encoding=s16le;channels=1"] as const,
  supportsInputRouteSelection: false,
  supportsOutputRouteSelection: false,
};

const idleSnapshot = (generation: number, sequence: number): VoiceRuntimeSnapshot => ({
  mode: "idle",
  generation,
  sequence,
});

const failureOf = (code: string, message: string, retryable = false): VoiceRuntimeFailure => ({
  code,
  message,
  retryable,
});

const randomId = (): string => `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type RealtimeSnapshot = Extract<VoiceRuntimeSnapshot, { readonly mode: "realtime" }>;

type ActiveRealtime = {
  readonly sessionId: VoiceSessionId;
  readonly conversationId: VoiceConversationId;
  readonly leaseGeneration: number;
  readonly heartbeatIntervalSeconds: number;
  readonly peer: RTCPeerConnection;
  readonly localStream: MediaStream;
  readonly remoteAudio: HTMLAudioElement;
  readonly client: VoiceHttpClient;
  readonly target: VoiceRealtimeTarget;
  muted: boolean;
  transcript: VoiceRealtimeTranscriptTurn[];
  pendingConfirmations: RealtimeSnapshot["pendingConfirmations"] extends ReadonlyArray<infer T>
    ? T[]
    : never;
  pendingClientActions: RealtimeSnapshot["pendingClientActions"] extends ReadonlyArray<infer T>
    ? T[]
    : never;
  afterSequence: number;
  eventLoop: AbortController;
  timers: VoiceLeaseTimers;
  heartbeatHandle: { cancel: () => void } | null;
};

export function makeWebVoiceRuntime(hooks: WebVoiceRuntimeHooks): WebVoiceRuntime {
  const transitions = new ExclusiveTransition();
  const mediaGate = new VoiceMediaOwnerGate();
  const makeClient = hooks.makeClient ?? makeWebVoiceHttpClient;
  const createMessageId = hooks.createMessageId ?? (() => MessageId.make(randomId()));
  const createCommandId = hooks.createCommandId ?? (() => CommandId.make(randomId()));
  const createRequestId = hooks.createRequestId ?? (() => VoiceRequestId.make(randomId()));
  const advertiseSwitchToThread = hooks.advertiseSwitchToThread ?? true;

  let generation = 0;
  let sequence = 0;
  let snapshot: VoiceRuntimeSnapshot = idleSnapshot(0, 0);
  const listeners = new Set<VoiceRuntimeSnapshotListener>();
  let disposed = false;
  let activeRealtime: ActiveRealtime | null = null;
  let threadAbort: AbortController | null = null;
  /**
   * Survives stopInternal nulling threadAbort so late Effect interruptions of the
   * *current* cycle still look like aborts. Reset at the start of each new operation
   * so a prior abort cannot mask early failures on a fresh start.
   */
  let lastThreadAbortSignal: AbortSignal | null = null;
  /** Abort signal for the cycle currently (or about to be) running. */
  let activeCycleAbortSignal: AbortSignal | null = null;
  /**
   * Bumped by stopInternal / dispose so in-flight startRealtimeInternal can detect
   * supersession even when activeRealtime is still null (connect window).
   */
  let startEpoch = 0;
  let reviewTranscript: string | null = null;
  let reviewId = 0;
  let pcmPlayer: PcmPlayer | null = null;
  let threadCycleRunning = false;
  let activeThreadCapture: { stop: () => void } | null = null;
  let resolveManualFinish: ((reason: "manual") => void) | null = null;
  type ReviewResolution =
    | { readonly action: "submit"; readonly transcript: string }
    | { readonly action: "discard" };
  let resolveReview: ((resolution: ReviewResolution) => void) | null = null;

  const formatVoiceHttpError = (cause: unknown): string => {
    if (cause instanceof Error) {
      const anyCause = cause as Error & { readonly detail?: string; readonly reason?: string };
      if (typeof anyCause.detail === "string" && anyCause.detail.trim().length > 0) {
        return anyCause.detail;
      }
      // Nested EnvironmentVoiceOperationError often appears in message after colon.
      const match = /EnvironmentVoiceOperationError:\s*(.+?)\)?$/.exec(cause.message);
      if (match?.[1]) return match[1].trim();
      return cause.message;
    }
    return String(cause);
  };

  const isCycleAbortCause = (cause: unknown, cycleSignal?: AbortSignal | null): boolean => {
    if (cause instanceof DOMException && cause.name === "AbortError") return true;
    // Prefer the signal for the operation that was in flight; only fall back to
    // lastThreadAbortSignal when that operation's signal is the one retained.
    const signal = cycleSignal ?? activeCycleAbortSignal;
    if (signal !== null && signal.aborted) return true;
    if (threadAbort !== null && threadAbort.signal.aborted) return true;
    // Late stream rejection after stopInternal nulled threadAbort/activeCycleAbortSignal:
    // only count when we still have a retained signal from that same cycle.
    if (
      cycleSignal == null &&
      activeCycleAbortSignal == null &&
      lastThreadAbortSignal !== null &&
      lastThreadAbortSignal.aborted
    ) {
      return true;
    }
    return false;
  };

  const runAbortableEffect = async <A, E>(
    effect: Effect.Effect<A, E>,
    signal: AbortSignal,
  ): Promise<A> => {
    const exit = await Effect.runPromiseExit(effect, { signal });
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    if (signal.aborted) {
      throw new DOMException("Thread voice aborted", "AbortError");
    }
    throw Cause.squash(exit.cause);
  };

  const multiTab = makeVoiceMultiTabLock({
    onTakeoverRequest: async () => {
      await stopInternal("multi-tab-takeover");
    },
  });

  const publish = (next: VoiceRuntimeSnapshot) => {
    sequence = next.sequence;
    generation = next.generation;
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // UI listeners must not break the runtime.
      }
    }
  };

  const publishNext = (next: Record<string, unknown> & { readonly generation?: number }) => {
    sequence += 1;
    const nextGeneration = typeof next.generation === "number" ? next.generation : generation;
    generation = nextGeneration;
    publish({
      ...next,
      generation: nextGeneration,
      sequence,
    } as VoiceRuntimeSnapshot);
  };

  const bumpGeneration = () => {
    generation += 1;
    return generation;
  };

  const ensureLeader = async (environmentId: EnvironmentId): Promise<void> => {
    const tab = multiTab.getSnapshot();
    // role "leader" can mean "free to acquire" when no elected owner exists.
    // Only skip acquire when this tab actually holds the lock (leaderTabId === us).
    if (tab.leaderTabId === multiTab.tabId) {
      multiTab.setOwnerEnvironment(environmentId);
      return;
    }
    const acquired = await multiTab.acquire(environmentId);
    if (!acquired) {
      throw new Error("Voice is active in another tab. Take over that tab first.");
    }
  };

  const stopPeer = async (realtime: ActiveRealtime) => {
    realtime.eventLoop.abort();
    realtime.heartbeatHandle?.cancel();
    realtime.timers.dispose();
    try {
      realtime.peer.close();
    } catch {
      // ignore
    }
    for (const track of realtime.localStream.getTracks()) {
      track.stop();
    }
    try {
      realtime.remoteAudio.pause();
      realtime.remoteAudio.srcObject = null;
    } catch {
      // ignore
    }
    try {
      await Effect.runPromise(
        realtime.client.closeSession(realtime.sessionId, realtime.leaseGeneration),
      );
    } catch {
      // Best-effort; server lease timeout is the authoritative reaper.
    }
  };

  const publishRealtime = (
    realtime: ActiveRealtime,
    phase: "starting" | "connected" | "stopping",
  ) => {
    publishNext({
      mode: "realtime",
      phase,
      generation,
      target: realtime.target,
      muted: realtime.muted,
      transcript: realtime.transcript,
      pendingConfirmations: realtime.pendingConfirmations,
      pendingClientActions: realtime.pendingClientActions,
    });
  };

  const handleRealtimeEvent = async (realtime: ActiveRealtime, event: VoiceSessionEvent) => {
    if (event.leaseGeneration !== realtime.leaseGeneration) return;
    realtime.afterSequence = Math.max(realtime.afterSequence, event.sequence);

    switch (event.type) {
      case "transcript": {
        if (event.final) {
          const last = realtime.transcript.at(-1);
          if (last && last.role === event.role && !last.text.endsWith(event.text)) {
            realtime.transcript = [
              ...realtime.transcript.slice(0, -1),
              { role: event.role, text: event.text },
            ];
          } else if (!last || last.role !== event.role || last.text !== event.text) {
            realtime.transcript = [...realtime.transcript, { role: event.role, text: event.text }];
          }
        } else {
          const last = realtime.transcript.at(-1);
          if (last && last.role === event.role) {
            realtime.transcript = [
              ...realtime.transcript.slice(0, -1),
              { role: event.role, text: event.text },
            ];
          } else {
            realtime.transcript = [...realtime.transcript, { role: event.role, text: event.text }];
          }
        }
        publishRealtime(realtime, "connected");
        return;
      }
      case "confirmation-required": {
        realtime.pendingConfirmations = [
          ...realtime.pendingConfirmations.filter(
            (item) => item.confirmationId !== event.confirmationId,
          ),
          {
            confirmationId: event.confirmationId,
            tool: event.tool,
            summary: event.summary,
            expiresAt: event.expiresAt,
          },
        ];
        publishRealtime(realtime, "connected");
        return;
      }
      case "client-action": {
        realtime.pendingClientActions = [
          ...realtime.pendingClientActions.filter((item) => item.actionId !== event.actionId),
          {
            action: event.action,
            actionId: event.actionId,
            projectId: event.projectId,
            threadId: event.threadId,
            expiresAt: event.expiresAt,
          },
        ];
        publishRealtime(realtime, "connected");
        return;
      }
      case "terminal-action": {
        if (event.action === "stop-realtime") {
          await stopInternal("terminal-stop");
          return;
        }
        if (event.action === "switch-to-thread") {
          if (!advertiseSwitchToThread) {
            await failAndRelease(
              realtime.target.environmentId,
              "realtime",
              failureOf(
                "unexpected-terminal-action",
                "switch-to-thread is not enabled on this client yet",
              ),
            );
            return;
          }
          const threadSettings =
            realtime.target.threadSettings ?? DEFAULT_WEB_VOICE_THREAD_SETTINGS;
          await switchRealtimeToThreadInternal({
            target: {
              environmentId: realtime.target.environmentId,
              projectId: event.target.projectId,
              threadId: event.target.threadId,
              modelSelection: event.target.modelSelection,
              runtimeMode: event.target.runtimeMode,
              interactionMode: event.target.interactionMode,
            },
            settings: threadSettings,
          });
        }
        return;
      }
      case "lease-fenced":
      case "rotation-required": {
        await failAndRelease(
          realtime.target.environmentId,
          "realtime",
          failureOf(
            event.type,
            event.type === "lease-fenced"
              ? "This voice session was taken over elsewhere"
              : "This voice session needs to be rotated",
            true,
          ),
        );
        return;
      }
      case "error": {
        await failAndRelease(
          realtime.target.environmentId,
          "realtime",
          failureOf("session-error", event.reason, event.recoverable),
        );
        return;
      }
      default:
        return;
    }
  };

  const runEventLoop = (realtime: ActiveRealtime) => {
    const loop = async () => {
      while (!realtime.eventLoop.signal.aborted && activeRealtime === realtime) {
        try {
          const page = await Effect.runPromise(
            realtime.client.sessionEvents(realtime.sessionId, realtime.afterSequence),
            { signal: realtime.eventLoop.signal },
          );
          if (activeRealtime !== realtime) return;
          for (const event of page.events) {
            await handleRealtimeEvent(realtime, event);
            if (activeRealtime !== realtime) return;
          }
        } catch (cause) {
          if (realtime.eventLoop.signal.aborted || activeRealtime !== realtime) return;
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          await failAndRelease(
            realtime.target.environmentId,
            "realtime",
            failureOf(
              "event-loop-failed",
              cause instanceof Error ? cause.message : "Voice event stream failed",
              true,
            ),
          );
          return;
        }
      }
    };
    void loop();
  };

  const startRealtimeInternal = async (
    target: VoiceRealtimeTarget,
    options?: VoiceRuntimeAdmissionOptions,
  ) => {
    // Capture epoch so a concurrent stopInternal (which bumps startEpoch) can
    // supersede this connect even while activeRealtime is still null.
    const epoch = startEpoch;
    lastThreadAbortSignal = null;
    const assertStillStarting = () => {
      if (epoch !== startEpoch || options?.signal?.aborted) {
        throw new DOMException("Voice start was cancelled", "AbortError");
      }
    };
    assertStillStarting();
    await ensureLeader(target.environmentId);
    assertStillStarting();

    const prepared = hooks.getPrepared(target.environmentId);
    if (prepared === null) {
      throw new Error("A prepared environment connection is required to start voice");
    }

    const gen = bumpGeneration();
    publishNext({
      mode: "realtime",
      phase: "starting",
      generation: gen,
      target,
      muted: false,
      transcript: [],
      pendingConfirmations: [],
      pendingClientActions: [],
    });

    const client = await makeClient(prepared);
    assertStillStarting();

    const capabilities = await Effect.runPromise(client.capabilities(), {
      signal: options?.signal,
    });
    assertStillStarting();
    const realtimeCap = capabilities.capabilities.find(
      (item) => item.capability === "agent.realtime",
    );
    if (realtimeCap?.state !== "ready") {
      throw new Error("Realtime voice is not ready on this environment");
    }

    const terminalActions: WebVoiceTerminalActions = advertiseSwitchToThread
      ? ["stop-realtime", "switch-to-thread"]
      : ["stop-realtime"];

    // Acquire mic early (user-gesture window) before longer network round-trips.
    const localStream = await requestMicrophoneStream();
    if (epoch !== startEpoch || options?.signal?.aborted) {
      for (const track of localStream.getTracks()) track.stop();
      throw new DOMException("Voice start was cancelled", "AbortError");
    }

    let peer: RTCPeerConnection | null = null;
    let remoteAudio: HTMLAudioElement | null = null;
    let mediaAdmissionGeneration: number | null = null;
    try {
      const admission = await mediaGate.admit("realtime", async () => ({
        release: async () => {
          // Release is driven by stopPeer / stopInternal once active.
        },
      }));
      mediaAdmissionGeneration = admission.generation;
      assertStillStarting();
      if (!mediaGate.isCurrent(admission.generation)) {
        throw new DOMException("Voice start was cancelled", "AbortError");
      }

      const session = await Effect.runPromise(
        client.createSession({
          mode: "realtime-agent",
          conversation: target.conversation,
          ...(target.focus
            ? { projectId: target.focus.projectId, threadId: target.focus.threadId }
            : {}),
          terminalActions: [...terminalActions],
          media: {
            transports: [...WEB_MEDIA_CAPABILITIES.transports],
            audioFormats: [...WEB_MEDIA_CAPABILITIES.audioFormats],
            supportsInputRouteSelection: false,
            supportsOutputRouteSelection: false,
          },
          idempotencyKey: randomId(),
        }),
        { signal: options?.signal },
      );
      assertStillStarting();

      peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      for (const track of localStream.getAudioTracks()) {
        peer.addTrack(track, localStream);
      }

      remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      peer.ontrack = (event) => {
        if (event.streams[0] && remoteAudio !== null) {
          remoteAudio.srcObject = event.streams[0];
          void remoteAudio.play().catch(() => undefined);
        }
      };

      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);
      // Wait briefly for ICE gathering in environments without trickle support.
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => resolve(), 2_000);
          peer!.onicegatheringstatechange = () => {
            if (peer!.iceGatheringState === "complete") {
              clearTimeout(timeout);
              resolve();
            }
          };
        });
      }
      assertStillStarting();
      const localSdp = peer.localDescription?.sdp;
      if (localSdp == null || localSdp.trim() === "") {
        throw new Error("Failed to create a WebRTC offer for Realtime voice");
      }

      const answer = await Effect.runPromise(
        client.offerSession({
          sessionId: session.state.sessionId,
          leaseGeneration: session.state.leaseGeneration,
          sdp: localSdp,
        }),
        { signal: options?.signal },
      );
      assertStillStarting();
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      assertStillStarting();
      // Final fence before go-live: stop may have released our admission mid-connect.
      if (
        epoch !== startEpoch ||
        mediaAdmissionGeneration === null ||
        !mediaGate.isCurrent(mediaAdmissionGeneration)
      ) {
        throw new DOMException("Voice start was cancelled", "AbortError");
      }

      const timers = makeVoiceLeaseTimers();
      const eventLoop = new AbortController();
      const realtime: ActiveRealtime = {
        sessionId: session.state.sessionId,
        conversationId: session.state.conversationId,
        leaseGeneration: session.state.leaseGeneration,
        heartbeatIntervalSeconds: session.heartbeatIntervalSeconds,
        peer,
        localStream,
        remoteAudio,
        client,
        target,
        muted: false,
        transcript: [],
        pendingConfirmations: [],
        pendingClientActions: [],
        afterSequence: session.state.sequence,
        eventLoop,
        timers,
        heartbeatHandle: null,
      };
      activeRealtime = realtime;

      realtime.heartbeatHandle = timers.interval(
        Math.max(1, session.heartbeatIntervalSeconds) * 1_000,
        () => {
          if (activeRealtime !== realtime) return;
          void Effect.runPromise(
            client.heartbeatSession(realtime.sessionId, realtime.leaseGeneration),
          ).catch(async (cause) => {
            if (activeRealtime !== realtime) return;
            await failAndRelease(
              target.environmentId,
              "realtime",
              failureOf(
                "heartbeat-failed",
                cause instanceof Error ? cause.message : "Voice heartbeat failed",
                true,
              ),
            );
          });
        },
      );

      runEventLoop(realtime);
      multiTab.setOwnerEnvironment(target.environmentId);
      publishRealtime(realtime, "connected");
    } catch (cause) {
      // Mic/peer may leak if we fail before activeRealtime is assigned.
      try {
        peer?.close();
      } catch {
        // ignore
      }
      for (const track of localStream.getTracks()) {
        track.stop();
      }
      if (remoteAudio !== null) {
        try {
          remoteAudio.pause();
          remoteAudio.srcObject = null;
        } catch {
          // ignore
        }
      }
      // Only release the gate if we still own the admission we installed.
      if (mediaAdmissionGeneration !== null && mediaGate.isCurrent(mediaAdmissionGeneration)) {
        await mediaGate.releaseExact().catch(() => undefined);
      }
      throw cause;
    }
  };

  const failAndRelease = async (
    environmentId: EnvironmentId,
    operation: "realtime" | "thread" | "switching-to-thread" | "switching-to-realtime",
    failure: VoiceRuntimeFailure,
  ) => {
    const realtime = activeRealtime;
    activeRealtime = null;
    threadAbort?.abort();
    threadAbort = null;
    pcmPlayer?.cancel();
    if (realtime !== null) {
      await stopPeer(realtime);
    }
    await mediaGate.releaseExact();
    multiTab.release();
    const gen = bumpGeneration();
    publishNext({
      mode: "failed",
      generation: gen,
      environmentId,
      operation,
      failure,
    });
  };

  const stopInternal = async (_reason: string) => {
    // Supersede any in-flight startRealtimeInternal before tearing down.
    startEpoch += 1;
    const realtime = activeRealtime;
    activeRealtime = null;
    resolveReview?.({ action: "discard" });
    resolveReview = null;
    resolveManualFinish = null;
    threadAbort?.abort();
    threadAbort = null;
    // Keep lastThreadAbortSignal for in-flight Effect interruption mapping, but
    // clear activeCycleAbortSignal so a later start's early guards aren't masked.
    activeCycleAbortSignal = null;
    // Best-effort capture stop in case media-gate release races the capture install.
    try {
      activeThreadCapture?.stop();
    } catch {
      // ignore
    }
    activeThreadCapture = null;
    pcmPlayer?.cancel();
    if (realtime !== null) {
      const gen = bumpGeneration();
      publishNext({
        mode: "realtime",
        phase: "stopping",
        generation: gen,
        target: realtime.target,
        muted: realtime.muted,
        transcript: realtime.transcript,
        pendingConfirmations: realtime.pendingConfirmations,
        pendingClientActions: realtime.pendingClientActions,
      });
      await stopPeer(realtime);
    }
    await mediaGate.releaseExact();
    multiTab.release();
    const gen = bumpGeneration();
    publish(idleSnapshot(gen, sequence + 1));
  };

  const collectAssistantTextFromSpeechStream = async (
    client: VoiceHttpClient,
    text: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> => {
    const requestId = createRequestId() as VoiceRequestId;
    const playbackId = VoicePlaybackId.make(randomId());
    const ticket = await runAbortableEffect(
      client.createMediaTicket({ operation: "speech-stream", requestId }),
      signal,
    );
    const chunks: Uint8Array[] = [];
    await Effect.runPromise(
      Stream.runForEach(
        client.synthesize({
          request: {
            requestId,
            playbackId,
            segmentIndex: 0,
            finalSegment: true,
            text,
            preset: "default",
          },
          ticket,
        }),
        (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
      ),
      { signal },
    );
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };

  const runThreadCycle = async (input: VoiceThreadStartInput) => {
    if (threadCycleRunning) {
      throw new Error("Thread voice cycle is already running");
    }
    threadCycleRunning = true;
    // Clear prior-cycle abort signals before any early guards so a previous stop
    // or finished dictation cannot misclassify a fresh start failure as an abort.
    activeCycleAbortSignal = null;
    lastThreadAbortSignal = null;
    const prepared = hooks.getPrepared(input.target.environmentId);
    if (prepared === null) {
      threadCycleRunning = false;
      throw new Error("A prepared environment connection is required for Thread voice");
    }
    if (hooks.dispatchThreadTurn == null || hooks.waitForThreadTurn == null) {
      threadCycleRunning = false;
      throw new Error("Thread voice orchestration hooks are not configured");
    }

    try {
      const abort = new AbortController();
      // Assign early so mid-cycle stop classification stays accurate.
      activeCycleAbortSignal = abort.signal;
      lastThreadAbortSignal = abort.signal;
      threadAbort?.abort();
      threadAbort = abort;
      await ensureLeader(input.target.environmentId);
      const gen = bumpGeneration();

      publishNext({
        mode: "thread",
        phase: "starting",
        generation: gen,
        target: input.target,
        settings: input.settings,
        transcript: null,
        reviewId: null,
        attention: null,
      });

      await mediaGate.admit("thread-auto-listen", async () => ({
        release: async () => {
          resolveReview?.({ action: "discard" });
          resolveReview = null;
          resolveManualFinish = null;
          abort.abort();
          pcmPlayer?.cancel();
          try {
            activeThreadCapture?.stop();
          } catch {
            // ignore
          }
          activeThreadCapture = null;
        },
      }));

      const client = await makeClient(prepared);
      const capabilities = await runAbortableEffect(client.capabilities(), abort.signal);
      const sttCap = capabilities.capabilities.find(
        (item) => item.capability === "transcription.request",
      );
      if (sttCap?.state !== "ready") {
        throw new Error("Voice transcription is not ready on this environment");
      }

      // Continuous loop for autoRearm; single pass otherwise.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (abort.signal.aborted) break;

        publishNext({
          mode: "thread",
          phase: "recording",
          generation,
          target: input.target,
          settings: input.settings,
          transcript: null,
          reviewId: null,
          attention: null,
        });

        const stream = await requestMicrophoneStream();
        const capture = await startAudioCapture(stream);
        activeThreadCapture = capture;
        let endpoint: "silence" | "no-speech" | "max-utterance" | "manual" = "manual";
        let manualFinished = false;
        const endpointAbort = new AbortController();
        const onParentAbort = () => endpointAbort.abort();
        abort.signal.addEventListener("abort", onParentAbort, { once: true });
        try {
          endpoint = await new Promise<"silence" | "no-speech" | "max-utterance" | "manual">(
            (resolve, reject) => {
              let settled = false;
              const finish = (
                next: "silence" | "no-speech" | "max-utterance" | "manual" | Error,
              ) => {
                if (settled) return;
                settled = true;
                if (resolveManualFinish === settleManual) {
                  resolveManualFinish = null;
                }
                if (next instanceof Error) reject(next);
                else resolve(next);
              };
              const settleManual = (reason: "manual") => {
                manualFinished = true;
                endpointAbort.abort();
                finish(reason);
              };
              resolveManualFinish = settleManual;
              void waitForEndpoint({
                capture,
                config: input.settings.endpointDetection,
                signal: endpointAbort.signal,
              }).then(
                (reason) => finish(reason),
                (cause) => finish(cause instanceof Error ? cause : new Error(String(cause))),
              );
            },
          );
        } catch (cause) {
          capture.stop();
          activeThreadCapture = null;
          if (manualFinished) {
            // Manual finish aborted the waiter after resolving — continue with PCM.
          } else if (abort.signal.aborted) {
            break;
          } else {
            throw cause;
          }
        } finally {
          abort.signal.removeEventListener("abort", onParentAbort);
          resolveManualFinish = null;
        }

        // Never finalize/transcribe after stop/handoff during recording.
        if (abort.signal.aborted) {
          try {
            capture.stop();
          } catch {
            // ignore
          }
          activeThreadCapture = null;
          break;
        }

        publishNext({
          mode: "thread",
          phase: "finalizing",
          generation,
          target: input.target,
          settings: input.settings,
          transcript: null,
          reviewId: null,
          attention: null,
        });

        const pcm = capture.getPcmMono();
        const captureSampleRate = capture.sampleRate;
        capture.stop();
        activeThreadCapture = null;

        if (endpoint === "no-speech" || pcm.length < 1600) {
          if (!input.settings.autoRearm) break;
          publishNext({
            mode: "thread",
            phase: "rearming",
            generation,
            target: input.target,
            settings: input.settings,
            transcript: null,
            reviewId: null,
            attention: null,
          });
          await delay(input.settings.rearmDelayMs, abort.signal);
          continue;
        }

        publishNext({
          mode: "thread",
          phase: "transcribing",
          generation,
          target: input.target,
          settings: input.settings,
          transcript: null,
          reviewId: null,
          attention: null,
        });

        const encoded = await encodeMonoPcmToAacMp4({
          pcm,
          sampleRate: Math.round(captureSampleRate),
        });

        const requestId = createRequestId() as VoiceRequestId;
        const ticket = await runAbortableEffect(
          client.createMediaTicket({ operation: "transcription-upload", requestId }),
          abort.signal,
        );

        let transcriptText = "";
        await Effect.runPromise(
          Stream.runForEach(
            client.transcribe({
              audio: {
                kind: "blob",
                value: encoded.blob,
                filename: "utterance.mp4",
              },
              metadata: {
                requestId,
                format: "audio/mp4",
              },
              ticket,
            }),
            (event) =>
              Effect.sync(() => {
                if (event.type === "delta") {
                  transcriptText += event.text;
                } else if (event.type === "final") {
                  transcriptText = event.result.text;
                }
              }),
          ),
          { signal: abort.signal },
        );

        transcriptText = transcriptText.trim();
        if (transcriptText.length === 0) {
          if (!input.settings.autoRearm) break;
          await delay(input.settings.rearmDelayMs, abort.signal);
          continue;
        }

        let transcriptToSubmit = transcriptText;
        if (input.settings.submission === "review") {
          reviewId += 1;
          reviewTranscript = transcriptText;
          publishNext({
            mode: "thread",
            phase: "reviewing",
            generation,
            target: input.target,
            settings: input.settings,
            transcript: transcriptText,
            reviewId,
            attention: null,
          });
          // Cycle owns submit + teardown; submitThreadTranscript only resolves this.
          const reviewOutcome = await new Promise<ReviewResolution>((resolve) => {
            const onAbort = () => {
              resolveReview = null;
              resolve({ action: "discard" });
            };
            if (abort.signal.aborted) {
              onAbort();
              return;
            }
            abort.signal.addEventListener("abort", onAbort, { once: true });
            resolveReview = (resolution) => {
              abort.signal.removeEventListener("abort", onAbort);
              resolveReview = null;
              resolve(resolution);
            };
          });

          if (reviewOutcome.action === "discard" || abort.signal.aborted) {
            break;
          }
          transcriptToSubmit =
            reviewOutcome.transcript.trim().length > 0
              ? reviewOutcome.transcript.trim()
              : transcriptText;
        }

        // Never dispatch a turn after stop/handoff during encode/transcribe.
        if (abort.signal.aborted) break;

        await submitTranscriptAndWait({
          input,
          client,
          transcript: transcriptToSubmit,
          abort,
        });

        if (abort.signal.aborted) break;
        if (!input.settings.autoRearm) break;

        publishNext({
          mode: "thread",
          phase: "rearming",
          generation,
          target: input.target,
          settings: input.settings,
          transcript: null,
          reviewId: null,
          attention: null,
        });
        await delay(input.settings.rearmDelayMs, abort.signal);
      }

      if (!abort.signal.aborted) {
        await mediaGate.releaseExact();
        multiTab.release();
        const doneGen = bumpGeneration();
        publish(idleSnapshot(doneGen, sequence + 1));
      }
    } finally {
      threadCycleRunning = false;
      resolveReview = null;
      resolveManualFinish = null;
      if (activeCycleAbortSignal === threadAbort?.signal) {
        activeCycleAbortSignal = null;
      }
    }
  };

  const submitTranscriptAndWait = async (args: {
    readonly input: VoiceThreadStartInput;
    readonly client: VoiceHttpClient;
    readonly transcript: string;
    readonly abort: AbortController;
  }) => {
    const { input, client, transcript, abort } = args;
    const messageId = createMessageId();
    const commandId = createCommandId();

    publishNext({
      mode: "thread",
      phase: "submitting",
      generation,
      target: input.target,
      settings: input.settings,
      transcript,
      reviewId: null,
      attention: null,
    });

    await hooks.dispatchThreadTurn!({
      environmentId: input.target.environmentId,
      threadId: input.target.threadId,
      projectId: input.target.projectId,
      modelSelection: input.target.modelSelection,
      runtimeMode: input.target.runtimeMode,
      interactionMode: input.target.interactionMode,
      messageId,
      commandId,
      text: transcript,
    });

    publishNext({
      mode: "thread",
      phase: "waiting",
      generation,
      target: input.target,
      settings: input.settings,
      transcript,
      reviewId: null,
      attention: null,
    });

    const outcome = await hooks.waitForThreadTurn!({
      environmentId: input.target.environmentId,
      threadId: input.target.threadId,
      messageId,
      timeoutMs: input.settings.responseTimeoutMs,
      signal: abort.signal,
    });

    if (abort.signal.aborted) {
      throw new DOMException("Thread voice aborted", "AbortError");
    }

    if (outcome.status === "failed" && outcome.message === "Thread wait aborted") {
      throw new DOMException("Thread voice aborted", "AbortError");
    }

    // Attention is temporary: surface it, then keep waiting for completion.
    let finalOutcome = outcome;
    while (finalOutcome.status === "attention" && !abort.signal.aborted) {
      publishNext({
        mode: "thread",
        phase: "waiting",
        generation,
        target: input.target,
        settings: input.settings,
        transcript,
        reviewId: null,
        attention: finalOutcome.kind,
      });
      finalOutcome = await hooks.waitForThreadTurn!({
        environmentId: input.target.environmentId,
        threadId: input.target.threadId,
        messageId,
        timeoutMs: input.settings.responseTimeoutMs,
        signal: abort.signal,
        ignoreAttention: true,
      });
    }

    if (abort.signal.aborted) {
      throw new DOMException("Thread voice aborted", "AbortError");
    }

    if (finalOutcome.status === "failed" && finalOutcome.message === "Thread wait aborted") {
      throw new DOMException("Thread voice aborted", "AbortError");
    }

    if (finalOutcome.status === "failed" || finalOutcome.status === "timeout") {
      throw new Error(
        finalOutcome.status === "timeout"
          ? "Timed out waiting for the Thread turn"
          : finalOutcome.message,
      );
    }

    if (
      finalOutcome.status === "completed" &&
      input.settings.playResponses &&
      finalOutcome.assistantText &&
      finalOutcome.assistantText.length > 0
    ) {
      const speechCap = (
        await runAbortableEffect(client.capabilities(), abort.signal)
      ).capabilities.find((item) => item.capability === "speech.streaming");
      if (speechCap?.state === "ready") {
        publishNext({
          mode: "thread",
          phase: "playing",
          generation,
          target: input.target,
          settings: input.settings,
          transcript,
          reviewId: null,
          attention: null,
        });
        pcmPlayer ??= makePcmPlayer(24_000);
        const pcm = await collectAssistantTextFromSpeechStream(
          client,
          finalOutcome.assistantText,
          abort.signal,
        );
        await pcmPlayer.play(pcm);
      }
    }
  };

  const dictateInternal = async (environmentId: EnvironmentId): Promise<string | null> => {
    lastThreadAbortSignal = null;
    await ensureLeader(environmentId);
    const prepared = hooks.getPrepared(environmentId);
    if (prepared === null) {
      throw new Error("A prepared environment connection is required for dictation");
    }
    const abort = new AbortController();
    threadAbort?.abort();
    threadAbort = abort;
    lastThreadAbortSignal = abort.signal;
    activeCycleAbortSignal = abort.signal;

    let capture: Awaited<ReturnType<typeof startAudioCapture>> | null = null;
    const admission = await mediaGate.admit("dictation", async () => ({
      release: async () => {
        abort.abort();
        try {
          capture?.stop();
        } catch {
          // ignore
        }
        capture = null;
      },
    }));
    const admissionGeneration = admission.generation;

    try {
      const client = await makeClient(prepared);
      const capabilities = await runAbortableEffect(client.capabilities(), abort.signal);
      const sttCap = capabilities.capabilities.find(
        (item) => item.capability === "transcription.request",
      );
      if (sttCap?.state !== "ready") {
        throw new Error("Voice transcription is not ready on this environment");
      }

      const stream = await requestMicrophoneStream();
      capture = await startAudioCapture(stream);
      try {
        await waitForEndpoint({
          capture,
          config: {
            endSilenceMs: 900,
            noSpeechTimeoutMs: 8_000,
            maximumUtteranceMs: 60_000,
          },
          signal: abort.signal,
        });
      } catch (cause) {
        if (abort.signal.aborted) return null;
        throw cause;
      }
      const pcm = capture.getPcmMono();
      const sampleRate = capture.sampleRate;
      capture.stop();
      capture = null;
      if (abort.signal.aborted || pcm.length < 1600) return null;

      const encoded = await encodeMonoPcmToAacMp4({ pcm, sampleRate });
      const requestId = createRequestId();
      const ticket = await runAbortableEffect(
        client.createMediaTicket({ operation: "transcription-upload", requestId }),
        abort.signal,
      );
      let text = "";
      await Effect.runPromise(
        Stream.runForEach(
          client.transcribe({
            audio: { kind: "blob", value: encoded.blob, filename: "dictation.mp4" },
            metadata: { requestId, format: "audio/mp4" },
            ticket,
          }),
          (event) =>
            Effect.sync(() => {
              if (event.type === "delta") text += event.text;
              else if (event.type === "final") text = event.result.text;
            }),
        ),
        { signal: abort.signal },
      );
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    } finally {
      try {
        capture?.stop();
      } catch {
        // ignore
      }
      // Only release gate/lock if we still own the admission — a newer owner
      // (Realtime/Thread) may have fenced us out via mediaGate.admit.
      if (mediaGate.isCurrent(admissionGeneration)) {
        await mediaGate.releaseExact();
        multiTab.release();
      }
      if (threadAbort === abort) {
        threadAbort = null;
      }
      if (activeCycleAbortSignal === abort.signal) {
        activeCycleAbortSignal = null;
      }
    }
  };

  const switchRealtimeToThreadInternal = async (input: VoiceThreadStartInput) => {
    const gen = bumpGeneration();
    publishNext({
      mode: "switching-to-thread",
      phase: "closing-realtime",
      generation: gen,
      target: input.target,
      settings: input.settings,
    });
    const realtime = activeRealtime;
    activeRealtime = null;
    if (realtime !== null) {
      await stopPeer(realtime);
    }
    await mediaGate.releaseExact();
    publishNext({
      mode: "switching-to-thread",
      phase: "starting-recorder",
      generation: gen,
      target: input.target,
      settings: input.settings,
    });
    // Detach cycle so callers (terminal-action / startThread) do not hold the transition.
    void runThreadCycle(input).catch(async (cause) => {
      if (isCycleAbortCause(cause, activeCycleAbortSignal)) {
        if (snapshot.mode !== "idle" && snapshot.mode !== "realtime") {
          await stopInternal("aborted");
        }
        return;
      }
      await failAndRelease(
        input.target.environmentId,
        "switching-to-thread",
        failureOf(
          "switch-to-thread-failed",
          cause instanceof Error ? cause.message : "Failed to switch to Thread voice",
          true,
        ),
      );
    });
  };

  const command = async (operation: () => Promise<void>): Promise<void> => {
    if (disposed) throw new Error("Voice runtime is disposed");
    const admitted = await transitions.run(operation);
    if (!admitted) {
      // Duplicate in-flight transition — no-op per adapter contract.
    }
  };

  const adapter: WebVoiceRuntime = {
    getSnapshot: async () => snapshot,
    subscribe: async (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    startRealtime: (target, options) =>
      command(async () => {
        if (snapshot.mode === "thread") {
          const gen = bumpGeneration();
          publishNext({
            mode: "switching-to-realtime",
            generation: gen,
            source: snapshot.target,
            target,
          });
          threadAbort?.abort();
          threadAbort = null;
          await mediaGate.releaseExact();
        } else if (snapshot.mode === "realtime") {
          return;
        }
        try {
          await startRealtimeInternal(target, options);
        } catch (cause) {
          // Supersession from stop/takeover/dictation throws AbortError after
          // carefully not releasing a newer owner's gate — do not failAndRelease.
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          await failAndRelease(
            target.environmentId,
            "realtime",
            failureOf(
              "start-realtime-failed",
              formatVoiceHttpError(cause) || "Failed to start Realtime voice",
              true,
            ),
          );
        }
      }),
    startThread: (input) =>
      command(async () => {
        if (snapshot.mode === "realtime") {
          // Handoff admission under the transition; cycle itself is detached.
          const realtime = activeRealtime;
          activeRealtime = null;
          const gen = bumpGeneration();
          publishNext({
            mode: "switching-to-thread",
            phase: "closing-realtime",
            generation: gen,
            target: input.target,
            settings: input.settings,
          });
          if (realtime !== null) {
            await stopPeer(realtime);
          }
          await mediaGate.releaseExact();
          publishNext({
            mode: "switching-to-thread",
            phase: "starting-recorder",
            generation: gen,
            target: input.target,
            settings: input.settings,
          });
        } else if (snapshot.mode === "thread" || threadCycleRunning) {
          return;
        }
        // Detach the long-running cycle so stop()/startRealtime stay available.
        void runThreadCycle(input).catch(async (cause) => {
          if (isCycleAbortCause(cause, activeCycleAbortSignal)) {
            // stopInternal may already have published idle; avoid failed chrome.
            if (snapshot.mode !== "idle" && snapshot.mode !== "realtime") {
              await stopInternal("aborted");
            }
            return;
          }
          await failAndRelease(
            input.target.environmentId,
            "thread",
            failureOf(
              "start-thread-failed",
              cause instanceof Error ? cause.message : "Failed to start Thread voice",
              true,
            ),
          );
        });
      }),
    switchRealtimeToThread: (input) => adapter.startThread(input),
    // Stop must interrupt in-flight transitions (spec: always available).
    stop: () => stopInternal("user-stop"),
    dictate: async (environmentId) => {
      if (disposed) throw new Error("Voice runtime is disposed");
      // Stop any active voice path so dictation can claim exclusive media.
      // stop is intentionally outside ExclusiveTransition so it can interrupt cycles.
      if (snapshot.mode !== "idle" || threadCycleRunning || activeRealtime !== null) {
        await stopInternal("dictation-replace");
      }
      try {
        return await dictateInternal(environmentId);
      } catch (cause) {
        if (isCycleAbortCause(cause)) return null;
        throw cause;
      }
    },
    setRealtimeMuted: async (muted) => {
      if (activeRealtime === null) return;
      activeRealtime.muted = muted;
      for (const track of activeRealtime.localStream.getAudioTracks()) {
        track.enabled = !muted;
      }
      publishRealtime(activeRealtime, "connected");
    },
    updateRealtimeContext: async (context: VoiceRealtimeContext) => {
      if (activeRealtime === null) return;
      const nextTarget: VoiceRealtimeTarget = {
        ...activeRealtime.target,
        focus: context.focus,
        threadSettings: context.threadSettings,
      };
      // Mutate in place — heartbeat/event-loop fence on object identity.
      (activeRealtime as { target: VoiceRealtimeTarget }).target = nextTarget;
      const terminalActions: WebVoiceTerminalActions = advertiseSwitchToThread
        ? ["stop-realtime", "switch-to-thread"]
        : ["stop-realtime"];
      try {
        await Effect.runPromise(
          activeRealtime.client.updateSessionFocus(
            activeRealtime.sessionId,
            activeRealtime.leaseGeneration,
            context.focus
              ? {
                  terminalActions: [...terminalActions],
                  projectId: context.focus.projectId,
                  threadId: context.focus.threadId,
                }
              : { terminalActions: [...terminalActions] },
          ),
        );
      } catch {
        // Focus updates are best-effort; keep local snapshot coherent.
      }
      publishRealtime(activeRealtime, snapshot.mode === "realtime" ? snapshot.phase : "connected");
    },
    decideRealtimeConfirmation: async (confirmationId, decision) => {
      if (activeRealtime === null) return;
      await Effect.runPromise(
        activeRealtime.client.decideConfirmation(
          activeRealtime.sessionId,
          confirmationId,
          decision,
        ),
      );
      activeRealtime.pendingConfirmations = activeRealtime.pendingConfirmations.filter(
        (item) => item.confirmationId !== confirmationId,
      );
      publishRealtime(activeRealtime, "connected");
    },
    completeRealtimeClientAction: async (actionId, outcome, message) => {
      if (activeRealtime === null) return;
      const action = activeRealtime.pendingClientActions.find((item) => item.actionId === actionId);
      if (action?.action === "activate-thread" && outcome === "succeeded") {
        await hooks.onActivateThread?.({
          environmentId: activeRealtime.target.environmentId,
          projectId: action.projectId,
          threadId: action.threadId,
        });
        // Admit focus update before ack per adapter contract.
        await adapter.updateRealtimeContext({
          focus: { projectId: action.projectId, threadId: action.threadId },
          threadSettings: activeRealtime.target.threadSettings,
        });
      }
      await Effect.runPromise(
        activeRealtime.client.acknowledgeClientAction(activeRealtime.sessionId, actionId, {
          leaseGeneration: activeRealtime.leaseGeneration,
          outcome,
          ...(message !== undefined ? { message } : {}),
        }),
      );
      activeRealtime.pendingClientActions = activeRealtime.pendingClientActions.filter(
        (item) => item.actionId !== actionId,
      );
      publishRealtime(activeRealtime, "connected");
    },
    finishThreadRecording: async () => {
      if (snapshot.mode === "thread" && snapshot.phase === "recording") {
        resolveManualFinish?.("manual");
        resolveManualFinish = null;
      }
    },
    updateThreadReviewTranscript: async (token, transcript) => {
      if (
        snapshot.mode !== "thread" ||
        snapshot.phase !== "reviewing" ||
        snapshot.reviewId !== token.reviewId ||
        snapshot.generation !== token.generation
      ) {
        return;
      }
      reviewTranscript = transcript;
      publishNext({
        ...snapshot,
        transcript,
      });
    },
    submitThreadTranscript: async (token, transcript) => {
      if (
        snapshot.mode !== "thread" ||
        snapshot.phase !== "reviewing" ||
        snapshot.reviewId !== token.reviewId ||
        snapshot.generation !== token.generation
      ) {
        return;
      }
      // Hand the transcript back to the cycle owner — do not submit/teardown here.
      resolveReview?.({
        action: "submit",
        transcript: transcript.trim().length > 0 ? transcript.trim() : (reviewTranscript ?? ""),
      });
      resolveReview = null;
    },
    getMultiTabSnapshot: () => multiTab.getSnapshot(),
    subscribeMultiTab: (listener) => multiTab.subscribe(listener),
    requestMultiTabTakeover: () => multiTab.requestTakeover(),
    dispose: async () => {
      disposed = true;
      await stopInternal("dispose");
      multiTab.dispose();
      pcmPlayer?.dispose();
      pcmPlayer = null;
      listeners.clear();
    },
  };

  return adapter;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitUntil(predicate: () => boolean, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve();
      return;
    }
    const timer = setInterval(() => {
      if (predicate()) {
        cleanup();
        resolve();
      }
    }, 50);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Silence unused type imports that remain useful for documentation.
export type {
  VoiceConfirmationDecision,
  VoiceConfirmationId,
  VoiceClientActionId,
  VoiceClientActionOutcome,
  VoiceThreadReviewToken,
};

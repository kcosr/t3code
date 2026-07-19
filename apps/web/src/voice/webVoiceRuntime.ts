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
import * as Effect from "effect/Effect";
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
  let reviewTranscript: string | null = null;
  let reviewId = 0;
  let pcmPlayer: PcmPlayer | null = null;

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
    if (tab.role === "leader") {
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
    if (options?.signal?.aborted) throw new Error("Voice start was cancelled");
    await ensureLeader(target.environmentId);
    if (options?.signal?.aborted) throw new Error("Voice start was cancelled");

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
    if (options?.signal?.aborted) throw new Error("Voice start was cancelled");

    const capabilities = await Effect.runPromise(client.capabilities(), {
      signal: options?.signal,
    });
    const realtimeCap = capabilities.capabilities.find(
      (item) => item.capability === "agent.realtime",
    );
    if (realtimeCap?.state !== "ready") {
      throw new Error("Realtime voice is not ready on this environment");
    }

    const terminalActions: WebVoiceTerminalActions = advertiseSwitchToThread
      ? ["stop-realtime", "switch-to-thread"]
      : ["stop-realtime"];

    const localStream = await requestMicrophoneStream();
    if (options?.signal?.aborted) {
      for (const track of localStream.getTracks()) track.stop();
      throw new Error("Voice start was cancelled");
    }

    await mediaGate.admit("realtime", async () => ({
      release: async () => {
        // Release is driven by stopPeer / stopInternal.
      },
    }));

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

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    for (const track of localStream.getAudioTracks()) {
      peer.addTrack(track, localStream);
    }

    const remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    peer.ontrack = (event) => {
      if (event.streams[0]) {
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
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        };
      });
    }
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
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });

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
    const realtime = activeRealtime;
    activeRealtime = null;
    threadAbort?.abort();
    threadAbort = null;
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
    const ticket = await Effect.runPromise(
      client.createMediaTicket({ operation: "speech-stream", requestId }),
      { signal },
    );
    const chunks: Uint8Array[] = [];
    await Stream.runForEach(
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
    ).pipe(Effect.runPromise);
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
    const prepared = hooks.getPrepared(input.target.environmentId);
    if (prepared === null) {
      throw new Error("A prepared environment connection is required for Thread voice");
    }
    if (hooks.dispatchThreadTurn == null || hooks.waitForThreadTurn == null) {
      throw new Error("Thread voice orchestration hooks are not configured");
    }

    await ensureLeader(input.target.environmentId);
    const gen = bumpGeneration();
    threadAbort?.abort();
    const abort = new AbortController();
    threadAbort = abort;

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
        abort.abort();
        pcmPlayer?.cancel();
      },
    }));

    const client = await makeClient(prepared);
    const capabilities = await Effect.runPromise(client.capabilities(), { signal: abort.signal });
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
      let endpoint: "silence" | "no-speech" | "max-utterance" | "manual" = "manual";
      try {
        endpoint = await waitForEndpoint({
          capture,
          config: input.settings.endpointDetection,
          signal: abort.signal,
        });
      } catch (cause) {
        capture.stop();
        if (abort.signal.aborted) break;
        throw cause;
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
      capture.stop();

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
        sampleRate: Math.round(
          // Prefer 24 kHz when the capture rate is high enough; encoder uses native rate.
          capture.sampleRate,
        ),
      });

      const requestId = createRequestId() as VoiceRequestId;
      const ticket = await Effect.runPromise(
        client.createMediaTicket({ operation: "transcription-upload", requestId }),
        { signal: abort.signal },
      );

      let transcriptText = "";
      await Stream.runForEach(
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
      ).pipe(Effect.runPromise);

      transcriptText = transcriptText.trim();
      if (transcriptText.length === 0) {
        if (!input.settings.autoRearm) break;
        await delay(input.settings.rearmDelayMs, abort.signal);
        continue;
      }

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
        // Wait until submitThreadTranscript or stop.
        await waitUntil(
          () =>
            abort.signal.aborted || snapshot.mode !== "thread" || snapshot.phase !== "reviewing",
          abort.signal,
        );
        if (abort.signal.aborted || snapshot.mode !== "thread") break;
        if (snapshot.phase === "stopping") break;
        // After submit, snapshot moves to submitting/waiting inside submit handler.
        // Continue loop only after a full cycle completes back to rearming/idle path.
        if (snapshot.mode === "thread" && snapshot.phase === "rearming") {
          await delay(input.settings.rearmDelayMs, abort.signal);
          if (!input.settings.autoRearm) break;
          continue;
        }
        if (!input.settings.autoRearm) break;
        continue;
      }

      await submitTranscriptAndWait({
        input,
        client,
        transcript: transcriptText,
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

    if (outcome.status === "attention") {
      publishNext({
        mode: "thread",
        phase: "waiting",
        generation,
        target: input.target,
        settings: input.settings,
        transcript,
        reviewId: null,
        attention: outcome.kind,
      });
      // Stay waiting until user resolves or stops.
      await waitUntil(() => abort.signal.aborted, abort.signal).catch(() => undefined);
      return;
    }

    if (outcome.status === "failed" || outcome.status === "timeout") {
      throw new Error(
        outcome.status === "timeout" ? "Timed out waiting for the Thread turn" : outcome.message,
      );
    }

    if (input.settings.playResponses && outcome.assistantText && outcome.assistantText.length > 0) {
      const speechCap = (
        await Effect.runPromise(client.capabilities(), { signal: abort.signal })
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
          outcome.assistantText,
          abort.signal,
        );
        await pcmPlayer.play(pcm);
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
    await runThreadCycle(input);
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
          await failAndRelease(
            target.environmentId,
            "realtime",
            failureOf(
              "start-realtime-failed",
              cause instanceof Error ? cause.message : "Failed to start Realtime voice",
              true,
            ),
          );
        }
      }),
    startThread: (input) =>
      command(async () => {
        if (snapshot.mode === "realtime") {
          await switchRealtimeToThreadInternal(input);
          return;
        }
        if (snapshot.mode === "thread") return;
        try {
          await runThreadCycle(input);
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") {
            await stopInternal("aborted");
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
        }
      }),
    switchRealtimeToThread: (input) =>
      command(async () => {
        if (snapshot.mode !== "realtime") {
          throw new Error("Realtime voice is not active");
        }
        try {
          await switchRealtimeToThreadInternal(input);
        } catch (cause) {
          await failAndRelease(
            input.target.environmentId,
            "switching-to-thread",
            failureOf(
              "switch-to-thread-failed",
              cause instanceof Error ? cause.message : "Failed to switch to Thread voice",
              true,
            ),
          );
        }
      }),
    stop: () => command(async () => stopInternal("user-stop")),
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
      activeRealtime = { ...activeRealtime, target: nextTarget };
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
      // Endpoint loop treats abort of wait as stop; manual finish is modeled by
      // aborting the current endpoint wait via a dedicated signal path.
      // For v1, stop the cycle after current utterance by flipping settings.
      if (snapshot.mode === "thread" && snapshot.phase === "recording") {
        // Force silence endpoint by aborting and letting the cycle finalize
        // with whatever PCM has been captured — simplified: stop entirely.
        threadAbort?.abort();
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
      const input: VoiceThreadStartInput = {
        target: snapshot.target,
        settings: snapshot.settings,
      };
      const prepared = hooks.getPrepared(input.target.environmentId);
      if (prepared === null) throw new Error("Missing prepared connection");
      const client = await makeClient(prepared);
      const abort = threadAbort ?? new AbortController();
      try {
        await submitTranscriptAndWait({
          input,
          client,
          transcript: transcript.trim().length > 0 ? transcript.trim() : (reviewTranscript ?? ""),
          abort,
        });
        if (input.settings.autoRearm) {
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
        } else {
          await stopInternal("review-submitted");
        }
      } catch (cause) {
        await failAndRelease(
          input.target.environmentId,
          "thread",
          failureOf(
            "thread-submit-failed",
            cause instanceof Error ? cause.message : "Failed to submit Thread voice transcript",
            true,
          ),
        );
      }
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

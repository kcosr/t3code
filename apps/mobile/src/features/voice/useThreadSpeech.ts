import { VoicePlaybackId, VoiceRequestId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { usePreparedConnection } from "../../state/session";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import { releasePlaybackForRecording } from "./traditionalAudioHandoff";
import { startReactThreadPlayback } from "./threadSpeechAdapterPolicy";
import type { ThreadSpeechInput } from "./threadSpeechTypes";
import {
  hydrateThreadSpeechPreference,
  initialThreadSpeechPlannerState,
  interruptThreadSpeech,
  isThreadSpeechSuspended,
  noteThreadSpeechEarlyToggle,
  planThreadSpeechToggle,
  setThreadSpeechEnabled,
  syncExternalThreadSpeechPreference,
  updateThreadSpeech,
  type ThreadSpeechAction,
  type ThreadSpeechPlannerState,
} from "./threadSpeechPlanner";
import { useVoiceCapabilityAvailability } from "./useVoiceCapabilityAvailability";
import { voiceErrorMessage as errorMessage } from "./voiceError";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return globalThis.btoa(binary);
};

const MAX_UNCONSUMED_CHUNKS = 4;

export interface ThreadSpeechLifecycleEvent {
  readonly sequence: number;
  readonly playbackId: string;
  readonly messageId: string;
  readonly outcome: "started" | "drained" | "cancelled" | "failed";
}

export function useThreadSpeech(input: ThreadSpeechInput) {
  const prepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const native = getT3VoiceNativeModule();
  const capabilityAvailable = useVoiceCapabilityAvailability(prepared, "speech.streaming");
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const plannerRef = useRef<ThreadSpeechPlannerState>(initialThreadSpeechPlannerState());
  const latestRef = useRef(input.latestAssistant);
  latestRef.current = input.latestAssistant;
  const actionChainRef = useRef(Promise.resolve());
  const operationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const suspendedForDictationRef = useRef(false);
  const suspendedForRealtimeRef = useRef(false);
  const playbackStartRef = useRef<{
    readonly playbackId: string;
    readonly messageId: string;
    readonly promise: Promise<void>;
  } | null>(null);
  const playbackRef = useRef<{
    readonly playbackId: string;
    readonly messageId: string;
    nextChunkIndex: number;
    pendingFrameBytes: Uint8Array;
    finalizing: boolean;
  } | null>(null);
  const playbackMessageIdsRef = useRef(new Map<string, string>());
  const emittedTerminalPlaybackIdsRef = useRef(new Set<string>());
  const pendingPlaybackAcknowledgementRef = useRef<{
    readonly playbackId: string;
    readonly promise: Promise<void>;
  } | null>(null);
  const consumedChunkIndexRef = useRef(-1);
  const consumptionWaitersRef = useRef<
    Array<{ readonly target: number; readonly resolve: () => void }>
  >([]);
  const [enabled, setEnabled] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifecycleEvent, setLifecycleEvent] = useState<ThreadSpeechLifecycleEvent | null>(null);
  const lifecycleSequenceRef = useRef(0);
  const emitLifecycle = useCallback(
    (playbackId: string, messageId: string, outcome: ThreadSpeechLifecycleEvent["outcome"]) => {
      if (!mountedRef.current) return;
      setLifecycleEvent({
        sequence: ++lifecycleSequenceRef.current,
        playbackId,
        messageId,
        outcome,
      });
    },
    [],
  );
  const emitTerminalLifecycle = useCallback(
    (
      playbackId: string,
      messageId: string,
      outcome: Extract<ThreadSpeechLifecycleEvent["outcome"], "drained" | "cancelled" | "failed">,
    ) => {
      if (emittedTerminalPlaybackIdsRef.current.has(playbackId)) return;
      emittedTerminalPlaybackIdsRef.current.add(playbackId);
      emitLifecycle(playbackId, messageId, outcome);
    },
    [emitLifecycle],
  );
  const handlePlaybackTerminated = useCallback(
    (event: import("@t3tools/mobile-voice-native").T3VoicePlaybackTerminatedEvent) => {
      const existing = pendingPlaybackAcknowledgementRef.current;
      if (existing?.playbackId === event.playbackId) return existing.promise;
      const messageId = playbackMessageIdsRef.current.get(event.playbackId);
      const playback = playbackRef.current;
      if (playback?.playbackId === event.playbackId) playbackRef.current = null;
      if (mountedRef.current) setPlaying(false);
      if (event.outcome === "failed" && mountedRef.current) {
        plannerRef.current = setThreadSpeechEnabled(
          plannerRef.current,
          false,
          latestRef.current,
        ).state;
        setEnabled(false);
        setError("PCM playback failed.");
      }
      if (messageId !== undefined) {
        emitTerminalLifecycle(
          event.playbackId,
          messageId,
          event.outcome === "completed"
            ? "drained"
            : event.outcome === "cancelled"
              ? "cancelled"
              : "failed",
        );
      }
      playbackMessageIdsRef.current.delete(event.playbackId);
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();

      const acknowledgement = (async () => {
        if (native === null) return;
        let retryDelayMs = 100;
        while (mountedRef.current) {
          try {
            await native.acknowledgePlaybackTerminationAsync({
              playbackId: event.playbackId,
            });
            return;
          } catch {
            await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
            retryDelayMs = Math.min(2_000, retryDelayMs * 2);
          }
        }
        // The native terminal record remains durable and will be retried by the next mount.
        return;
      })().finally(() => {
        if (pendingPlaybackAcknowledgementRef.current?.playbackId === event.playbackId) {
          pendingPlaybackAcknowledgementRef.current = null;
        }
        emittedTerminalPlaybackIdsRef.current.delete(event.playbackId);
      });
      pendingPlaybackAcknowledgementRef.current = {
        playbackId: event.playbackId,
        promise: acknowledgement,
      };
      return acknowledgement;
    },
    [emitTerminalLifecycle, native],
  );

  const executeAction = useCallback(
    async (action: ThreadSpeechAction, generation: number) => {
      if (native === null || prepared === null) return;
      if (operationGenerationRef.current !== generation) throw new Error("Playback was cancelled");
      switch (action.type) {
        case "start":
          {
            const pendingTermination = await native.getPendingPlaybackTerminationAsync();
            if (pendingTermination !== null) await handlePlaybackTerminated(pendingTermination);
            if (pendingPlaybackAcknowledgementRef.current !== null) {
              await pendingPlaybackAcknowledgementRef.current.promise;
            }
            if (operationGenerationRef.current !== generation) {
              throw new Error("Playback was cancelled");
            }
            playbackMessageIdsRef.current.set(action.playbackId, action.messageId);
            const startPromise = (async () => {
              await startReactThreadPlayback(native, {
                playbackId: action.playbackId,
                sampleRate: 24_000,
                channelCount: 1,
              });
              if (operationGenerationRef.current !== generation) {
                await native
                  .cancelPlaybackAsync({ playbackId: action.playbackId })
                  .catch(() => undefined);
                throw new Error("Playback was cancelled");
              }
              playbackRef.current = {
                playbackId: action.playbackId,
                messageId: action.messageId,
                nextChunkIndex: 0,
                pendingFrameBytes: new Uint8Array(),
                finalizing: false,
              };
              consumedChunkIndexRef.current = -1;
              setPlaying(true);
              emitLifecycle(action.playbackId, action.messageId, "started");
            })();
            playbackStartRef.current = {
              playbackId: action.playbackId,
              messageId: action.messageId,
              promise: startPromise,
            };
            try {
              await startPromise;
            } finally {
              if (playbackStartRef.current?.promise === startPromise) {
                playbackStartRef.current = null;
              }
            }
          }
          return;
        case "segment": {
          const requestId = VoiceRequestId.make(uuidv4());
          const client = await makeMobileVoiceClient(prepared);
          const ticket = await Effect.runPromise(
            client.createMediaTicket({ operation: "speech-stream", requestId }),
          );
          await Effect.runPromise(
            client
              .synthesize({
                request: {
                  requestId,
                  playbackId: VoicePlaybackId.make(action.playbackId),
                  segmentIndex: action.segment.index,
                  finalSegment: action.segment.finalSegment,
                  text: action.segment.text,
                  preset: "default",
                },
                ticket,
              })
              .pipe(
                Stream.runForEach((bytes) =>
                  Effect.promise(async () => {
                    if (operationGenerationRef.current !== generation) {
                      throw new Error("Playback was cancelled");
                    }
                    const playback = playbackRef.current;
                    if (playback === null || playback.playbackId !== action.playbackId) return;
                    const pcm = new Uint8Array(playback.pendingFrameBytes.length + bytes.length);
                    pcm.set(playback.pendingFrameBytes);
                    pcm.set(bytes, playback.pendingFrameBytes.length);
                    const completeLength = pcm.length - (pcm.length % 2);
                    playback.pendingFrameBytes = pcm.slice(completeLength);
                    if (completeLength === 0) return;
                    const chunkIndex = playback.nextChunkIndex;
                    playback.nextChunkIndex += 1;
                    await native.enqueuePlaybackChunkAsync({
                      playbackId: action.playbackId,
                      chunkIndex,
                      pcmBase64: bytesToBase64(pcm.subarray(0, completeLength)),
                    });
                    const backpressureTarget = chunkIndex - MAX_UNCONSUMED_CHUNKS + 1;
                    if (backpressureTarget > consumedChunkIndexRef.current) {
                      await new Promise<void>((resolve) => {
                        consumptionWaitersRef.current.push({
                          target: backpressureTarget,
                          resolve,
                        });
                      });
                    }
                  }),
                ),
              ),
          );
          return;
        }
        case "finish": {
          const playback = playbackRef.current;
          if (playback === null || playback.playbackId !== action.playbackId) return;
          if (playback.pendingFrameBytes.length !== 0) {
            throw new Error("Speech provider returned a partial PCM frame");
          }
          if (playback.nextChunkIndex === 0) {
            await native.cancelPlaybackAsync({ playbackId: action.playbackId });
            playbackRef.current = null;
            if (operationGenerationRef.current === generation && mountedRef.current) {
              setPlaying(false);
            }
          } else {
            playback.finalizing = true;
            await native.finishPlaybackAsync({
              playbackId: action.playbackId,
              finalChunkIndex: playback.nextChunkIndex - 1,
            });
          }
          return;
        }
        case "cancel": {
          await native.cancelPlaybackAsync({ playbackId: action.playbackId });
          if (playbackRef.current?.playbackId === action.playbackId) {
            playbackRef.current = null;
          }
          for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
          if (operationGenerationRef.current === generation && mountedRef.current)
            setPlaying(false);
        }
      }
    },
    [emitLifecycle, handlePlaybackTerminated, native, prepared],
  );

  const enqueueActions = useCallback(
    (actions: ReadonlyArray<ThreadSpeechAction>) => {
      if (actions.length === 0) return;
      const generation = operationGenerationRef.current;
      const startedAction = actions.find((action) => action.type === "start");
      actionChainRef.current = actionChainRef.current
        .then(async () => {
          for (const action of actions) await executeAction(action, generation);
        })
        .catch(async (cause) => {
          if (operationGenerationRef.current !== generation) return;
          ++operationGenerationRef.current;
          setError(errorMessage(cause));
          const playback = playbackRef.current;
          const pendingStart = playbackStartRef.current;
          playbackRef.current = null;
          plannerRef.current = setThreadSpeechEnabled(
            plannerRef.current,
            false,
            latestRef.current,
          ).state;
          setEnabled(false);
          setPlaying(false);
          const failed = playback ?? pendingStart ?? startedAction ?? null;
          if (failed !== null) {
            emitTerminalLifecycle(failed.playbackId, failed.messageId, "failed");
            playbackMessageIdsRef.current.delete(failed.playbackId);
          }
          for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
          const cancellation =
            native !== null && playback !== null
              ? native
                  .cancelPlaybackAsync({ playbackId: playback.playbackId })
                  .catch(() => undefined)
              : Promise.resolve();
          actionChainRef.current = cancellation;
          await cancellation;
        });
    },
    [emitTerminalLifecycle, executeAction, native],
  );

  useEffect(() => {
    // Wait until preference hydration has baselined (or skipped restore) so an early
    // pre-history enable cannot start playback of the already-visible message.
    if (!plannerRef.current.hydration.preferenceHydrated) return;
    const result = updateThreadSpeech(
      plannerRef.current,
      input.latestAssistant,
      uuidv4,
      isThreadSpeechSuspended(suspendedForDictationRef.current, suspendedForRealtimeRef.current),
    );
    plannerRef.current = result.state;
    enqueueActions(result.actions);
  }, [enqueueActions, input.latestAssistant, input.historyReady, preferencesResult]);

  useEffect(() => {
    ++operationGenerationRef.current;
    const playback = playbackRef.current;
    playbackRef.current = null;
    for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
    actionChainRef.current =
      native !== null && playback !== null
        ? native.cancelPlaybackAsync({ playbackId: playback.playbackId }).catch(() => undefined)
        : Promise.resolve();
    plannerRef.current = {
      enabled: plannerRef.current.enabled,
      baselineMessageId: input.latestAssistant?.id ?? null,
      active: null,
      hydration: plannerRef.current.hydration,
    };
    setPlaying(false);
  }, [input.scopeKey, native, prepared]);

  useEffect(() => {
    if (native === null) return;
    const terminatedSubscription = native.addListener("playbackTerminated", (event) => {
      void handlePlaybackTerminated(event).catch(() => undefined);
    });
    void native
      .getPendingPlaybackTerminationAsync()
      .then((event) => {
        if (event !== null) return handlePlaybackTerminated(event);
      })
      .catch(() => undefined);
    const consumedSubscription = native.addListener("playbackChunkConsumed", (event) => {
      if (playbackRef.current?.playbackId !== event.playbackId) return;
      consumedChunkIndexRef.current = Math.max(consumedChunkIndexRef.current, event.chunkIndex);
      const pending = consumptionWaitersRef.current;
      consumptionWaitersRef.current = pending.filter((waiter) => {
        if (waiter.target > consumedChunkIndexRef.current) return true;
        waiter.resolve();
        return false;
      });
    });
    const errorSubscription = native.addListener("runtimeError", (event) => {
      const playback = playbackRef.current;
      if (playback === null || event.operation !== `playback:${playback.playbackId}`) return;
      ++operationGenerationRef.current;
      actionChainRef.current = Promise.resolve();
      setError(`${event.operation}: ${event.message}`);
      playbackRef.current = null;
      plannerRef.current = setThreadSpeechEnabled(
        plannerRef.current,
        false,
        latestRef.current,
      ).state;
      setEnabled(false);
      setPlaying(false);
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
    });
    return () => {
      terminatedSubscription.remove();
      consumedSubscription.remove();
      errorSubscription.remove();
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
    };
  }, [handlePlaybackTerminated, native]);

  const disableImmediately = useCallback(
    (persist: boolean) => {
      ++operationGenerationRef.current;
      const pendingStart = playbackStartRef.current;
      const playback = playbackRef.current;
      playbackRef.current = null;
      plannerRef.current = setThreadSpeechEnabled(
        plannerRef.current,
        false,
        latestRef.current,
      ).state;
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
      setEnabled(false);
      setPlaying(false);
      setError(null);
      if (persist) savePreferences({ threadSpeechEnabled: false });

      const cancellation = (async () => {
        if (native === null) return;
        const playbackId =
          playback?.playbackId ??
          pendingStart?.playbackId ??
          (await native.getStateAsync()).activePlaybackId ??
          undefined;
        if (playbackId === undefined) return;
        await releasePlaybackForRecording({
          native,
          playbackId,
          ...(pendingStart === null ? {} : { pendingStart: pendingStart.promise }),
        });
      })();
      actionChainRef.current = cancellation.catch((cause) => {
        if (mountedRef.current) setError(errorMessage(cause));
      });
      return cancellation;
    },
    [native, savePreferences],
  );

  useEffect(() => {
    const result = hydrateThreadSpeechPreference(plannerRef.current, {
      historyReady: input.historyReady,
      preferencesReady: AsyncResult.isSuccess(preferencesResult),
      persistedEnabled:
        AsyncResult.isSuccess(preferencesResult) &&
        preferencesResult.value.threadSpeechEnabled === true,
      latest: latestRef.current,
    });
    if (!result.didHydrate) return;
    plannerRef.current = result.state;
    // Skip-restore: user already toggled after history was ready; UI already matches.
    const skipRestore =
      result.state.hydration.toggledBeforePreferenceHydration &&
      !result.state.hydration.earlyToggleNeedsBaseline;
    if (!skipRestore) {
      setEnabled(result.state.enabled);
      enqueueActions(result.actions);
    }
    // Catch up streaming segments/finish that were gated while prefs loaded, and
    // avoid replaying a baselined visible message after early pre-history enable.
    const catchUp = updateThreadSpeech(
      plannerRef.current,
      latestRef.current,
      uuidv4,
      isThreadSpeechSuspended(suspendedForDictationRef.current, suspendedForRealtimeRef.current),
    );
    plannerRef.current = catchUp.state;
    enqueueActions(catchUp.actions);
  }, [enqueueActions, input.historyReady, preferencesResult]);

  useEffect(() => {
    const result = syncExternalThreadSpeechPreference(plannerRef.current, {
      preferencesReady: AsyncResult.isSuccess(preferencesResult),
      persistedEnabled:
        AsyncResult.isSuccess(preferencesResult) &&
        preferencesResult.value.threadSpeechEnabled === true,
      latest: latestRef.current,
    });
    plannerRef.current = result.state;
    if (result.kind === "disable_no_persist") {
      void disableImmediately(false).catch(() => undefined);
      return;
    }
    if (result.kind === "enable") {
      setEnabled(true);
      setError(null);
      enqueueActions(result.actions);
    }
  }, [disableImmediately, enqueueActions, preferencesResult]);

  const toggle = useCallback(() => {
    if (!capabilityAvailable) return;
    const noted = noteThreadSpeechEarlyToggle(plannerRef.current, input.historyReady);
    const result = planThreadSpeechToggle(
      noted,
      latestRef.current,
      uuidv4,
      isThreadSpeechSuspended(suspendedForDictationRef.current, suspendedForRealtimeRef.current),
    );
    if (!result.enabled) {
      plannerRef.current = result.state;
      void disableImmediately(true).catch(() => undefined);
      return;
    }
    plannerRef.current = result.state;
    setEnabled(result.enabled);
    savePreferences({ threadSpeechEnabled: result.enabled });
    setError(null);
    enqueueActions(result.actions);
  }, [
    capabilityAvailable,
    disableImmediately,
    enqueueActions,
    input.historyReady,
    savePreferences,
  ]);

  const resumeAfterDictation = useCallback(() => {
    if (!suspendedForDictationRef.current) return;
    suspendedForDictationRef.current = false;
    if (suspendedForRealtimeRef.current) return;
    const result = updateThreadSpeech(plannerRef.current, latestRef.current, uuidv4);
    plannerRef.current = result.state;
    enqueueActions(result.actions);
  }, [enqueueActions]);

  const resumeAfterRealtime = useCallback(() => {
    if (!suspendedForRealtimeRef.current) return;
    suspendedForRealtimeRef.current = false;
    plannerRef.current = interruptThreadSpeech(plannerRef.current, latestRef.current);
  }, []);

  const interruptPlayback = useCallback(
    async (reason: "dictation" | "realtime") => {
      if (reason === "dictation") suspendedForDictationRef.current = true;
      if (reason === "realtime") suspendedForRealtimeRef.current = true;
      ++operationGenerationRef.current;
      const pendingStart = playbackStartRef.current;
      const playback = playbackRef.current;
      playbackRef.current = null;
      plannerRef.current = interruptThreadSpeech(plannerRef.current, latestRef.current);
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
      setPlaying(false);
      setError(null);
      const cancellation = (async () => {
        if (native === null) return;
        const playbackId =
          playback?.playbackId ??
          pendingStart?.playbackId ??
          (await native.getStateAsync()).activePlaybackId ??
          undefined;
        if (playbackId !== undefined) {
          await releasePlaybackForRecording({
            native,
            playbackId,
            ...(pendingStart === null ? {} : { pendingStart: pendingStart.promise }),
          });
        }
      })();
      actionChainRef.current = cancellation;
      try {
        await cancellation;
        return true;
      } catch (cause) {
        if (mountedRef.current) {
          setError(errorMessage(cause));
          if (reason === "dictation") resumeAfterDictation();
          if (reason === "realtime") resumeAfterRealtime();
        }
        return false;
      }
    },
    [native, resumeAfterDictation, resumeAfterRealtime],
  );

  const interrupt = useCallback(() => interruptPlayback("dictation"), [interruptPlayback]);
  const interruptForRealtime = useCallback(
    () => interruptPlayback("realtime"),
    [interruptPlayback],
  );

  const enable = useCallback(() => {
    if (plannerRef.current.enabled) return;
    const result = setThreadSpeechEnabled(plannerRef.current, true, latestRef.current);
    plannerRef.current = result.state;
    setEnabled(true);
    savePreferences({ threadSpeechEnabled: true });
    setError(null);
    enqueueActions(result.actions);
  }, [enqueueActions, savePreferences]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      ++operationGenerationRef.current;
      const playback = playbackRef.current;
      playbackRef.current = null;
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
      actionChainRef.current =
        native !== null && playback !== null
          ? native.cancelPlaybackAsync({ playbackId: playback.playbackId }).catch(() => undefined)
          : Promise.resolve();
    },
    [native],
  );

  return {
    available: native !== null && prepared !== null && capabilityAvailable,
    enabled,
    playing,
    error,
    onToggle: toggle,
    interrupt,
    interruptForRealtime,
    resumeAfterDictation,
    resumeAfterRealtime,
    enable,
    lifecycleEvent,
    latestAssistant: input.latestAssistant,
  };
}

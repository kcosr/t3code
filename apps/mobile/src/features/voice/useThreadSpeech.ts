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
import {
  initialThreadSpeechPlannerState,
  interruptThreadSpeech,
  planThreadSpeechToggle,
  restoreThreadSpeechPreference,
  setThreadSpeechEnabled,
  updateThreadSpeech,
  type AssistantSpeechSnapshot,
  type ThreadSpeechAction,
  type ThreadSpeechPlannerState,
} from "./threadSpeechPlanner";
import { useVoiceCapabilityAvailability } from "./useVoiceCapabilityAvailability";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return globalThis.btoa(binary);
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const MAX_UNCONSUMED_CHUNKS = 4;

export interface ThreadSpeechLifecycleEvent {
  readonly sequence: number;
  readonly playbackId: string;
  readonly messageId: string;
  readonly outcome: "started" | "drained" | "cancelled" | "failed";
}

export function useThreadSpeech(input: {
  readonly environmentId: Parameters<typeof usePreparedConnection>[0];
  readonly scopeKey: string;
  readonly historyReady: boolean;
  readonly latestAssistant: AssistantSpeechSnapshot | null;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const native = getT3VoiceNativeModule();
  const capabilityAvailable = useVoiceCapabilityAvailability(prepared, "speech.streaming");
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const plannerRef = useRef<ThreadSpeechPlannerState>(initialThreadSpeechPlannerState());
  const preferenceHydratedRef = useRef(false);
  const toggledBeforePreferenceHydrationRef = useRef(false);
  const earlyToggleNeedsBaselineRef = useRef(false);
  const latestRef = useRef(input.latestAssistant);
  latestRef.current = input.latestAssistant;
  const actionChainRef = useRef(Promise.resolve());
  const operationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const suspendedForDictationRef = useRef(false);
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

  const executeAction = useCallback(
    async (action: ThreadSpeechAction, generation: number) => {
      if (native === null || prepared === null) return;
      if (operationGenerationRef.current !== generation) throw new Error("Playback was cancelled");
      switch (action.type) {
        case "start":
          {
            const startPromise = (async () => {
              await native.startPlaybackAsync({
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
            setPlaying(false);
            emitLifecycle(action.playbackId, playback.messageId, "cancelled");
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
          const messageId = playbackRef.current?.messageId ?? latestRef.current?.id ?? "";
          await native.cancelPlaybackAsync({ playbackId: action.playbackId });
          if (playbackRef.current?.playbackId === action.playbackId) {
            playbackRef.current = null;
          }
          for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
          setPlaying(false);
          emitLifecycle(action.playbackId, messageId, "cancelled");
        }
      }
    },
    [emitLifecycle, native, prepared],
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
            emitLifecycle(failed.playbackId, failed.messageId, "failed");
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
    [emitLifecycle, executeAction, native],
  );

  useEffect(() => {
    const result = updateThreadSpeech(
      plannerRef.current,
      input.latestAssistant,
      uuidv4,
      suspendedForDictationRef.current,
    );
    plannerRef.current = result.state;
    enqueueActions(result.actions);
  }, [enqueueActions, input.latestAssistant]);

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
    };
    setPlaying(false);
  }, [input.scopeKey, native, prepared]);

  useEffect(() => {
    if (native === null) return;
    const terminatedSubscription = native.addListener("playbackTerminated", (event) => {
      const playback = playbackRef.current;
      if (playback === null || playback.playbackId !== event.playbackId) return;
      playbackRef.current = null;
      setPlaying(false);
      if (event.outcome === "failed") {
        plannerRef.current = setThreadSpeechEnabled(
          plannerRef.current,
          false,
          latestRef.current,
        ).state;
        setEnabled(false);
        setError("PCM playback failed.");
      }
      emitLifecycle(
        playback.playbackId,
        playback.messageId,
        event.outcome === "completed" ? "drained" : "failed",
      );
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
    });
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
  }, [emitLifecycle, native]);

  useEffect(() => {
    if (
      preferenceHydratedRef.current ||
      !input.historyReady ||
      !AsyncResult.isSuccess(preferencesResult)
    ) {
      return;
    }
    preferenceHydratedRef.current = true;
    if (toggledBeforePreferenceHydrationRef.current && !earlyToggleNeedsBaselineRef.current) {
      return;
    }

    const restored = restoreThreadSpeechPreference(
      plannerRef.current,
      toggledBeforePreferenceHydrationRef.current
        ? plannerRef.current.enabled
        : preferencesResult.value.threadSpeechEnabled === true,
      latestRef.current,
    );
    plannerRef.current = restored.state;
    setEnabled(restored.state.enabled);
    enqueueActions(restored.actions);
  }, [enqueueActions, input.historyReady, preferencesResult]);

  const toggle = useCallback(() => {
    if (!capabilityAvailable) return;
    if (!preferenceHydratedRef.current) {
      toggledBeforePreferenceHydrationRef.current = true;
      earlyToggleNeedsBaselineRef.current ||= !input.historyReady;
    }
    const result = planThreadSpeechToggle(
      plannerRef.current,
      latestRef.current,
      uuidv4,
      suspendedForDictationRef.current,
    );
    if (!result.enabled) {
      ++operationGenerationRef.current;
      const playback = playbackRef.current;
      playbackRef.current = null;
      for (const waiter of consumptionWaitersRef.current.splice(0)) waiter.resolve();
      actionChainRef.current =
        native !== null && playback !== null
          ? native.cancelPlaybackAsync({ playbackId: playback.playbackId }).catch(() => undefined)
          : Promise.resolve();
      setPlaying(false);
    }
    plannerRef.current = result.state;
    setEnabled(result.enabled);
    savePreferences({ threadSpeechEnabled: result.enabled });
    setError(null);
    enqueueActions(result.actions);
  }, [capabilityAvailable, enqueueActions, input.historyReady, native, savePreferences]);

  const resumeAfterDictation = useCallback(() => {
    if (!suspendedForDictationRef.current) return;
    suspendedForDictationRef.current = false;
    const result = updateThreadSpeech(plannerRef.current, latestRef.current, uuidv4);
    plannerRef.current = result.state;
    enqueueActions(result.actions);
  }, [enqueueActions]);

  const interrupt = useCallback(async () => {
    suspendedForDictationRef.current = true;
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
      if (playback !== null || pendingStart !== null) {
        emitLifecycle(
          playback?.playbackId ?? pendingStart!.playbackId,
          playback?.messageId ?? pendingStart?.messageId ?? "",
          "cancelled",
        );
      }
      return true;
    } catch (cause) {
      if (mountedRef.current) {
        setError(errorMessage(cause));
        resumeAfterDictation();
      }
      return false;
    }
  }, [emitLifecycle, native, resumeAfterDictation]);

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
    resumeAfterDictation,
    enable,
    lifecycleEvent,
    latestAssistant: input.latestAssistant,
  };
}

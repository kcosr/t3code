import { useEffect, useRef, useCallback } from "react";
import { Alert } from "react-native";
import type { VoiceThreadModePauseReason } from "@t3tools/shared/voiceThreadMode";
import { useMasterVoice } from "../voice/MasterVoiceProvider";
import { useAutoListenController } from "../voice/useAutoListenController";
import { shouldShowAutoListenPauseAlert } from "../voice/autoListenPausePresentation";
import {
  activateAutoListenWithAudioHandoff,
  dictationResumeTransition,
  interruptTraditionalAudioForRealtime,
  runExclusiveTraditionalAudioTransition,
  startManualDictationWithAudioHandoff,
} from "../voice/traditionalAudioHandoff";
import {
  NativeThreadCommandActivationCoordinator,
  shouldStartNativeThreadCommand,
} from "../voice/nativeVoiceReadiness";
import type { ThreadVoiceComposerControllerInput } from "./threadVoiceComposerControllerTypes";

function pauseMessage(reason: VoiceThreadModePauseReason): string {
  switch (reason) {
    case "permission":
      return "Microphone permission is unavailable.";
    case "audio-route":
      return "The selected audio route is unavailable.";
    case "no-speech":
    case "empty-transcript":
      return "No speech was recognized.";
    case "recording-failed":
      return "Recording could not continue.";
    case "transcription-failed":
      return "Transcription failed.";
    case "transcription-timeout":
      return "Transcription timed out.";
    case "submission-failed":
      return "The message could not be sent.";
    case "submission-timeout":
      return "Sending the message timed out.";
    case "response-timeout":
      return "The agent response timed out.";
    case "playback-cancelled":
      return "Spoken response playback was stopped.";
    case "playback-failed":
      return "Spoken response playback failed.";
    case "interaction-required":
      return "The agent needs your attention.";
    case "target-changed":
      return "The active thread changed.";
    case "realtime-active":
      return "Realtime voice is active.";
    case "user":
    case "disabled":
    case "lifecycle":
      return "Auto Listen stopped.";
  }
}

export function useThreadVoiceComposerController(input: ThreadVoiceComposerControllerInput) {
  const { props, dictation, persistedTargetGeneration, voicePreferences, spokenResponsesEnabled } =
    input;
  const realtimeVoice = useMasterVoice();
  if (realtimeVoice.executionModel !== "ui-attached") {
    throw new Error("The UI-attached Thread voice controller requires a UI-attached runtime.");
  }
  const realtimeInUse = realtimeVoice.active;
  const dictationWasActiveRef = useRef(false);
  const traditionalAudioTransitionLockRef = useRef({ active: false });
  const canStartAutoListen =
    dictation.available &&
    props.draftMessage.trim().length === 0 &&
    props.draftAttachments.length === 0 &&
    !props.interactionRequired;
  const autoListen = useAutoListenController({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    preferences: voicePreferences,
    persistedTargetGeneration,
    activeThreadBusy: props.activeThreadBusy,
    threadMessages: props.threadMessages,
    interactionRequired: props.interactionRequired,
    canStartFromComposer: canStartAutoListen,
    dictation,
    speech: {
      ...props.speechPlayback,
      playbackRequired: spokenResponsesEnabled,
    },
    realtimePhase: realtimeVoice.phase,
    stopRealtime: realtimeVoice.stop,
    onSendVoiceMessage: props.onSendVoiceMessage,
  });
  const {
    state: autoListenState,
    active: autoListenActive,
    activate: activateAutoListen,
    deactivateForManualDictation: deactivateAutoListenForManualDictation,
    stopToDraft: stopAutoListenToDraft,
    pause: pauseAutoListen,
  } = autoListen;
  const autoListenAlertCycleRef = useRef(0);
  const nativeThreadActivationRef = useRef(new NativeThreadCommandActivationCoordinator());

  useEffect(() => {
    const command = realtimeVoice.nativeThreadCommand;
    if (
      command === null ||
      !shouldStartNativeThreadCommand({
        captureReady: dictation.available,
        command,
        environmentId: props.environmentId,
        threadId: props.selectedThread.id,
      })
    ) {
      return;
    }
    nativeThreadActivationRef.current.start(
      command.commandId,
      () => activateAutoListen(true),
      realtimeVoice.completeNativeThreadCommand,
    );
  }, [
    activateAutoListen,
    dictation.available,
    props.environmentId,
    props.selectedThread.id,
    realtimeVoice.completeNativeThreadCommand,
    realtimeVoice.nativeThreadCommand,
  ]);

  useEffect(() => {
    if (
      autoListenState.phase !== "paused" ||
      autoListenState.cycle <= autoListenAlertCycleRef.current
    ) {
      return;
    }
    autoListenAlertCycleRef.current = autoListenState.cycle;
    const reason = autoListenState.pauseReason;
    if (shouldShowAutoListenPauseAlert(reason)) {
      Alert.alert("Auto Listen paused", pauseMessage(reason));
    }
  }, [autoListenState]);

  useEffect(() => {
    const transition = dictationResumeTransition(dictationWasActiveRef.current, dictation.phase);
    dictationWasActiveRef.current = transition.wasActive;
    if (transition.resume) props.speechPlayback.resumeAfterDictation();
  }, [dictation.phase, props.speechPlayback.resumeAfterDictation]);

  useEffect(() => {
    if (realtimeVoice.phase === "idle" || realtimeVoice.phase === "error") {
      props.speechPlayback.resumeAfterRealtime();
    }
  }, [props.speechPlayback.resumeAfterRealtime, realtimeVoice.phase]);

  useEffect(
    () =>
      realtimeVoice.registerTraditionalAudioInterruption(async () => {
        const restoreAutoListen = autoListenActive;
        pauseAutoListen("realtime-active");
        return interruptTraditionalAudioForRealtime({
          cancelDictation: dictation.cancelForRealtime,
          interruptPlayback: props.speechPlayback.interruptForRealtime,
          rollback: () => {
            props.speechPlayback.resumeAfterRealtime();
            if (restoreAutoListen) void activateAutoListen(true);
          },
        });
      }),
    [
      activateAutoListen,
      autoListenActive,
      dictation.cancelForRealtime,
      pauseAutoListen,
      props.speechPlayback.interruptForRealtime,
      props.speechPlayback.resumeAfterRealtime,
      realtimeVoice.registerTraditionalAudioInterruption,
    ],
  );

  const toggleDictation = useCallback(async () => {
    await runExclusiveTraditionalAudioTransition(
      traditionalAudioTransitionLockRef.current,
      async () => {
        if (dictation.phase === "recording" && !autoListenActive) {
          await dictation.stop();
          return;
        }
        await startManualDictationWithAudioHandoff({
          autoListenActive,
          deactivateAutoListen: autoListen.deactivateForManualDictation,
          stopRealtime: realtimeVoice.stop,
          interruptPlayback: props.speechPlayback.interrupt,
          startDictation: async () => (await dictation.start()) !== null,
          resumePlayback: props.speechPlayback.resumeAfterDictation,
        });
      },
    );
  }, [autoListen, autoListenActive, dictation, props.speechPlayback, realtimeVoice.stop]);

  const toggleAutoListenOperation = useCallback(async () => {
    await runExclusiveTraditionalAudioTransition(
      traditionalAudioTransitionLockRef.current,
      async () => {
        if (autoListenActive) {
          if (await stopAutoListenToDraft()) return;
          await deactivateAutoListenForManualDictation();
          return;
        }
        await activateAutoListenWithAudioHandoff({
          releaseManualDictation: dictation.cancelForRealtime,
          activateAutoListen: () => activateAutoListen(true),
        });
      },
    );
  }, [
    activateAutoListen,
    autoListenActive,
    deactivateAutoListenForManualDictation,
    dictation.cancelForRealtime,
    stopAutoListenToDraft,
  ]);

  return {
    realtimeInUse,
    autoListenState,
    autoListenActive,
    canStartAutoListen,
    toggleDictation,
    toggleAutoListenOperation,
    submitAutoListenReview: autoListen.submitReview,
  } as const;
}

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomSet } from "@effect/atom-react";
import { AppState } from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  initialVoiceThreadModeState,
  transitionVoiceThreadMode,
  type VoiceThreadModeCommand,
  type VoiceThreadModeEvent,
  type VoiceThreadModePauseReason,
  type VoiceThreadModeState,
  type VoiceThreadModeTarget,
} from "@t3tools/shared/voiceThreadMode";
import type { MessageId } from "@t3tools/contracts";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import type { ResolvedVoicePreferences } from "./voicePreferences";
import type {
  ComposerRecordingTerminationEvent,
  ComposerTranscriptionEvent,
} from "./useComposerDictation";
import type { ThreadSpeechLifecycleEvent } from "./useThreadSpeech";
import {
  findCompletedAutoListenResponse,
  type AutoListenThreadMessage,
} from "./autoListenResponse";

const sameToken = (
  left: import("@t3tools/shared/voiceThreadMode").VoiceThreadModeToken | null,
  right: import("@t3tools/shared/voiceThreadMode").VoiceThreadModeToken,
) =>
  left !== null &&
  left.targetGeneration === right.targetGeneration &&
  left.cycle === right.cycle &&
  left.operation === right.operation;

interface AutoListenDictationAdapter {
  readonly phase: "idle" | "recording" | "transcribing";
  readonly error: string | null;
  readonly transcriptionEvent: ComposerTranscriptionEvent | null;
  readonly terminationEvent: ComposerRecordingTerminationEvent | null;
  readonly start: () => Promise<string | null>;
  readonly cancel: () => Promise<void>;
}

interface AutoListenSpeechAdapter {
  readonly enabled: boolean;
  readonly error: string | null;
  readonly lifecycleEvent: ThreadSpeechLifecycleEvent | null;
  readonly latestAssistant: {
    readonly id: string;
    readonly text: string;
    readonly streaming: boolean;
  } | null;
  readonly interrupt: () => Promise<boolean>;
  readonly resumeAfterDictation: () => void;
}

export function useAutoListenController(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly preferences: ResolvedVoicePreferences;
  readonly persistedTargetGeneration: number;
  readonly activeThreadBusy: boolean;
  readonly threadMessages: ReadonlyArray<AutoListenThreadMessage>;
  readonly interactionRequired: boolean;
  readonly canStartFromComposer: boolean;
  readonly dictation: AutoListenDictationAdapter;
  readonly speech: AutoListenSpeechAdapter;
  readonly realtimePhase: "idle" | "starting" | "active" | "stopping" | "error";
  readonly stopRealtime: () => Promise<void>;
  readonly onSendVoiceMessage: (text: string) => Promise<MessageId | null>;
}) {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [state, setState] = useState<VoiceThreadModeState>(initialVoiceThreadModeState);
  const stateRef = useRef(state);
  const inputRef = useRef(input);
  inputRef.current = input;
  const generationRef = useRef(Math.max(0, input.persistedTargetGeneration));
  const guardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submissionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const reviewSubmissionWaiterRef = useRef<{
    readonly token: import("@t3tools/shared/voiceThreadMode").VoiceThreadModeToken;
    readonly resolve: (sent: boolean) => void;
  } | null>(null);
  const lastTranscriptionSequenceRef = useRef(0);
  const lastTerminationSequenceRef = useRef(0);
  const lastPlaybackSequenceRef = useRef(0);
  const targetKeyRef = useRef(`${input.environmentId}:${input.threadId}`);
  generationRef.current = Math.max(generationRef.current, input.persistedTargetGeneration);

  const clearTimer = (kind: "guard" | "response" | "transcription" | "submission") => {
    const reference =
      kind === "guard"
        ? guardTimerRef
        : kind === "response"
          ? responseTimerRef
          : kind === "transcription"
            ? transcriptionTimerRef
            : submissionTimerRef;
    if (reference.current !== null) clearTimeout(reference.current);
    reference.current = null;
  };

  const executeCommandRef = useRef<(command: VoiceThreadModeCommand) => Promise<void>>(async () => {
    throw new Error("Auto Listen command executor is not ready");
  });

  const dispatch = useCallback((event: VoiceThreadModeEvent) => {
    const current = inputRef.current;
    const transition = transitionVoiceThreadMode(stateRef.current, event, {
      rearmGuardMs: current.preferences.postPlaybackGuardMs,
      transcriptionTimeoutMs: current.preferences.transcriptionTimeoutMs,
      submissionTimeoutMs: current.preferences.submissionTimeoutMs,
    });
    stateRef.current = transition.state;
    if (mountedRef.current) setState(transition.state);
    if (transition.state.phase === "paused" && reviewSubmissionWaiterRef.current !== null) {
      reviewSubmissionWaiterRef.current.resolve(false);
      reviewSubmissionWaiterRef.current = null;
    }
    for (const command of transition.commands) void executeCommandRef.current(command);
    return transition.state;
  }, []);

  executeCommandRef.current = async (command) => {
    const current = inputRef.current;
    switch (command.type) {
      case "start-recording": {
        if (!sameToken(stateRef.current.activeToken, command.token)) return;
        if (!(await current.speech.interrupt())) {
          dispatch({ type: "arm-failed", token: command.token });
          return;
        }
        if (!sameToken(stateRef.current.activeToken, command.token)) return;
        const recordingId = await current.dictation.start();
        dispatch(
          recordingId === null
            ? { type: "arm-failed", token: command.token }
            : { type: "arm-succeeded", token: command.token, recordingId },
        );
        return;
      }
      case "cancel-recording":
        await current.dictation.cancel();
        return;
      case "cancel-playback":
        await current.speech.interrupt();
        current.speech.resumeAfterDictation();
        return;
      case "set-review-draft":
        return;
      case "submit-transcript": {
        if (
          !sameToken(stateRef.current.activeToken, command.token) ||
          stateRef.current.target?.environmentId !== command.target.environmentId ||
          stateRef.current.target?.threadId !== command.target.threadId
        ) {
          if (
            reviewSubmissionWaiterRef.current !== null &&
            sameToken(reviewSubmissionWaiterRef.current.token, command.token)
          ) {
            reviewSubmissionWaiterRef.current.resolve(false);
            reviewSubmissionWaiterRef.current = null;
          }
          return;
        }
        const messageId = await current.onSendVoiceMessage(command.transcript);
        dispatch(
          messageId === null
            ? { type: "submission-failed", token: command.token }
            : { type: "submission-succeeded", token: command.token, messageId },
        );
        if (
          reviewSubmissionWaiterRef.current !== null &&
          sameToken(reviewSubmissionWaiterRef.current.token, command.token)
        ) {
          reviewSubmissionWaiterRef.current.resolve(messageId !== null);
          reviewSubmissionWaiterRef.current = null;
        }
        return;
      }
      case "start-guard":
        clearTimer("guard");
        guardTimerRef.current = setTimeout(() => {
          guardTimerRef.current = null;
          dispatch({ type: "guard-elapsed", token: command.token });
        }, command.delayMs);
        return;
      case "cancel-guard":
        clearTimer("guard");
        return;
      case "start-response-timeout":
        clearTimer("response");
        responseTimerRef.current = setTimeout(() => {
          responseTimerRef.current = null;
          dispatch({ type: "response-timeout", token: command.token });
        }, current.preferences.responseTimeoutMs);
        return;
      case "cancel-response-timeout":
        clearTimer("response");
        return;
      case "start-transcription-timeout":
        clearTimer("transcription");
        transcriptionTimerRef.current = setTimeout(() => {
          transcriptionTimerRef.current = null;
          dispatch({ type: "transcription-timeout", token: command.token });
        }, current.preferences.transcriptionTimeoutMs);
        return;
      case "cancel-transcription-timeout":
        clearTimer("transcription");
        return;
      case "start-submission-timeout":
        clearTimer("submission");
        submissionTimerRef.current = setTimeout(() => {
          submissionTimerRef.current = null;
          dispatch({ type: "submission-timeout", token: command.token });
        }, current.preferences.submissionTimeoutMs);
        return;
      case "cancel-submission-timeout":
        clearTimer("submission");
    }
  };

  const persistPaused = useCallback(() => {
    savePreferences({ voiceMode: "off" });
  }, [savePreferences]);

  const pause = useCallback(
    (reason: VoiceThreadModePauseReason = "user") => {
      dispatch({ type: "pause", reason });
      persistPaused();
    },
    [dispatch, persistPaused],
  );

  const activate = useCallback(async () => {
    const current = inputRef.current;
    if (!current.preferences.autoListenEnabled || !current.canStartFromComposer) return false;
    if (stateRef.current.phase !== "paused") {
      dispatch({ type: "pause", reason: "user" });
    }
    await current.stopRealtime();
    const latest = inputRef.current;
    if (
      !mountedRef.current ||
      !latest.preferences.autoListenEnabled ||
      !latest.canStartFromComposer ||
      latest.environmentId !== current.environmentId ||
      latest.threadId !== current.threadId
    ) {
      return false;
    }
    const generation = ++generationRef.current;
    const target: VoiceThreadModeTarget = {
      environmentId: current.environmentId,
      threadId: current.threadId,
      generation,
    };
    savePreferences({
      voiceMode: "thread",
      voiceThreadTarget: {
        environmentId: current.environmentId,
        threadId: current.threadId,
        generation,
      },
    });
    dispatch({
      type: "activate",
      target,
      policy: latest.preferences.autoSubmitEnabled ? "auto-submit" : "review",
      playbackRequired: latest.speech.enabled,
      threadBusy: latest.activeThreadBusy,
    });
    return true;
  }, [dispatch, savePreferences]);

  const submitReview = useCallback(
    async (transcript: string) => {
      if (stateRef.current.phase !== "reviewing") return false;
      const next = dispatch({ type: "review-submit", transcript });
      const token = next.activeToken;
      if (token === null || next.phase !== "submitting") return true;
      const completion = new Promise<boolean>((resolve) => {
        reviewSubmissionWaiterRef.current = { token, resolve };
      });
      await completion;
      return true;
    },
    [dispatch],
  );

  useEffect(() => {
    const targetKey = `${input.environmentId}:${input.threadId}`;
    if (targetKeyRef.current === targetKey) return;
    targetKeyRef.current = targetKey;
    const generation = ++generationRef.current;
    dispatch({
      type: "target-changed",
      target: {
        environmentId: input.environmentId,
        threadId: input.threadId,
        generation,
      },
    });
    persistPaused();
  }, [dispatch, input.environmentId, input.threadId, persistPaused]);

  useEffect(() => {
    if (!input.preferences.autoListenEnabled && stateRef.current.phase !== "paused") {
      pause("disabled");
    }
  }, [input.preferences.autoListenEnabled, pause]);

  useEffect(() => {
    if (
      (input.realtimePhase === "starting" ||
        input.realtimePhase === "active" ||
        input.realtimePhase === "stopping" ||
        input.realtimePhase === "error") &&
      stateRef.current.phase !== "paused"
    ) {
      dispatch({ type: "realtime-active" });
      persistPaused();
    }
  }, [dispatch, input.realtimePhase, persistPaused]);

  useEffect(() => {
    dispatch({ type: "thread-busy-changed", busy: input.activeThreadBusy });
  }, [dispatch, input.activeThreadBusy]);

  useEffect(() => {
    if (input.interactionRequired && stateRef.current.phase !== "paused") {
      pause("interaction-required");
    }
  }, [input.interactionRequired, pause]);

  useEffect(() => {
    if (
      input.dictation.phase === "transcribing" &&
      (stateRef.current.phase === "listening" || stateRef.current.phase === "endpointing") &&
      stateRef.current.activeToken !== null
    ) {
      dispatch({ type: "recording-completed", token: stateRef.current.activeToken });
    }
  }, [dispatch, input.dictation.phase]);

  useEffect(() => {
    const event = input.dictation.transcriptionEvent;
    if (event === null || event.sequence <= lastTranscriptionSequenceRef.current) return;
    lastTranscriptionSequenceRef.current = event.sequence;
    const token = stateRef.current.activeToken;
    if (
      token !== null &&
      stateRef.current.phase === "transcribing" &&
      stateRef.current.recordingId === event.recordingId
    ) {
      dispatch({ type: "transcription-completed", token, transcript: event.finalDraft });
    }
  }, [dispatch, input.dictation.transcriptionEvent]);

  useEffect(() => {
    const event = input.dictation.terminationEvent;
    if (event === null || event.sequence <= lastTerminationSequenceRef.current) return;
    lastTerminationSequenceRef.current = event.sequence;
    if (stateRef.current.phase !== "paused" && stateRef.current.recordingId === event.recordingId) {
      pause(event.outcome === "cancelled" ? "no-speech" : "recording-failed");
    }
  }, [input.dictation.terminationEvent, pause]);

  useEffect(() => {
    if (input.dictation.error !== null && stateRef.current.phase !== "paused") {
      pause(
        stateRef.current.phase === "transcribing" ? "transcription-failed" : "recording-failed",
      );
    }
  }, [input.dictation.error, pause]);

  useEffect(() => {
    const submittedMessageId = stateRef.current.submittedMessageId;
    if (
      submittedMessageId === null ||
      input.activeThreadBusy ||
      (stateRef.current.phase !== "waiting-response" && stateRef.current.phase !== "speaking")
    ) {
      return;
    }
    const assistant = findCompletedAutoListenResponse(input.threadMessages, submittedMessageId);
    if (assistant === null) return;
    dispatch({ type: "assistant-stream-started", messageId: assistant.id });
    dispatch({ type: "assistant-stream-completed", messageId: assistant.id });
  }, [dispatch, input.activeThreadBusy, input.threadMessages, state.submittedMessageId]);

  useEffect(() => {
    const event = input.speech.lifecycleEvent;
    if (event === null || event.sequence <= lastPlaybackSequenceRef.current) return;
    if (
      stateRef.current.assistantMessageId !== event.messageId ||
      (stateRef.current.phase !== "waiting-response" && stateRef.current.phase !== "speaking")
    ) {
      return;
    }
    lastPlaybackSequenceRef.current = event.sequence;
    switch (event.outcome) {
      case "started":
        dispatch({
          type: "playback-started",
          playbackId: event.playbackId,
          messageId: event.messageId,
        });
        return;
      case "drained":
        dispatch({
          type: "playback-drained",
          playbackId: event.playbackId,
          messageId: event.messageId,
        });
        return;
      case "cancelled":
        dispatch({
          type: "playback-cancelled",
          playbackId: event.playbackId,
          messageId: event.messageId,
        });
        return;
      case "failed":
        dispatch({
          type: "playback-failed",
          playbackId: event.playbackId,
          messageId: event.messageId,
        });
    }
  }, [dispatch, input.speech.lifecycleEvent, state.assistantMessageId]);

  useEffect(() => {
    if (input.speech.error !== null && stateRef.current.phase !== "paused") {
      pause("playback-failed");
    }
  }, [input.speech.error, pause]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active" && stateRef.current.phase !== "paused") pause("lifecycle");
    });
    return () => subscription.remove();
  }, [pause]);

  useEffect(
    () => () => {
      clearTimer("guard");
      clearTimer("response");
      clearTimer("transcription");
      clearTimer("submission");
      mountedRef.current = false;
      reviewSubmissionWaiterRef.current?.resolve(false);
      reviewSubmissionWaiterRef.current = null;
      void inputRef.current.dictation.cancel();
      void inputRef.current.speech.interrupt();
      savePreferences({ voiceMode: "off" });
    },
    [savePreferences],
  );

  return {
    state,
    active: state.phase !== "paused",
    activate,
    pause,
    submitReview,
  };
}

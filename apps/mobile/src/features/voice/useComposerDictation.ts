import { makeMobileVoiceClient } from "./mobileVoiceClient";
import { VoiceRequestId, type VoiceTranscriptionStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { useCallback, useEffect, useRef, useState } from "react";

import { getT3VoiceNativeModule, type T3VoiceRecordingResult } from "@t3tools/mobile-voice-native";
import { uuidv4 } from "../../lib/uuid";
import { usePreparedConnection } from "../../state/session";
import {
  applyTranscriptionEvent,
  beginTranscriptionDraft,
  renderTranscriptionDraft,
} from "./transcriptionDraft";
import { useVoiceCapabilityDescriptor } from "./useVoiceCapabilityAvailability";
import { validateRecordingAgainstCapability } from "./dictationPolicy";
import {
  cleanupOrphanedRecordingTermination,
  dictationTerminationOwnership,
} from "./dictationTermination";
import { canStartComposerDictation } from "./dictationAdmission";
import { ensureMicrophonePermission } from "./microphonePermission";
import { releaseRecordingForRealtime } from "./traditionalAudioHandoff";
import type { ResolvedVoicePreferences } from "./voicePreferences";
import { voiceErrorMessage as errorMessage } from "./voiceError";

export type ComposerDictationPhase = "idle" | "recording" | "transcribing";

export interface ComposerTranscriptionEvent {
  readonly sequence: number;
  readonly recordingId: string;
  readonly draftAtStart: string;
  readonly finalDraft: string;
}

export interface ComposerRecordingTerminationEvent {
  readonly sequence: number;
  readonly recordingId: string;
  readonly outcome: "cancelled" | "failed";
  readonly reason: "no-speech" | "finalization-failed";
}

export function useComposerDictation(input: {
  readonly environmentId: Parameters<typeof usePreparedConnection>[0];
  readonly scopeKey: string;
  readonly draftMessage: string;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly voicePreferences: Pick<
    ResolvedVoicePreferences,
    "endSilenceMs" | "noSpeechTimeoutMs" | "maximumUtteranceMs"
  >;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const native = getT3VoiceNativeModule();
  const capability = useVoiceCapabilityDescriptor(prepared, "transcription.request");
  const [phase, setPhase] = useState<ComposerDictationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcriptionEvent, setTranscriptionEvent] = useState<ComposerTranscriptionEvent | null>(
    null,
  );
  const [terminationEvent, setTerminationEvent] =
    useState<ComposerRecordingTerminationEvent | null>(null);
  const eventSequenceRef = useRef(0);
  const recordingIdRef = useRef<string | null>(null);
  const stoppingRecordingIdRef = useRef<string | null>(null);
  const transcribingRecordingIdRef = useRef<string | null>(null);
  const operationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const startPendingRef = useRef(false);
  const startSettlementRef = useRef<Promise<void> | null>(null);
  const stopSettlementRef = useRef<Promise<void> | null>(null);
  const lifecycleRef = useRef({ scopeKey: input.scopeKey, native, prepared });
  const draftRef = useRef(input.draftMessage);
  draftRef.current = input.draftMessage;

  const changeDraft = useCallback(
    (value: string) => {
      draftRef.current = value;
      input.onChangeDraftMessage(value);
    },
    [input.onChangeDraftMessage],
  );

  const transcribeCompletedRecording = useCallback(
    async (completedRecording: T3VoiceRecordingResult, generation: number, draftAtStop: string) => {
      if (native === null || prepared === null) return;
      transcribingRecordingIdRef.current = completedRecording.recordingId;
      let finalDraft: string | null = null;
      try {
        if (operationGenerationRef.current !== generation) return;
        if (capability !== null) validateRecordingAgainstCapability(completedRecording, capability);
        const requestId = VoiceRequestId.make(uuidv4());
        const client = await makeMobileVoiceClient(prepared);
        if (operationGenerationRef.current !== generation) return;
        const ticket = await Effect.runPromise(
          client.createMediaTicket({ operation: "transcription-upload", requestId }),
        );
        if (operationGenerationRef.current !== generation) return;
        let draft = beginTranscriptionDraft(draftAtStop);
        let lastRendered = draftAtStop;
        const applyEvent = (event: VoiceTranscriptionStreamEvent) =>
          Effect.sync(() => {
            if (operationGenerationRef.current !== generation) {
              throw new Error("Dictation was cancelled");
            }
            if (draftRef.current !== lastRendered) {
              throw new Error("Dictation stopped because the composer was edited");
            }
            draft = applyTranscriptionEvent(draft, event);
            lastRendered = renderTranscriptionDraft(draft);
            changeDraft(lastRendered);
          });
        await Effect.runPromise(
          client
            .transcribe({
              audio: {
                kind: "uri",
                uri: completedRecording.uri,
                filename: "recording.m4a",
              },
              metadata: {
                requestId,
                format: completedRecording.mimeType,
              },
              ticket,
            })
            .pipe(Stream.runForEach(applyEvent)),
        );
        finalDraft = lastRendered;
      } catch (cause) {
        if (operationGenerationRef.current === generation) setError(errorMessage(cause));
      } finally {
        if (finalDraft !== null && operationGenerationRef.current === generation) {
          setTranscriptionEvent({
            sequence: ++eventSequenceRef.current,
            recordingId: completedRecording.recordingId,
            draftAtStart: draftAtStop,
            finalDraft,
          });
        }
        await native
          .deleteRecordingAsync({
            recordingId: completedRecording.recordingId,
            uri: completedRecording.uri,
          })
          .catch(() => undefined);
        if (transcribingRecordingIdRef.current === completedRecording.recordingId) {
          transcribingRecordingIdRef.current = null;
        }
        if (operationGenerationRef.current === generation) setPhase("idle");
      }
    },
    [capability, changeDraft, native, prepared],
  );

  const start = useCallback(async () => {
    if (
      native === null ||
      prepared === null ||
      capability === null ||
      !canStartComposerDictation({
        phase,
        startPending: startPendingRef.current,
        activeRecordingId: recordingIdRef.current,
        stoppingRecordingId: stoppingRecordingIdRef.current,
        transcribingRecordingId: transcribingRecordingIdRef.current,
      })
    )
      return null;
    const generation = ++operationGenerationRef.current;
    startPendingRef.current = true;
    let settleStart: (() => void) | undefined;
    const startSettlement = new Promise<void>((resolve) => {
      settleStart = resolve;
    });
    startSettlementRef.current = startSettlement;
    setError(null);
    try {
      await ensureMicrophonePermission(native);
      if (operationGenerationRef.current !== generation) return null;
      const recordingId = uuidv4();
      await native.startRecordingAsync({
        recordingId,
        endpointDetection: {
          endSilenceMs: input.voicePreferences.endSilenceMs,
          maximumUtteranceMs: input.voicePreferences.maximumUtteranceMs,
          ...(input.voicePreferences.noSpeechTimeoutMs === null
            ? {}
            : { noSpeechTimeoutMs: input.voicePreferences.noSpeechTimeoutMs }),
        },
      });
      if (operationGenerationRef.current !== generation) {
        try {
          await native.cancelRecordingAsync({ recordingId });
        } catch (cause) {
          recordingIdRef.current = recordingId;
          throw cause;
        }
        return null;
      }
      recordingIdRef.current = recordingId;
      setPhase("recording");
      return recordingId;
    } catch (cause) {
      if (operationGenerationRef.current !== generation) return null;
      setError(errorMessage(cause));
      setPhase("idle");
      return null;
    } finally {
      if (operationGenerationRef.current === generation) startPendingRef.current = false;
      settleStart?.();
      if (startSettlementRef.current === startSettlement) startSettlementRef.current = null;
    }
  }, [capability, input.voicePreferences, native, phase, prepared]);

  const stop = useCallback(async () => {
    const recordingId = recordingIdRef.current;
    if (native === null || prepared === null || phase !== "recording" || recordingId === null) {
      return false;
    }
    recordingIdRef.current = null;
    stoppingRecordingIdRef.current = recordingId;
    let settleStop: (() => void) | undefined;
    const stopSettlement = new Promise<void>((resolve) => {
      settleStop = resolve;
    });
    stopSettlementRef.current = stopSettlement;
    const generation = ++operationGenerationRef.current;
    const draftAtStop = draftRef.current;
    setPhase("transcribing");
    setError(null);
    try {
      const completedRecording = await native.stopRecordingAsync({ recordingId });
      if (operationGenerationRef.current !== generation) {
        await native
          .deleteRecordingAsync({
            recordingId: completedRecording.recordingId,
            uri: completedRecording.uri,
          })
          .catch(() => undefined);
        return false;
      }
      await transcribeCompletedRecording(completedRecording, generation, draftAtStop);
      return true;
    } catch (cause) {
      if (operationGenerationRef.current === generation) setError(errorMessage(cause));
      return false;
    } finally {
      if (stoppingRecordingIdRef.current === recordingId) stoppingRecordingIdRef.current = null;
      if (operationGenerationRef.current === generation) setPhase("idle");
      settleStop?.();
      if (stopSettlementRef.current === stopSettlement) stopSettlementRef.current = null;
    }
  }, [native, phase, prepared, transcribeCompletedRecording]);

  const cancel = useCallback(async () => {
    ++operationGenerationRef.current;
    startPendingRef.current = false;
    const recordingId = recordingIdRef.current;
    recordingIdRef.current = null;
    stoppingRecordingIdRef.current = null;
    if (native !== null && recordingId !== null) {
      await native.cancelRecordingAsync({ recordingId }).catch(() => undefined);
    }
    if (mountedRef.current) setPhase("idle");
  }, [native]);

  const cancelForRealtime = useCallback(async () => {
    ++operationGenerationRef.current;
    startPendingRef.current = false;
    try {
      if (native !== null) {
        await releaseRecordingForRealtime({
          native,
          pendingStart: startSettlementRef.current,
          pendingStop: stopSettlementRef.current,
          getRecordingId: () => recordingIdRef.current,
        });
      }
      recordingIdRef.current = null;
      if (mountedRef.current) {
        setError(null);
        setPhase("idle");
      }
    } catch (cause) {
      if (mountedRef.current) {
        setError(errorMessage(cause));
        setPhase(recordingIdRef.current === null ? "idle" : "recording");
      }
      throw cause;
    }
  }, [native]);

  useEffect(() => {
    if (native === null) return;
    const subscription = native.addListener("recordingTerminated", (event) => {
      const ownership = dictationTerminationOwnership({
        recordingId: event.recordingId,
        activeRecordingId: recordingIdRef.current,
        stoppingRecordingId: stoppingRecordingIdRef.current,
        transcribingRecordingId: transcribingRecordingIdRef.current,
      });
      if (ownership === "orphaned") {
        void cleanupOrphanedRecordingTermination(native, event).catch(() => undefined);
        return;
      }
      if (ownership === "transcribing") {
        void native
          .acknowledgeRecordingTerminationAsync({ recordingId: event.recordingId })
          .catch(() => undefined);
        return;
      }
      ++operationGenerationRef.current;
      startPendingRef.current = false;
      recordingIdRef.current = null;
      stoppingRecordingIdRef.current = null;
      setError(null);
      if (event.outcome === "cancelled") {
        setTerminationEvent({
          sequence: ++eventSequenceRef.current,
          recordingId: event.recordingId,
          outcome: "cancelled",
          reason: "no-speech",
        });
        setPhase("idle");
        void native
          .acknowledgeRecordingTerminationAsync({ recordingId: event.recordingId })
          .catch(() => undefined);
        return;
      }
      if (event.outcome === "failed") {
        setTerminationEvent({
          sequence: ++eventSequenceRef.current,
          recordingId: event.recordingId,
          outcome: "failed",
          reason: "finalization-failed",
        });
        setError("The recording could not be finalized.");
        setPhase("idle");
        void native
          .acknowledgeRecordingTerminationAsync({ recordingId: event.recordingId })
          .catch(() => undefined);
        return;
      }
      setPhase("transcribing");
      const generation = operationGenerationRef.current;
      void transcribeCompletedRecording(event.recording, generation, draftRef.current);
    });
    return () => subscription.remove();
  }, [native, transcribeCompletedRecording]);

  useEffect(() => {
    const previous = lifecycleRef.current;
    const changed =
      previous.scopeKey !== input.scopeKey ||
      previous.native !== native ||
      previous.prepared !== prepared;
    lifecycleRef.current = { scopeKey: input.scopeKey, native, prepared };
    if (changed) {
      setPhase("idle");
      setError(null);
    }
    return () => {
      ++operationGenerationRef.current;
      startPendingRef.current = false;
      const recordingId = recordingIdRef.current;
      recordingIdRef.current = null;
      stoppingRecordingIdRef.current = null;
      if (native !== null && recordingId !== null) {
        void native.cancelRecordingAsync({ recordingId });
      }
    };
  }, [input.scopeKey, native, prepared]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  return {
    available: native !== null && prepared !== null && capability !== null,
    phase,
    error,
    transcriptionEvent,
    terminationEvent,
    start,
    stop,
    cancel,
    cancelForRealtime,
  };
}

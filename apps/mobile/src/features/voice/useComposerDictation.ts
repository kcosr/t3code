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

export type ComposerDictationPhase = "idle" | "recording" | "transcribing";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function useComposerDictation(input: {
  readonly environmentId: Parameters<typeof usePreparedConnection>[0];
  readonly scopeKey: string;
  readonly draftMessage: string;
  readonly onChangeDraftMessage: (value: string) => void;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const native = getT3VoiceNativeModule();
  const capability = useVoiceCapabilityDescriptor(prepared, "transcription.request");
  const [phase, setPhase] = useState<ComposerDictationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const stoppingRecordingIdRef = useRef<string | null>(null);
  const operationGenerationRef = useRef(0);
  const startPendingRef = useRef(false);
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
      } catch (cause) {
        if (operationGenerationRef.current === generation) setError(errorMessage(cause));
      } finally {
        await native
          .deleteRecordingAsync({
            recordingId: completedRecording.recordingId,
            uri: completedRecording.uri,
          })
          .catch(() => undefined);
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
      phase !== "idle" ||
      startPendingRef.current
    )
      return;
    const generation = ++operationGenerationRef.current;
    startPendingRef.current = true;
    setError(null);
    try {
      const currentPermission = await native.getMicrophonePermissionAsync();
      const permission = currentPermission.granted
        ? currentPermission
        : await native.requestMicrophonePermissionAsync();
      if (!permission.granted) throw new Error("Microphone permission was not granted");
      if (operationGenerationRef.current !== generation) return;
      const recordingId = uuidv4();
      await native.startRecordingAsync({
        recordingId,
        endpointDetection: {
          endSilenceMs: 1_200,
        },
      });
      if (operationGenerationRef.current !== generation) {
        await native.cancelRecordingAsync({ recordingId }).catch(() => undefined);
        return;
      }
      recordingIdRef.current = recordingId;
      setPhase("recording");
    } catch (cause) {
      if (operationGenerationRef.current !== generation) return;
      setError(errorMessage(cause));
      setPhase("idle");
    } finally {
      if (operationGenerationRef.current === generation) startPendingRef.current = false;
    }
  }, [capability, native, phase, prepared]);

  const stop = useCallback(async () => {
    const recordingId = recordingIdRef.current;
    if (native === null || prepared === null || phase !== "recording" || recordingId === null) {
      return;
    }
    recordingIdRef.current = null;
    stoppingRecordingIdRef.current = recordingId;
    const generation = ++operationGenerationRef.current;
    const draftAtStop = draftRef.current;
    setPhase("transcribing");
    setError(null);
    try {
      const completedRecording = await native.stopRecordingAsync({ recordingId });
      if (operationGenerationRef.current !== generation) return;
      await transcribeCompletedRecording(completedRecording, generation, draftAtStop);
    } catch (cause) {
      if (operationGenerationRef.current === generation) setError(errorMessage(cause));
    } finally {
      if (stoppingRecordingIdRef.current === recordingId) stoppingRecordingIdRef.current = null;
      if (operationGenerationRef.current === generation) setPhase("idle");
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
    setPhase("idle");
  }, [native]);

  useEffect(() => {
    if (native === null) return;
    const subscription = native.addListener("recordingTerminated", (event) => {
      const orphanedTermination =
        recordingIdRef.current !== event.recordingId &&
        stoppingRecordingIdRef.current !== event.recordingId;
      if (orphanedTermination) {
        if (event.outcome === "completed") {
          void native
            .deleteRecordingAsync({
              recordingId: event.recordingId,
              uri: event.recording.uri,
            })
            .catch(() => undefined);
        } else {
          void native
            .acknowledgeRecordingTerminationAsync({ recordingId: event.recordingId })
            .catch(() => undefined);
        }
        return;
      }
      ++operationGenerationRef.current;
      startPendingRef.current = false;
      recordingIdRef.current = null;
      stoppingRecordingIdRef.current = null;
      setError(null);
      if (event.outcome === "cancelled") {
        setPhase("idle");
        void native
          .acknowledgeRecordingTerminationAsync({ recordingId: event.recordingId })
          .catch(() => undefined);
        return;
      }
      if (event.outcome === "failed") {
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

  return {
    available: native !== null && prepared !== null && capability !== null,
    phase,
    error,
    start,
    stop,
    cancel,
  };
}

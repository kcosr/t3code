import type { VoiceCapabilityDescriptor, VoiceTranscriptionStreamEvent } from "@t3tools/contracts";
import type {
  T3VoiceNativeModule,
  T3VoiceRecordingResult,
  T3VoiceRecordingTerminatedEvent,
} from "@t3tools/mobile-voice-native";

// --- admission ---

export function canStartComposerDictation(input: {
  readonly phase: "idle" | "recording" | "transcribing";
  readonly startPending: boolean;
  readonly activeRecordingId: string | null;
  readonly stoppingRecordingId: string | null;
  readonly transcribingRecordingId: string | null;
}): boolean {
  return (
    input.phase === "idle" &&
    !input.startPending &&
    input.activeRecordingId === null &&
    input.stoppingRecordingId === null &&
    input.transcribingRecordingId === null
  );
}

// --- capability preflight ---

export const validateRecordingAgainstCapability = (
  recording: Pick<T3VoiceRecordingResult, "byteLength" | "durationMs">,
  capability: VoiceCapabilityDescriptor,
): void => {
  if (capability.maxInputBytes !== undefined && recording.byteLength > capability.maxInputBytes) {
    throw new Error(
      `Recording is too large for this environment (maximum ${Math.floor(capability.maxInputBytes / (1024 * 1024))} MiB)`,
    );
  }
  if (
    capability.maxInputDurationSeconds !== undefined &&
    recording.durationMs > capability.maxInputDurationSeconds * 1_000
  ) {
    throw new Error(
      `Recording is too long for this environment (maximum ${Math.floor(capability.maxInputDurationSeconds / 60)} minutes)`,
    );
  }
};

// --- termination ownership / orphan cleanup ---

export type DictationTerminationOwnership = "active" | "orphaned" | "transcribing";

export function dictationTerminationOwnership(input: {
  readonly recordingId: string;
  readonly activeRecordingId: string | null;
  readonly stoppingRecordingId: string | null;
  readonly transcribingRecordingId: string | null;
}): DictationTerminationOwnership {
  if (input.transcribingRecordingId === input.recordingId) return "transcribing";
  if (
    input.activeRecordingId === input.recordingId ||
    input.stoppingRecordingId === input.recordingId
  ) {
    return "active";
  }
  return "orphaned";
}

export async function cleanupOrphanedRecordingTermination(
  native: T3VoiceNativeModule,
  event: T3VoiceRecordingTerminatedEvent,
): Promise<void> {
  if (event.outcome === "completed") {
    await native.deleteRecordingAsync({
      recordingId: event.recordingId,
      uri: event.recording.uri,
    });
    return;
  }
  await native.acknowledgeRecordingTerminationAsync({ recordingId: event.recordingId });
}

// --- transcription draft merge ---

export interface TranscriptionDraftState {
  readonly prefix: string;
  readonly transcript: string;
}

export const beginTranscriptionDraft = (draft: string): TranscriptionDraftState => ({
  prefix: draft.length === 0 || /\s$/.test(draft) ? draft : `${draft} `,
  transcript: "",
});

export const applyTranscriptionEvent = (
  state: TranscriptionDraftState,
  event: VoiceTranscriptionStreamEvent,
): TranscriptionDraftState => ({
  ...state,
  transcript: event.type === "delta" ? state.transcript + event.text : event.result.text,
});

export const renderTranscriptionDraft = (state: TranscriptionDraftState): string =>
  `${state.prefix}${state.transcript}`;

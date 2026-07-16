import type {
  T3VoiceNativeModule,
  T3VoiceRecordingTerminatedEvent,
} from "@t3tools/mobile-voice-native";

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

export async function discardOrphanedRecordingTerminationIfUnowned(
  native: T3VoiceNativeModule,
  event: T3VoiceRecordingTerminatedEvent,
): Promise<boolean> {
  return native.discardUnownedRecordingTerminationAsync({ operationId: event.operationId });
}

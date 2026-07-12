import type {
  T3VoiceNativeModule,
  T3VoiceRecordingTerminatedEvent,
} from "@t3tools/mobile-voice-native";

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

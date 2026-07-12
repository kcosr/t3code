import type { VoiceCapabilityDescriptor } from "@t3tools/contracts";
import type { T3VoiceRecordingResult } from "@t3tools/mobile-voice-native";

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

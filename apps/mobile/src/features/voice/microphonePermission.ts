import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";

type MicrophonePermissionControl = Pick<
  T3VoiceNativeModule,
  "getMicrophonePermissionAsync" | "requestMicrophonePermissionAsync"
>;

export async function ensureMicrophonePermission(
  native: MicrophonePermissionControl,
): Promise<void> {
  const current = await native.getMicrophonePermissionAsync();
  if (current.granted) return;
  const requested = await native.requestMicrophonePermissionAsync();
  if (!requested.granted) throw new Error("Microphone permission is required for voice");
}

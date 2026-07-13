import type { VoiceThreadModePauseReason } from "./voiceThreadModeStateMachine";

const SILENT_PAUSE_REASONS = new Set<VoiceThreadModePauseReason>([
  "user",
  "disabled",
  "target-changed",
  "realtime-active",
  "lifecycle",
  "playback-cancelled",
]);

export function shouldShowAutoListenPauseAlert(
  reason: VoiceThreadModePauseReason | null,
): reason is VoiceThreadModePauseReason {
  return reason !== null && !SILENT_PAUSE_REASONS.has(reason);
}

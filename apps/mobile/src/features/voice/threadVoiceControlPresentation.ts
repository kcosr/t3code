import type { VoiceRuntimeSnapshot } from "@t3tools/client-runtime/voice";

export interface ThreadVoiceControlPresentation {
  readonly active: boolean;
  readonly command: "start" | "finish-recording" | "stop";
  readonly accessibilityLabel: string;
  readonly icon: "waveform" | "checkmark" | "stop.fill";
}

/** Mirrors the command dispatched by the composer's single Thread voice control. */
export function threadVoiceControlPresentation(
  snapshot: VoiceRuntimeSnapshot,
  active: boolean,
): ThreadVoiceControlPresentation {
  if (!active) {
    return {
      active: false,
      command: "start",
      accessibilityLabel: "Start Auto Listen",
      icon: "waveform",
    };
  }
  if (snapshot.mode === "thread" && snapshot.phase === "recording") {
    return {
      active: true,
      command: "finish-recording",
      accessibilityLabel: "Finish Thread voice recording",
      icon: "checkmark",
    };
  }
  return {
    active: true,
    command: "stop",
    accessibilityLabel: "Stop Thread voice",
    icon: "stop.fill",
  };
}

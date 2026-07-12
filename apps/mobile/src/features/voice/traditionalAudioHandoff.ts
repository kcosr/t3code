import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";

type PlaybackControl = Pick<T3VoiceNativeModule, "cancelPlaybackAsync" | "getStateAsync">;

export interface TraditionalAudioTransitionLock {
  active: boolean;
}

export async function runExclusiveTraditionalAudioTransition(
  lock: TraditionalAudioTransitionLock,
  transition: () => Promise<void>,
): Promise<boolean> {
  if (lock.active) return false;
  lock.active = true;
  try {
    await transition();
    return true;
  } finally {
    lock.active = false;
  }
}

export async function startDictationWithAudioHandoff(input: {
  readonly stopRealtime: () => Promise<void>;
  readonly interruptPlayback: () => Promise<boolean>;
  readonly startDictation: () => Promise<boolean>;
  readonly resumePlayback: () => void;
}): Promise<boolean> {
  await input.stopRealtime();
  if (!(await input.interruptPlayback())) return false;
  const started = await input.startDictation();
  if (!started) input.resumePlayback();
  return started;
}

export function dictationResumeTransition(
  wasActive: boolean,
  phase: "idle" | "recording" | "transcribing",
): { readonly wasActive: boolean; readonly resume: boolean } {
  if (phase !== "idle") return { wasActive: true, resume: false };
  return wasActive ? { wasActive: false, resume: true } : { wasActive: false, resume: false };
}

export async function releasePlaybackForRecording(input: {
  readonly native: PlaybackControl;
  readonly playbackId: string;
  readonly pendingStart?: Promise<void>;
  readonly timeoutMs?: number;
}): Promise<void> {
  const release = async () => {
    await input.pendingStart?.catch(() => undefined);
    await input.native
      .cancelPlaybackAsync({ playbackId: input.playbackId })
      .catch(async (cause) => {
        const state = await input.native.getStateAsync();
        if (state.phase !== "idle" || state.activePlaybackId !== null) throw cause;
      });
    const state = await input.native.getStateAsync();
    if (state.phase !== "idle" || state.activePlaybackId !== null) {
      throw new Error("Voice playback could not be interrupted");
    }
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      release(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Voice playback interruption timed out")),
          input.timeoutMs ?? 5_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

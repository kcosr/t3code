import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";

type PlaybackControl = Pick<T3VoiceNativeModule, "cancelPlaybackAsync" | "getStateAsync">;
type RecordingControl = Pick<T3VoiceNativeModule, "cancelRecordingAsync" | "getStateAsync">;

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

export async function startManualDictationWithAudioHandoff(input: {
  readonly autoListenActive: boolean;
  readonly deactivateAutoListen: () => Promise<void>;
  readonly stopRealtime: () => Promise<void>;
  readonly interruptPlayback: () => Promise<boolean>;
  readonly startDictation: () => Promise<boolean>;
  readonly resumePlayback: () => void;
}): Promise<boolean> {
  if (input.autoListenActive) await input.deactivateAutoListen();
  return startDictationWithAudioHandoff(input);
}

export async function activateAutoListenWithAudioHandoff(input: {
  readonly releaseManualDictation: () => Promise<void>;
  readonly activateAutoListen: () => Promise<boolean>;
}): Promise<boolean> {
  await input.releaseManualDictation();
  return input.activateAutoListen();
}

export async function releaseAutoListenForManualDictation(input: {
  readonly pause: () => void;
  readonly waitForMediaCommands: () => Promise<void>;
  readonly verifyRecordingReleased: () => Promise<void>;
}): Promise<void> {
  input.pause();
  await input.waitForMediaCommands();
  await input.verifyRecordingReleased();
}

export async function interruptTraditionalAudioForRealtime(input: {
  readonly cancelDictation: () => Promise<void>;
  readonly interruptPlayback: () => Promise<boolean>;
  readonly rollback: () => void;
}): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    input.rollback();
  };
  try {
    await input.cancelDictation();
    if (!(await input.interruptPlayback())) {
      throw new Error("Traditional voice playback could not be interrupted");
    }
    return release;
  } catch (cause) {
    release();
    throw cause;
  }
}

export async function releaseRecordingForRealtime(input: {
  readonly native: RecordingControl;
  readonly pendingStart: Promise<void> | null;
  readonly pendingStop: Promise<void> | null;
  readonly getRecordingId: () => string | null;
}): Promise<void> {
  await input.pendingStart;
  await input.pendingStop;
  const recordingId = input.getRecordingId();
  if (recordingId !== null) await input.native.cancelRecordingAsync({ recordingId });
  const state = await input.native.getStateAsync();
  if (state.activeRecordingId !== null || state.phase === "recording") {
    throw new Error("Traditional voice recording could not be interrupted");
  }
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

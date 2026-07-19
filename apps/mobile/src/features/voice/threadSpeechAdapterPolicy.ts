import type { VoiceThreadPhase } from "@t3tools/client-runtime/voice";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { voiceErrorMessage } from "./voiceError";

type NativeThreadSpeechModule = Pick<T3VoiceNativeModule, "skipThreadPlaybackAsync">;
type ReactThreadSpeechModule = Pick<T3VoiceNativeModule, "startPlaybackAsync">;

export type ThreadSpeechImplementation = "android-native" | "react";

export const selectThreadSpeechImplementation = (platform: string): ThreadSpeechImplementation =>
  platform === "android" ? "android-native" : "react";

/** The generic React adapter's explicit handoff into the bounded native PCM sink. */
export const startReactThreadPlayback = (
  native: ReactThreadSpeechModule,
  input: Parameters<T3VoiceNativeModule["startPlaybackAsync"]>[0],
): Promise<void> => native.startPlaybackAsync(input);

export const isAndroidThreadPlaybackForScope = (
  playback: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly phase: VoiceThreadPhase;
  },
  scopeKey: string,
): boolean =>
  playback.phase === "playing" &&
  scopedThreadKey(playback.environmentId, playback.threadId) === scopeKey;

export interface AndroidThreadSpeechCommands {
  readonly setEnabled: (enabled: boolean) => void;
  readonly interrupt: () => Promise<boolean>;
  readonly interruptForRealtime: () => Promise<boolean>;
}

const isInactiveThreadRuntimeError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "voice-runtime-invalid-state";

export const makeAndroidThreadSpeechCommands = (input: {
  readonly native: NativeThreadSpeechModule;
  readonly saveEnabled: (enabled: boolean) => void;
  readonly reportError: (message: string | null) => void;
}): AndroidThreadSpeechCommands => ({
  setEnabled: (enabled) => {
    input.reportError(null);
    input.saveEnabled(enabled);
  },
  interrupt: async () => {
    input.reportError(null);
    try {
      await input.native.skipThreadPlaybackAsync();
      return true;
    } catch (cause) {
      // Interrupt is idempotent from the UI's perspective. Native rejects the
      // command when there is no active Thread playback to skip.
      if (isInactiveThreadRuntimeError(cause)) return true;
      input.reportError(voiceErrorMessage(cause));
      return false;
    }
  },
  // The semantic runtime transition owns its own Thread playback teardown.
  // Dispatching skip here can race switchThreadToRealtimeAsync and reject the
  // transition as stale/invalid.
  interruptForRealtime: async () => {
    input.reportError(null);
    return true;
  },
});

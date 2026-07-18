import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { usePreparedConnection } from "../../state/session";
import {
  isAndroidThreadPlaybackForScope,
  makeAndroidThreadSpeechCommands,
} from "./threadSpeechAdapterPolicy";
import type { ThreadSpeechInput } from "./threadSpeechTypes";
import { useVoiceRuntime } from "./VoiceRuntimeProvider";

/**
 * Android's Thread UI adapter. Native owns the active cycle and response TTS;
 * this hook only projects its snapshot and forwards user intent.
 */
export function useAndroidNativeThreadSpeech(input: ThreadSpeechInput) {
  const native = getT3VoiceNativeModule();
  const prepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const voiceRuntime = useVoiceRuntime();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [error, setError] = useState<string | null>(null);
  const enabled =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.threadSpeechEnabled === true;
  const commands = useMemo(
    () =>
      native === null
        ? null
        : makeAndroidThreadSpeechCommands({
            native,
            saveEnabled: (nextEnabled) => savePreferences({ threadSpeechEnabled: nextEnabled }),
            reportError: setError,
          }),
    [native, savePreferences],
  );
  const playing =
    voiceRuntime.snapshot.mode === "thread" &&
    isAndroidThreadPlaybackForScope(
      {
        environmentId: voiceRuntime.snapshot.target.environmentId,
        threadId: voiceRuntime.snapshot.target.threadId,
        phase: voiceRuntime.snapshot.phase,
      },
      input.scopeKey,
    );
  const onToggle = useCallback(() => commands?.setEnabled(!enabled), [commands, enabled]);
  const enable = useCallback(() => commands?.setEnabled(true), [commands]);
  const interrupt = useCallback(async () => commands?.interrupt() ?? true, [commands]);
  const resume = useCallback(() => undefined, []);

  return {
    available: native !== null && prepared !== null,
    enabled,
    playing,
    error,
    onToggle,
    interrupt,
    interruptForRealtime: commands?.interruptForRealtime ?? interrupt,
    resumeAfterDictation: resume,
    resumeAfterRealtime: resume,
    enable,
    lifecycleEvent: null,
    latestAssistant: input.latestAssistant,
  };
}

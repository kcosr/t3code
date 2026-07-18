import { Platform } from "react-native";

import { selectThreadSpeechImplementation } from "./threadSpeechAdapterPolicy";
import { useAndroidNativeThreadSpeech } from "./useAndroidNativeThreadSpeech";
import { useThreadSpeech } from "./useThreadSpeech";
import type { ThreadSpeechInput } from "./threadSpeechTypes";

// Platform and native-module availability are process constants. Selecting the
// hook once at the composition root prevents Android from mounting React's
// message observer and generic PCM state machine at all.
const usePlatformThreadSpeech =
  selectThreadSpeechImplementation(Platform.OS) === "android-native"
    ? useAndroidNativeThreadSpeech
    : useThreadSpeech;

export function useThreadSpeechAdapter(input: ThreadSpeechInput) {
  return usePlatformThreadSpeech(input);
}

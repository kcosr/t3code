import { requireOptionalNativeModule } from "expo";

import type { T3VoiceNativeModule } from "./T3Voice.types";

export type {
  T3VoiceEventSubscription,
  T3VoiceMediaCapabilities,
  T3VoiceNativeModule,
  T3VoicePlaybackFinishInput,
  T3VoicePlaybackInput,
  T3VoicePlaybackChunkConsumedEvent,
  T3VoicePlaybackChunkInput,
  T3VoiceRecordingInput,
  T3VoiceRecordingDeleteInput,
  T3VoiceRecordingResult,
  T3VoiceAudioRoute,
  T3VoiceRealtimeAnswerInput,
  T3VoiceRealtimeConnectionState,
  T3VoiceRealtimeOffer,
  T3VoiceRealtimePrepareInput,
  T3VoiceRealtimeTerminatedEvent,
  T3VoiceRuntimeErrorEvent,
  T3VoiceRuntimePhase,
  T3VoiceRuntimeState,
} from "./T3Voice.types";

const NATIVE_MODULE_NAME = "T3Voice";

let resolvedModule: T3VoiceNativeModule | null | undefined;

export function getT3VoiceNativeModule(): T3VoiceNativeModule | null {
  if (resolvedModule !== undefined) {
    return resolvedModule;
  }

  try {
    resolvedModule = requireOptionalNativeModule<T3VoiceNativeModule>(NATIVE_MODULE_NAME);
  } catch {
    resolvedModule = null;
  }
  return resolvedModule;
}

export function isT3VoiceNativeModuleAvailable(): boolean {
  return getT3VoiceNativeModule() !== null;
}

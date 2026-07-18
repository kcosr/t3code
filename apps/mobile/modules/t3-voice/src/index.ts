import { requireOptionalNativeModule } from "expo";

import type { T3VoiceNativeModule } from "./T3Voice.types";

export type {
  T3VoiceEventSubscription,
  T3VoiceAudioRoutePreferenceState,
  T3VoiceCompleteRealtimeClientActionInput,
  T3VoiceConfigureReadinessInput,
  T3VoiceDecideRealtimeConfirmationInput,
  T3VoiceDiagnosticCategory,
  T3VoiceDiagnosticCode,
  T3VoiceDiagnosticEntry,
  T3VoiceMediaCapabilities,
  T3VoiceNativeModule,
  T3VoiceNativeSessionConfiguration,
  T3VoicePreparedReadinessStart,
  T3VoiceReadinessMode,
  T3VoiceReadinessSnapshot,
  T3VoicePlaybackFinishInput,
  T3VoicePlaybackInput,
  T3VoicePlaybackChunkConsumedEvent,
  T3VoicePlaybackTerminatedEvent,
  T3VoicePlaybackChunkInput,
  T3VoiceRecordingInput,
  T3VoiceRecordingDeleteInput,
  T3VoiceRecordingResult,
  T3VoiceRecordingTerminatedEvent,
  T3VoiceSetAudioRoutePreferenceInput,
  T3VoiceRealtimeAdmissionInput,
  T3VoiceSetRealtimeMutedInput,
  T3VoiceStartThreadInput,
  T3VoiceSubmitThreadTranscriptInput,
  T3VoiceUpdateThreadReviewTranscriptInput,
  T3VoiceRuntimeErrorEvent,
  T3VoiceTerminalRuntimeFailureEvent,
  T3VoiceRuntimePhase,
  T3VoiceRuntimeState,
} from "./T3Voice.types";

export type { VoiceAudioRoute, VoiceAudioRouteKind } from "@t3tools/client-runtime/voice";

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

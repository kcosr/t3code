import { requireOptionalNativeModule } from "expo";

import type { T3VoiceNativeModule } from "./T3Voice.types";

export type {
  T3VoiceEventSubscription,
  T3VoiceDiagnosticCategory,
  T3VoiceDiagnosticCode,
  T3VoiceDiagnosticEntry,
  T3VoiceMediaCapabilities,
  T3VoiceNativeModule,
  T3VoicePlaybackFinishInput,
  T3VoicePlaybackInput,
  T3VoicePlaybackChunkConsumedEvent,
  T3VoicePlaybackTerminatedEvent,
  T3VoicePlaybackChunkInput,
  T3VoiceRecordingInput,
  T3VoiceRecordingDeleteInput,
  T3VoiceRecordingResult,
  T3VoiceRecordingTerminatedEvent,
  T3VoiceAudioRoute,
  T3VoiceAudioRouteChangedEvent,
  T3VoiceRuntimeAuthorityActive,
  T3VoiceRuntimeAuthorityClearIfIdleInput,
  T3VoiceRuntimeAuthorityRevocation,
  T3VoiceRuntimeAuthoritySnapshot,
  T3VoiceRuntimeOwnership,
  T3VoiceRealtimeAnswerInput,
  T3VoiceRealtimeConnectionState,
  T3VoiceRealtimeOffer,
  T3VoiceRealtimePrepareInput,
  T3VoiceRealtimeTerminatedEvent,
  T3VoiceThreadVoiceHandoffEvent,
  T3VoiceReadinessMode,
  T3VoiceReadinessSnapshot,
  T3VoicePersistedReadinessSnapshot,
  T3VoiceControllerRegistration,
  T3VoiceCommandEvent,
  T3VoiceReadinessDisabledEvent,
  T3VoiceRuntimeErrorEvent,
  T3VoiceRuntimePhase,
  T3VoiceRuntimeState,
  T3VoiceRuntimeReadDelivery,
  T3VoiceRuntimeWakeEvent,
} from "./T3Voice.types";

const NATIVE_MODULE_NAME = "T3Voice";
const NATIVE_REVISION = 15;

let resolvedModule: T3VoiceNativeModule | null | undefined;

export function getT3VoiceNativeModule(): T3VoiceNativeModule | null {
  if (resolvedModule !== undefined) {
    return resolvedModule;
  }

  try {
    resolvedModule = requireOptionalNativeModule<T3VoiceNativeModule>(NATIVE_MODULE_NAME);
    if (resolvedModule?.nativeRevision !== NATIVE_REVISION) resolvedModule = null;
  } catch {
    resolvedModule = null;
  }
  return resolvedModule;
}

export function isT3VoiceNativeModuleAvailable(): boolean {
  return getT3VoiceNativeModule() !== null;
}

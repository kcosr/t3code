import type { PermissionResponse } from "expo";

export interface T3VoiceEventSubscription {
  readonly remove: () => void;
}

export type T3VoiceRuntimePhase = "inactive" | "idle" | "recording" | "playing" | "realtime";

export type T3VoiceRealtimeConnectionState =
  | "preparing"
  | "offer-ready"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface T3VoiceRuntimeState {
  readonly phase: T3VoiceRuntimePhase;
  readonly isForeground: boolean;
  readonly activeRecordingId: string | null;
  readonly activePlaybackId: string | null;
  readonly activeRealtimeSessionId: string | null;
  readonly realtimeConnectionState: T3VoiceRealtimeConnectionState | null;
  readonly realtimeMuted: boolean;
  readonly sequence: number;
}

export interface T3VoiceMediaCapabilities {
  readonly microphone: boolean;
  readonly boundedRecording: boolean;
  readonly automaticEndpointDetection: boolean;
  readonly orderedPcmPlayback: boolean;
  readonly realtimeWebRtc: boolean;
  readonly bluetoothRouting: boolean;
}

export interface T3VoiceRecordingIdentifier {
  readonly recordingId: string;
}

export interface T3VoiceRecordingInput extends T3VoiceRecordingIdentifier {
  readonly endpointDetection: {
    readonly endSilenceMs: number;
    readonly noSpeechTimeoutMs?: number;
  };
}

export interface T3VoiceRecordingResult {
  readonly recordingId: string;
  readonly uri: string;
  readonly mimeType: "audio/mp4";
  readonly durationMs: number;
  readonly byteLength: number;
}

export interface T3VoiceRecordingDeleteInput {
  readonly recordingId: string;
  readonly uri: string;
}

export interface T3VoicePlaybackInput {
  readonly playbackId: string;
  readonly sampleRate: number;
  readonly channelCount: 1 | 2;
}

export interface T3VoicePlaybackChunkInput {
  readonly playbackId: string;
  readonly chunkIndex: number;
  readonly pcmBase64: string;
}

export interface T3VoicePlaybackFinishInput {
  readonly playbackId: string;
  readonly finalChunkIndex: number;
}

export interface T3VoicePlaybackChunkConsumedEvent {
  readonly playbackId: string;
  readonly chunkIndex: number;
}

export type T3VoiceRecordingTerminatedEvent =
  | {
      readonly recordingId: string;
      readonly recording: T3VoiceRecordingResult;
      readonly outcome: "completed";
      readonly reason:
        | "speech-ended"
        | "maximum-utterance"
        | "media-duration-limit"
        | "media-file-size-limit";
    }
  | {
      readonly recordingId: string;
      readonly recording: null;
      readonly outcome: "cancelled";
      readonly reason: "no-speech";
    }
  | {
      readonly recordingId: string;
      readonly recording: null;
      readonly outcome: "failed";
      readonly reason: "finalization-failed";
    };

export interface T3VoiceRuntimeErrorEvent {
  readonly operation: string;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface T3VoiceAudioRouteChangedEvent {
  readonly nativeSessionId: string;
  readonly routeId: T3VoiceAudioRoute["id"];
  readonly routeType: T3VoiceAudioRoute["type"];
  readonly reason: "selected" | "selected-route-unavailable";
}

export interface T3VoiceRealtimeTerminatedEvent {
  readonly nativeSessionId: string;
  readonly outcome: "ended" | "failed";
  readonly code: string;
  readonly retryable: boolean;
}

export interface T3VoiceRealtimePrepareInput {
  readonly nativeSessionId: string;
}

export interface T3VoiceRealtimeOffer {
  readonly nativeSessionId: string;
  readonly sdp: string;
}

export interface T3VoiceRealtimeAnswerInput extends T3VoiceRealtimePrepareInput {
  readonly sdp: string;
}

export interface T3VoiceAudioRoute {
  readonly id: "system" | "speaker" | "earpiece" | "wired" | "bluetooth";
  readonly label: string;
  readonly type: "system" | "speaker" | "earpiece" | "wired" | "bluetooth";
  readonly selected: boolean;
}

export type T3VoiceDiagnosticCategory = "lifecycle" | "state" | "route" | "focus" | "terminal";

export type T3VoiceDiagnosticCode =
  | "started"
  | "stopped"
  | "active"
  | "idle"
  | "request-granted"
  | "request-denied"
  | "gained"
  | "lost-transiently"
  | "duck-requested"
  | "lost-permanently"
  | "route-selected"
  | "route-fallback"
  | "route-scan-unavailable"
  | "device-callback-registered"
  | "device-callback-unavailable"
  | "device-callback-unregistered"
  | "ended"
  | "failed";

export interface T3VoiceDiagnosticEntry {
  readonly elapsedRealtimeMillis: number;
  readonly generation: number;
  readonly category: T3VoiceDiagnosticCategory;
  readonly code: T3VoiceDiagnosticCode;
  readonly primaryCount: number;
  readonly secondaryCount: number;
}

export interface T3VoiceNativeModule {
  readonly nativeRevision: number;
  readonly addListener: {
    (
      eventName: "stateChanged",
      listener: (state: T3VoiceRuntimeState) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "playbackChunkConsumed",
      listener: (event: T3VoicePlaybackChunkConsumedEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "recordingTerminated",
      listener: (event: T3VoiceRecordingTerminatedEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "runtimeError",
      listener: (event: T3VoiceRuntimeErrorEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "audioRouteChanged",
      listener: (event: T3VoiceAudioRouteChangedEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "realtimeTerminated",
      listener: (event: T3VoiceRealtimeTerminatedEvent) => void,
    ): T3VoiceEventSubscription;
  };
  readonly getMediaCapabilitiesAsync: () => Promise<T3VoiceMediaCapabilities>;
  readonly getStateAsync: () => Promise<T3VoiceRuntimeState>;
  readonly getMicrophonePermissionAsync: () => Promise<PermissionResponse>;
  readonly requestMicrophonePermissionAsync: () => Promise<PermissionResponse>;
  readonly getBluetoothPermissionAsync: () => Promise<PermissionResponse>;
  readonly requestBluetoothPermissionAsync: () => Promise<PermissionResponse>;
  readonly startRecordingAsync: (input: T3VoiceRecordingInput) => Promise<void>;
  readonly stopRecordingAsync: (
    input: T3VoiceRecordingIdentifier,
  ) => Promise<T3VoiceRecordingResult>;
  readonly cancelRecordingAsync: (input: T3VoiceRecordingIdentifier) => Promise<void>;
  readonly deleteRecordingAsync: (input: T3VoiceRecordingDeleteInput) => Promise<void>;
  readonly acknowledgeRecordingTerminationAsync: (
    input: T3VoiceRecordingIdentifier,
  ) => Promise<void>;
  readonly startPlaybackAsync: (input: T3VoicePlaybackInput) => Promise<void>;
  readonly enqueuePlaybackChunkAsync: (input: T3VoicePlaybackChunkInput) => Promise<void>;
  readonly finishPlaybackAsync: (input: T3VoicePlaybackFinishInput) => Promise<void>;
  readonly cancelPlaybackAsync: (input: { readonly playbackId: string }) => Promise<void>;
  readonly prepareRealtimeSessionAsync: (
    input: T3VoiceRealtimePrepareInput,
  ) => Promise<T3VoiceRealtimeOffer>;
  readonly applyRealtimeAnswerAsync: (input: T3VoiceRealtimeAnswerInput) => Promise<void>;
  readonly stopRealtimeSessionAsync: (input: T3VoiceRealtimePrepareInput) => Promise<boolean>;
  readonly setRealtimeMutedAsync: (
    input: T3VoiceRealtimePrepareInput & { readonly muted: boolean },
  ) => Promise<void>;
  readonly getAudioRoutesAsync: () => Promise<ReadonlyArray<T3VoiceAudioRoute>>;
  readonly getDiagnosticsAsync: () => Promise<ReadonlyArray<T3VoiceDiagnosticEntry>>;
  readonly setAudioRouteAsync: (
    input: T3VoiceRealtimePrepareInput & {
      readonly routeId: T3VoiceAudioRoute["id"];
    },
  ) => Promise<ReadonlyArray<T3VoiceAudioRoute>>;
}

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
    readonly maximumUtteranceMs: number;
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

export interface T3VoicePlaybackTerminatedEvent {
  readonly playbackId: string;
  readonly outcome: "completed" | "failed" | "cancelled";
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

export interface T3VoiceThreadVoiceHandoffEvent {
  readonly actionId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly recordingId: string;
  readonly autoRearm: boolean;
  readonly environmentOrigin: string;
  readonly expiresAtEpochMillis: number;
}

export type T3VoiceReadinessMode = "realtime" | "thread";

export interface T3VoiceReadinessSnapshot {
  readonly enabled: boolean;
  readonly mode: T3VoiceReadinessMode;
  readonly targetId: string | null;
  readonly audioRouteId: string;
  readonly autoRearm: boolean;
  readonly microphonePermissionGranted: boolean;
  readonly notificationPermissionGranted: boolean;
}

export interface T3VoicePersistedReadinessSnapshot extends T3VoiceReadinessSnapshot {
  readonly generation: number;
}

export type T3VoiceBackgroundGrantOperation = "realtime-start" | "thread-turn-start";

/** Sensitive provisioning input. Native code hashes targetIdentity before persisting metadata. */
export interface T3VoiceBackgroundRuntimeGrantInput {
  readonly runtimeId: string;
  readonly readinessGeneration: number;
  readonly environmentOrigin: string;
  readonly operation: T3VoiceBackgroundGrantOperation;
  readonly targetIdentity: string;
  readonly expiresAtEpochMillis: number;
  readonly token: string;
}

export interface T3VoiceBackgroundReadinessPrepareInput {
  readonly readiness: T3VoiceReadinessSnapshot;
  readonly runtimeId: string;
}

export interface T3VoiceBackgroundPreparedReadiness {
  readonly runtimeId: string;
  readonly readiness: T3VoicePersistedReadinessSnapshot;
}

export interface T3VoiceBackgroundReadinessActivateInput {
  readonly readiness: T3VoiceReadinessSnapshot;
  readonly expectedGeneration: number;
  readonly grant: T3VoiceBackgroundRuntimeGrantInput;
}

export type T3VoiceBackgroundExecutionPhase =
  | "disabled"
  | "ready"
  | "starting"
  | "active"
  | "retrying"
  | "attention-required";

/** Curated state suitable for React events and diagnostics; never contains credentials or media. */
export interface T3VoiceBackgroundExecutionSnapshot {
  readonly readinessGeneration: number;
  readonly mode: T3VoiceReadinessMode;
  readonly phase: T3VoiceBackgroundExecutionPhase;
  readonly activeSessionId: string | null;
  readonly retryable: boolean;
}

export interface T3VoiceBackgroundRealtimeStartInput {
  readonly runtimeId: string;
  readonly generation: number;
  readonly clientOperationId: string;
}

/** Internal signaling DTO. SDP must not be copied into background state, events, or diagnostics. */
export interface T3VoiceBackgroundRealtimeOfferInput {
  readonly sessionId: string;
  readonly leaseGeneration: number;
  readonly sdp: string;
}

export interface T3VoiceBackgroundRealtimeAnswer {
  readonly sessionId: string;
  readonly leaseGeneration: number;
  readonly sdp: string;
}

export interface T3VoiceBackgroundRealtimeCloseInput {
  readonly leaseGeneration: number;
}

export interface T3VoiceControllerRegistration {
  readonly controllerGeneration: number;
}

export interface T3VoiceCommandEvent {
  readonly commandId: string;
  readonly command: "primary";
  readonly controllerGeneration: number;
  readonly readinessGeneration: number;
}

export interface T3VoiceReadinessDisabledEvent {
  readonly readinessGeneration: number;
  readonly reason: "notification";
}

export interface T3VoiceRealtimeIdentifier {
  readonly nativeSessionId: string;
}

export interface T3VoiceRealtimePrepareInput extends T3VoiceRealtimeIdentifier {
  readonly environmentOrigin: string;
  readonly nativeControlGrant: {
    readonly token: string;
    readonly sessionId: string;
    readonly leaseGeneration: number;
    readonly expiresAt: string;
    readonly heartbeatIntervalSeconds: number;
    readonly failureGraceSeconds: number;
  };
}

export interface T3VoiceRealtimeOffer {
  readonly nativeSessionId: string;
  readonly sdp: string;
}

export interface T3VoiceRealtimeAnswerInput extends T3VoiceRealtimeIdentifier {
  readonly sdp: string;
}

export interface T3VoiceAudioRoute {
  readonly id: "system" | "speaker" | "earpiece" | "wired" | "bluetooth";
  readonly label: string;
  readonly type: "system" | "speaker" | "earpiece" | "wired" | "bluetooth";
  readonly selected: boolean;
}

export type T3VoiceDiagnosticCategory =
  | "lifecycle"
  | "state"
  | "route"
  | "focus"
  | "terminal"
  | "endpoint";

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
  | "failed"
  | "endpoint-sample"
  | "endpoint-terminated";

export interface T3VoiceDiagnosticEntry {
  readonly elapsedRealtimeMillis: number;
  readonly generation: number;
  readonly category: T3VoiceDiagnosticCategory;
  readonly code: T3VoiceDiagnosticCode;
  readonly primaryCount: number;
  readonly secondaryCount: number;
  readonly endpointElapsedMs?: number;
  readonly levelDbfsBucket?: number;
  readonly noiseFloorDbfsBucket?: number;
  readonly releaseThresholdDbfsBucket?: number;
  readonly speechConfirmed?: boolean;
  readonly silenceElapsedMs?: number;
  readonly silenceResetCount?: number;
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
      eventName: "playbackTerminated",
      listener: (event: T3VoicePlaybackTerminatedEvent) => void,
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
    (
      eventName: "threadVoiceHandoff",
      listener: (event: T3VoiceThreadVoiceHandoffEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "voiceCommand",
      listener: (event: T3VoiceCommandEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "readinessDisabled",
      listener: (event: T3VoiceReadinessDisabledEvent) => void,
    ): T3VoiceEventSubscription;
  };
  readonly getMediaCapabilitiesAsync: () => Promise<T3VoiceMediaCapabilities>;
  readonly getStateAsync: () => Promise<T3VoiceRuntimeState>;
  readonly provisionBackgroundRuntimeGrantAsync: (
    input: T3VoiceBackgroundRuntimeGrantInput,
  ) => Promise<void>;
  readonly clearBackgroundRuntimeGrantAsync: () => Promise<void>;
  readonly prepareBackgroundVoiceReadinessAsync: (
    input: T3VoiceBackgroundReadinessPrepareInput,
  ) => Promise<T3VoiceBackgroundPreparedReadiness>;
  readonly activateBackgroundVoiceReadinessAsync: (
    input: T3VoiceBackgroundReadinessActivateInput,
  ) => Promise<T3VoicePersistedReadinessSnapshot>;
  readonly getMicrophonePermissionAsync: () => Promise<PermissionResponse>;
  readonly requestMicrophonePermissionAsync: () => Promise<PermissionResponse>;
  readonly getNotificationPermissionAsync: () => Promise<PermissionResponse>;
  readonly requestNotificationPermissionAsync: () => Promise<PermissionResponse>;
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
  readonly getPendingRecordingTerminationAsync: () => Promise<T3VoiceRecordingTerminatedEvent | null>;
  readonly getPendingThreadVoiceHandoffAsync: () => Promise<T3VoiceThreadVoiceHandoffEvent | null>;
  readonly acknowledgeThreadVoiceHandoffAsync: (input: {
    readonly actionId: string;
  }) => Promise<void>;
  readonly armThreadVoiceHandoffAsync: (input: T3VoiceRealtimeIdentifier) => Promise<void>;
  readonly setReadinessSnapshotAsync: (
    input: T3VoiceReadinessSnapshot,
  ) => Promise<T3VoicePersistedReadinessSnapshot>;
  readonly registerVoiceControllerAsync: (input: T3VoiceControllerRegistration) => Promise<void>;
  readonly unregisterVoiceControllerAsync: (input: T3VoiceControllerRegistration) => Promise<void>;
  readonly getPendingVoiceCommandAsync: () => Promise<T3VoiceCommandEvent | null>;
  readonly getPendingReadinessDisabledAsync: () => Promise<T3VoiceReadinessDisabledEvent | null>;
  readonly acknowledgeReadinessDisabledAsync: (input: {
    readonly readinessGeneration: number;
  }) => Promise<void>;
  readonly completeVoiceCommandAsync: (input: {
    readonly commandId: string;
    readonly controllerGeneration: number;
    readonly outcome: "success" | "failure";
  }) => Promise<void>;
  readonly startPlaybackAsync: (input: T3VoicePlaybackInput) => Promise<void>;
  readonly enqueuePlaybackChunkAsync: (input: T3VoicePlaybackChunkInput) => Promise<void>;
  readonly finishPlaybackAsync: (input: T3VoicePlaybackFinishInput) => Promise<void>;
  readonly cancelPlaybackAsync: (input: { readonly playbackId: string }) => Promise<void>;
  readonly acknowledgePlaybackTerminationAsync: (input: {
    readonly playbackId: string;
  }) => Promise<void>;
  readonly getPendingPlaybackTerminationAsync: () => Promise<T3VoicePlaybackTerminatedEvent | null>;
  readonly prepareRealtimeSessionAsync: (
    input: T3VoiceRealtimePrepareInput,
  ) => Promise<T3VoiceRealtimeOffer>;
  readonly applyRealtimeAnswerAsync: (input: T3VoiceRealtimeAnswerInput) => Promise<void>;
  readonly stopRealtimeSessionAsync: (input: T3VoiceRealtimeIdentifier) => Promise<boolean>;
  readonly setRealtimeMutedAsync: (
    input: T3VoiceRealtimeIdentifier & { readonly muted: boolean },
  ) => Promise<void>;
  readonly getAudioRoutesAsync: () => Promise<ReadonlyArray<T3VoiceAudioRoute>>;
  readonly getDiagnosticsAsync: () => Promise<ReadonlyArray<T3VoiceDiagnosticEntry>>;
  readonly setAudioRouteAsync: (
    input: T3VoiceRealtimeIdentifier & {
      readonly routeId: T3VoiceAudioRoute["id"];
    },
  ) => Promise<ReadonlyArray<T3VoiceAudioRoute>>;
}

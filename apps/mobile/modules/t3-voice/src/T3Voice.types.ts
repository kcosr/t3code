import type { PermissionResponse } from "expo";
import type {
  VoiceCommandReceipt,
  VoiceDraftArtifact,
  VoiceDraftArtifactAcknowledgement,
  VoiceDraftArtifactRead,
  VoiceRuntimeAttachRequest,
  VoiceRuntimeAttachmentUpdate,
  VoiceRuntimeAuthorityReservation,
  VoiceRuntimeAuthorityClearCommand,
  VoiceRuntimeConsumerLease,
  VoiceRuntimeCursor,
  VoiceRuntimeDescriptor,
  VoiceRuntimeEvent,
  VoiceRuntimeRebase,
  VoiceRuntimeSnapshot,
  VoiceRuntimeCommand,
  VoiceRuntimePresentationAction,
  VoiceRuntimePresentationActionAcknowledgement,
  VoiceRuntimePresentationActionClaim,
  VoiceRuntimeRetainedRecordAcknowledgement,
  VoiceRuntimeTarget,
} from "@t3tools/contracts";

export type T3VoiceRuntimeReadDelivery =
  | { readonly type: "events"; readonly events: ReadonlyArray<VoiceRuntimeEvent> }
  | VoiceRuntimeRebase;

export interface T3VoiceRuntimeWakeEvent {
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly generation: number;
  readonly sequence: number;
}

export interface T3VoiceEventSubscription {
  readonly remove: () => void;
}

export type T3VoiceRuntimePhase =
  | "inactive"
  | "idle"
  | "arming"
  | "recording"
  | "playing"
  | "realtime";

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
  readonly realtimeInputReady: boolean;
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
  readonly ownerDomain: "MANUAL_PLAYBACK";
  readonly operationId: string;
  readonly playbackId: string;
  readonly outcome: "completed" | "failed" | "cancelled";
}

export type T3VoiceRecordingTerminatedEvent =
  | {
      readonly ownerDomain: "COMPOSER_DICTATION";
      readonly operationId: string;
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
      readonly ownerDomain: "COMPOSER_DICTATION";
      readonly operationId: string;
      readonly recordingId: string;
      readonly recording: null;
      readonly outcome: "cancelled";
      readonly reason: "no-speech";
    }
  | {
      readonly ownerDomain: "COMPOSER_DICTATION";
      readonly operationId: string;
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

export interface T3VoiceCompletionWakeEvent {
  readonly ownerDomain: "COMPOSER_DICTATION" | "MANUAL_PLAYBACK";
  readonly operationId: string;
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

export interface T3VoiceRuntimeAuthorityActive {
  readonly state: "active";
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly expectedCurrentGeneration: number;
  readonly generation: number;
  readonly target: VoiceRuntimeTarget;
  readonly environmentOrigin: string;
  readonly readinessEnabled: boolean;
  readonly readiness: T3VoicePersistedReadinessSnapshot;
}

export type T3VoiceRuntimeAuthoritySnapshot = T3VoiceRuntimeAuthorityActive;

export interface T3VoiceRuntimeAuthorityClearIfIdleInput {
  readonly runtimeId: string | null;
  readonly generation: number | null;
}

export interface T3VoiceRuntimeOwnership {
  readonly sequence: number;
  readonly active: boolean;
  readonly phase: T3VoiceRuntimePhase;
  readonly runtimeId: string | null;
  readonly generation: number;
  readonly environmentOrigin: string;
  readonly mode: T3VoiceReadinessMode;
  readonly targetId: string | null;
  readonly nativeSessionId: string | null;
}

export interface T3VoiceRuntimeAuthorityRevocation {
  readonly runtimeId: string;
  readonly environmentOrigin: string;
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
  readonly audioRouteId: string;
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
  | "prepare-started"
  | "peer-resources-ready"
  | "audio-focus-granted"
  | "local-offer-ready"
  | "answer-applied"
  | "peer-connected"
  | "stop-started"
  | "media-released"
  | "foreground-released"
  | "authority-validated"
  | "server-session-started"
  | "signaling-completed"
  | "close-requested"
  | "cleanup-reconciliation-required"
  | "thread-reconciliation-required"
  | "endpoint-sample"
  | "endpoint-terminated"
  | "cue-ready-started"
  | "cue-ended-started"
  | "cue-drained"
  | "cue-cancelled"
  | "cue-failed"
  | "cue-timed-out"
  | "handoff-drain-started"
  | "handoff-drained"
  | "handoff-drain-timed-out"
  | "handoff-drain-interrupted"
  | "handoff-published"
  | "handoff-client-accepted"
  | "handoff-navigation-requested"
  | "handoff-composer-adopted";

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
      listener: (event: T3VoiceCompletionWakeEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "recordingTerminated",
      listener: (event: T3VoiceCompletionWakeEvent) => void,
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
      eventName: "voiceCommand",
      listener: (event: T3VoiceCommandEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "readinessDisabled",
      listener: (event: T3VoiceReadinessDisabledEvent) => void,
    ): T3VoiceEventSubscription;
    (
      eventName: "voiceRuntimeWake",
      listener: (event: T3VoiceRuntimeWakeEvent) => void,
    ): T3VoiceEventSubscription;
  };
  readonly getMediaCapabilitiesAsync: () => Promise<T3VoiceMediaCapabilities>;
  readonly getStateAsync: () => Promise<T3VoiceRuntimeState>;
  readonly describeVoiceRuntimeAsync: () => Promise<VoiceRuntimeDescriptor>;
  readonly getVoiceRuntimeSnapshotAsync: () => Promise<VoiceRuntimeSnapshot>;
  readonly configureVoiceRuntimeAuthorityAsync: (
    input: VoiceRuntimeAuthorityReservation,
  ) => Promise<VoiceRuntimeSnapshot>;
  readonly clearVoiceRuntimeAuthorityAsync: (
    input: VoiceRuntimeAuthorityClearCommand,
  ) => Promise<VoiceRuntimeSnapshot>;
  readonly attachVoiceRuntimeAsync: (
    input: VoiceRuntimeAttachRequest,
  ) => Promise<VoiceRuntimeConsumerLease>;
  readonly updateVoiceRuntimeAttachmentAsync: (
    input: VoiceRuntimeAttachmentUpdate,
  ) => Promise<VoiceRuntimeConsumerLease>;
  readonly detachVoiceRuntimeAsync: (input: VoiceRuntimeConsumerLease) => Promise<void>;
  readonly readVoiceRuntimeAsync: (input: {
    readonly lease: VoiceRuntimeConsumerLease;
    readonly after: VoiceRuntimeCursor | null;
  }) => Promise<T3VoiceRuntimeReadDelivery>;
  readonly acknowledgeVoiceRuntimeAsync: (input: {
    readonly lease: VoiceRuntimeConsumerLease;
    readonly through: VoiceRuntimeCursor;
  }) => Promise<void>;
  readonly acknowledgeVoiceRuntimeRetainedRecordAsync: (
    input: VoiceRuntimeRetainedRecordAcknowledgement,
  ) => Promise<void>;
  readonly dispatchVoiceRuntimeAsync: (input: VoiceRuntimeCommand) => Promise<VoiceCommandReceipt>;
  readonly readVoiceRuntimeDraftArtifactAsync: (
    input: VoiceDraftArtifactRead,
  ) => Promise<VoiceDraftArtifact>;
  readonly acknowledgeVoiceRuntimeDraftArtifactAsync: (
    input: VoiceDraftArtifactAcknowledgement,
  ) => Promise<void>;
  readonly claimVoiceRuntimePresentationActionAsync: (
    input: VoiceRuntimePresentationActionClaim,
  ) => Promise<VoiceRuntimePresentationAction>;
  readonly acknowledgeVoiceRuntimePresentationActionAsync: (
    input: VoiceRuntimePresentationActionAcknowledgement,
  ) => Promise<void>;
  readonly inspectVoiceRuntimeAuthorityAsync: () => Promise<T3VoiceRuntimeAuthoritySnapshot | null>;
  readonly setVoiceRuntimeSessionCredentialAsync: (input: {
    readonly environmentOrigin: string;
    readonly credential: string;
  }) => Promise<void>;
  readonly disableVoiceRuntimeReadinessAsync: () => Promise<VoiceRuntimeSnapshot>;
  readonly clearVoiceRuntimeAuthorityIfIdleAsync: (
    input: T3VoiceRuntimeAuthorityClearIfIdleInput,
  ) => Promise<VoiceRuntimeSnapshot | null>;
  readonly getVoiceRuntimeOwnershipAsync: () => Promise<T3VoiceRuntimeOwnership | null>;
  readonly getPendingVoiceRuntimeAuthorityRevocationAsync: () => Promise<T3VoiceRuntimeAuthorityRevocation | null>;
  readonly acknowledgeVoiceRuntimeAuthorityRevocationAsync: (
    input: T3VoiceRuntimeAuthorityRevocation,
  ) => Promise<void>;
  readonly getMicrophonePermissionAsync: () => Promise<PermissionResponse>;
  readonly requestMicrophonePermissionAsync: () => Promise<PermissionResponse>;
  readonly getNotificationPermissionAsync: () => Promise<PermissionResponse>;
  readonly requestNotificationPermissionAsync: () => Promise<PermissionResponse>;
  readonly startRecordingAsync: (input: T3VoiceRecordingInput) => Promise<void>;
  readonly stopRecordingAsync: (
    input: T3VoiceRecordingIdentifier,
  ) => Promise<T3VoiceRecordingResult>;
  readonly cancelRecordingAsync: (input: T3VoiceRecordingIdentifier) => Promise<void>;
  readonly deleteRecordingAsync: (input: T3VoiceRecordingDeleteInput) => Promise<void>;
  readonly acknowledgeRecordingTerminationAsync: (input: {
    readonly operationId: string;
  }) => Promise<void>;
  readonly discardUnownedRecordingTerminationAsync: (input: {
    readonly operationId: string;
  }) => Promise<boolean>;
  readonly getPendingRecordingTerminationAsync: () => Promise<
    ReadonlyArray<T3VoiceRecordingTerminatedEvent>
  >;
  readonly setVoiceCuesEnabledAsync: (input: { readonly enabled: boolean }) => Promise<void>;
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
    readonly operationId: string;
  }) => Promise<void>;
  readonly getPendingPlaybackTerminationAsync: () => Promise<
    ReadonlyArray<T3VoicePlaybackTerminatedEvent>
  >;
  readonly prepareRealtimeSessionAsync: (
    input: T3VoiceRealtimePrepareInput,
  ) => Promise<T3VoiceRealtimeOffer>;
  readonly applyRealtimeAnswerAsync: (input: T3VoiceRealtimeAnswerInput) => Promise<void>;
  readonly stopRealtimeSessionAsync: (input: T3VoiceRealtimeIdentifier) => Promise<boolean>;
  readonly drainAndStopRealtimeSessionAsync: (input: T3VoiceRealtimeIdentifier) => Promise<void>;
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

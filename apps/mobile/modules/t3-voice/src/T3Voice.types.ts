import type { PermissionResponse } from "expo";
import type {
  VoiceRealtimeContext,
  VoiceRealtimeTarget,
  VoiceRuntimeSnapshot,
  VoiceThreadStartInput,
} from "@t3tools/client-runtime/voice";
import type {
  VoiceClientActionId,
  VoiceClientActionOutcome,
  VoiceConfirmationDecision,
  VoiceConfirmationId,
  VoiceNativeSessionCredential,
} from "@t3tools/contracts";

export interface T3VoiceEventSubscription {
  readonly remove: () => void;
}

export interface T3VoiceNativeSessionConfiguration extends VoiceNativeSessionCredential {
  readonly baseUrl: string;
}

export interface T3VoiceRealtimeAdmissionInput {
  readonly target: VoiceRealtimeTarget;
  readonly session: T3VoiceNativeSessionConfiguration;
}

export interface T3VoiceStartThreadInput {
  readonly input: VoiceThreadStartInput;
  readonly session: T3VoiceNativeSessionConfiguration;
}

export interface T3VoiceSetRealtimeMutedInput {
  readonly muted: boolean;
}

export interface T3VoiceSetRealtimeAudioRouteInput {
  readonly routeId: string;
}

export interface T3VoiceDecideRealtimeConfirmationInput {
  readonly confirmationId: VoiceConfirmationId;
  readonly decision: VoiceConfirmationDecision;
}

export interface T3VoiceCompleteRealtimeClientActionInput {
  readonly actionId: VoiceClientActionId;
  readonly outcome: VoiceClientActionOutcome;
  readonly message?: string;
}

export interface T3VoiceSubmitThreadTranscriptInput {
  readonly expectedGeneration: number;
  readonly expectedReviewId: number;
  readonly transcript: string;
}

export interface T3VoiceUpdateThreadReviewTranscriptInput {
  readonly expectedGeneration: number;
  readonly expectedReviewId: number;
  readonly transcript: string;
}

export type T3VoiceRuntimePhase = "inactive" | "idle" | "recording" | "playing";

export interface T3VoiceRuntimeState {
  readonly phase: T3VoiceRuntimePhase;
  readonly isForeground: boolean;
  readonly activeRecordingId: string | null;
  readonly activePlaybackId: string | null;
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
      eventName: "runtimeSnapshotChanged",
      listener: (snapshot: VoiceRuntimeSnapshot) => void,
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
  };
  readonly getRuntimeSnapshotAsync: () => Promise<VoiceRuntimeSnapshot>;
  readonly startRealtimeAsync: (input: T3VoiceRealtimeAdmissionInput) => Promise<void>;
  readonly startThreadAsync: (input: T3VoiceStartThreadInput) => Promise<void>;
  readonly switchRealtimeToThreadAsync: (input: VoiceThreadStartInput) => Promise<void>;
  readonly switchThreadToRealtimeAsync: (input: T3VoiceRealtimeAdmissionInput) => Promise<void>;
  readonly stopRuntimeAsync: () => Promise<void>;
  readonly setRealtimeMutedAsync: (input: T3VoiceSetRealtimeMutedInput) => Promise<void>;
  readonly setRealtimeAudioRouteAsync: (input: T3VoiceSetRealtimeAudioRouteInput) => Promise<void>;
  readonly updateRealtimeContextAsync: (context: VoiceRealtimeContext) => Promise<void>;
  readonly decideRealtimeConfirmationAsync: (
    input: T3VoiceDecideRealtimeConfirmationInput,
  ) => Promise<void>;
  readonly completeRealtimeClientActionAsync: (
    input: T3VoiceCompleteRealtimeClientActionInput,
  ) => Promise<void>;
  readonly finishThreadRecordingAsync: () => Promise<void>;
  readonly updateThreadReviewTranscriptAsync: (
    input: T3VoiceUpdateThreadReviewTranscriptInput,
  ) => Promise<void>;
  readonly submitThreadTranscriptAsync: (
    input: T3VoiceSubmitThreadTranscriptInput,
  ) => Promise<void>;
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
  readonly acknowledgePlaybackTerminationAsync: (input: {
    readonly playbackId: string;
  }) => Promise<void>;
  readonly getPendingPlaybackTerminationAsync: () => Promise<T3VoicePlaybackTerminatedEvent | null>;
  readonly getDiagnosticsAsync: () => Promise<ReadonlyArray<T3VoiceDiagnosticEntry>>;
}

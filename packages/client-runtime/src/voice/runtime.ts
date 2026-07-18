import type {
  EnvironmentId,
  IsoDateTime,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  VoiceConfirmationDecision,
  VoiceConfirmationId,
  VoiceClientActionId,
  VoiceClientActionOutcome,
  VoiceConversationSelection,
  VoiceToolName,
} from "@t3tools/contracts";

export interface VoiceRealtimeFocus {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

export interface VoiceRealtimeContext {
  readonly focus: VoiceRealtimeFocus | null;
  /** Native-owned settings used when an agent targets a Thread by ID. */
  readonly threadSettings: VoiceThreadSettings | null;
}

export interface VoiceRealtimeTarget extends VoiceRealtimeContext {
  readonly environmentId: EnvironmentId;
  readonly conversation: VoiceConversationSelection;
}

export interface VoiceThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface VoiceThreadEndpointDetection {
  readonly endSilenceMs: number;
  readonly noSpeechTimeoutMs: number | null;
  readonly maximumUtteranceMs: number;
}

export interface VoiceThreadSettings {
  readonly submission: "auto-submit" | "review";
  readonly playResponses: boolean;
  readonly autoRearm: boolean;
  readonly endpointDetection: VoiceThreadEndpointDetection;
  readonly rearmDelayMs: number;
  readonly transcriptionTimeoutMs: number;
  readonly submissionTimeoutMs: number;
  readonly responseTimeoutMs: number;
}

export interface VoiceThreadStartInput {
  readonly target: VoiceThreadTarget;
  readonly settings: VoiceThreadSettings;
}

export interface VoiceThreadReviewToken {
  readonly generation: number;
  readonly reviewId: number;
}

export type VoiceAudioRouteKind = "system" | "speaker" | "earpiece" | "bluetooth" | "wired";

export interface VoiceAudioRoute {
  readonly kind: VoiceAudioRouteKind;
  readonly label: string;
}

export interface VoiceRealtimeTranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface VoiceRealtimeConfirmation {
  readonly confirmationId: VoiceConfirmationId;
  readonly tool: VoiceToolName;
  readonly summary: string;
  readonly expiresAt: IsoDateTime;
}

export interface VoiceRealtimeClientAction {
  readonly action: "activate-thread";
  readonly actionId: VoiceClientActionId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly expiresAt: IsoDateTime;
}

export type VoiceRealtimePhase = "starting" | "connected" | "stopping";

export type VoiceSwitchToThreadPhase = "closing-realtime" | "starting-recorder";

export type VoiceThreadPhase =
  | "starting"
  | "recording"
  | "finalizing"
  | "transcribing"
  | "reviewing"
  | "submitting"
  | "waiting"
  | "playing"
  | "rearming"
  | "stopping";

export interface VoiceRuntimeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface VoiceRuntimeSnapshotIdentity {
  /** Process-local generation used to reject callbacks from an older operation. */
  readonly generation: number;
  /** Monotonic process-local publication sequence used to reconcile attachment races. */
  readonly sequence: number;
}

export type VoiceRuntimeSnapshot = VoiceRuntimeSnapshotIdentity &
  (
    | {
        readonly mode: "idle";
      }
    | {
        readonly mode: "realtime";
        readonly phase: VoiceRealtimePhase;
        readonly target: VoiceRealtimeTarget;
        readonly muted: boolean;
        readonly transcript: ReadonlyArray<VoiceRealtimeTranscriptTurn>;
        readonly pendingConfirmations: ReadonlyArray<VoiceRealtimeConfirmation>;
        readonly pendingClientActions: ReadonlyArray<VoiceRealtimeClientAction>;
      }
    | {
        readonly mode: "switching-to-thread";
        readonly phase: VoiceSwitchToThreadPhase;
        readonly target: VoiceThreadTarget;
        readonly settings: VoiceThreadSettings;
      }
    | {
        readonly mode: "switching-to-realtime";
        readonly source: VoiceThreadTarget;
        readonly target: VoiceRealtimeTarget;
      }
    | {
        readonly mode: "thread";
        readonly phase: VoiceThreadPhase;
        readonly target: VoiceThreadTarget;
        readonly settings: VoiceThreadSettings;
        readonly transcript: string | null;
        readonly reviewId: number | null;
        readonly attention: "approval-required" | "user-input-required" | null;
      }
    | {
        readonly mode: "failed";
        readonly environmentId: EnvironmentId;
        readonly operation: "realtime" | "thread" | "switching-to-thread" | "switching-to-realtime";
        readonly failure: VoiceRuntimeFailure;
      }
  );

export type VoiceRuntimeSnapshotListener = (snapshot: VoiceRuntimeSnapshot) => void;

export interface VoiceRuntimeAdmissionOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * Platform-neutral ownership boundary for one live voice operation.
 *
 * Implementations serialize all commands, make duplicate commands no-ops while
 * the matching transition is already active, and do not restore live work
 * after their process terminates.
 */
export interface VoiceRuntimeAdapter {
  readonly getSnapshot: () => Promise<VoiceRuntimeSnapshot>;

  /**
   * Atomically attaches a listener and delivers the complete current snapshot
   * before any subsequent snapshot. Resolving returns the detach function.
   */
  readonly subscribe: (listener: VoiceRuntimeSnapshotListener) => Promise<() => void>;

  readonly startRealtime: (
    target: VoiceRealtimeTarget,
    options?: VoiceRuntimeAdmissionOptions,
  ) => Promise<void>;
  readonly startThread: (input: VoiceThreadStartInput) => Promise<void>;
  readonly switchRealtimeToThread: (input: VoiceThreadStartInput) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly setRealtimeMuted: (muted: boolean) => Promise<void>;
  readonly updateRealtimeContext: (context: VoiceRealtimeContext) => Promise<void>;
  readonly decideRealtimeConfirmation: (
    confirmationId: VoiceConfirmationId,
    decision: VoiceConfirmationDecision,
  ) => Promise<void>;

  /**
   * Completes a pending native-owned client action. A successful activate-thread
   * completion also admits its matching native focus update before acknowledging
   * the server, so UI navigation never waits on the focus round trip.
   */
  readonly completeRealtimeClientAction: (
    actionId: VoiceClientActionId,
    outcome: VoiceClientActionOutcome,
    message?: string,
  ) => Promise<void>;

  /** Stops the current recording early and exposes its transcription for review. */
  readonly finishThreadRecording: () => Promise<void>;

  /** Updates the exact current review buffer used by notification Submit. */
  readonly updateThreadReviewTranscript: (
    token: VoiceThreadReviewToken,
    transcript: string,
  ) => Promise<void>;

  /** Submits the current, potentially edited, review transcript. */
  readonly submitThreadTranscript: (
    token: VoiceThreadReviewToken,
    transcript: string,
  ) => Promise<void>;
}

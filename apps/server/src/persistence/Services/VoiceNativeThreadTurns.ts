import type {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceDraftArtifactId,
  VoiceModeSessionId,
  VoiceNativeRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceNativeThreadTurnEvent,
  VoiceThreadTurnOperationId,
  VoiceNativeThreadTurnPhase,
  VoiceSpeechPlanId,
  VoiceSpeechPreset,
  VoiceTurnClientOperationId,
  VoiceSpeechSegmentDisposition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeThreadTurn {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly runtimeGeneration: number;
  readonly modeSessionId: VoiceModeSessionId;
  readonly turnClientOperationId: VoiceTurnClientOperationId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly speechPreset: VoiceSpeechPreset;
  readonly autoRearm: boolean;
  readonly submissionPolicy: "auto-submit" | "draft";
  readonly speechPlanId: VoiceSpeechPlanId;
  readonly phase: VoiceNativeThreadTurnPhase | "draft-ready";
  readonly processingLeaseUntil: number | null;
  readonly processingLeaseToken: string | null;
  readonly processingAttempt: number;
  readonly commandId: CommandId | null;
  readonly messageId: MessageId | null;
  readonly turnId: TurnId | null;
  readonly lastSequence: number;
  readonly acknowledgedSequence: number;
  readonly speechTerminal: "completed" | "no-speech" | "failed" | null;
  readonly highestStartedSegment: number | null;
  readonly highestDrainedSegment: number | null;
  readonly dispatchAccepted: boolean;
  readonly detachedAt: string | null;
  readonly operationTokenExpiresAt: number;
  readonly retentionExpiresAt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VoiceNativeThreadTurnAssistantMessageRecord {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly messageId: MessageId;
  readonly firstSeenSequence: number;
  readonly createdAt: string;
}

export interface VoiceNativeThreadTurnDraftRecord {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly draftId: VoiceDraftArtifactId;
  readonly state: "ready" | "consumed" | "expired";
  readonly cipherVersion: number;
  readonly nonce: Uint8Array | null;
  readonly ciphertext: Uint8Array | null;
  readonly expiresAt: number;
  readonly createdAt: string;
  readonly consumedAt: string | null;
}

export interface VoiceNativeThreadTurnReceiptCorrelation {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly runtimeGeneration: number;
  readonly modeSessionId: VoiceModeSessionId;
  readonly turnClientOperationId: VoiceTurnClientOperationId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly userMessageId: MessageId | null;
  readonly turnId: TurnId | null;
  readonly assistantMessageIds: ReadonlyArray<MessageId>;
  readonly speechPlanId: VoiceSpeechPlanId;
  readonly highestAdvertisedSegment: number | null;
  readonly highestStartedSegment: number | null;
  readonly highestDrainedSegment: number | null;
  readonly segmentDispositions: ReadonlyArray<VoiceSpeechSegmentDisposition>;
  readonly speechTerminal: "completed" | "no-speech" | "failed" | null;
  readonly terminalOutcome: "completed" | "failed" | "cancelled" | null;
  readonly detachedAt: string | null;
  readonly createdAt: string;
  readonly retentionExpiresAt: number;
}

export interface VoiceNativeThreadTurnSpeechSegmentRecord {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly segmentIndex: number;
  readonly assistantMessageId: MessageId;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly finalSegment: boolean;
  readonly sourceEventSequence: number;
  readonly sourceTextSha256: string;
  readonly createdAt: string;
}

export type VoiceNativeThreadTurnEventWithoutSequence =
  VoiceNativeThreadTurnEvent extends infer Event
    ? Event extends { readonly sequence: number }
      ? Omit<Event, "sequence">
      : never
    : never;

export interface VoiceNativeThreadTurnStoreShape {
  readonly claim: (input: {
    readonly operationId: VoiceThreadTurnOperationId;
    readonly authSessionId: AuthSessionId;
    readonly runtimeId: VoiceNativeRuntimeId;
    readonly runtimeInstanceId: VoiceRuntimeInstanceId;
    readonly runtimeGeneration: number;
    readonly modeSessionId: VoiceModeSessionId;
    readonly turnClientOperationId: VoiceTurnClientOperationId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly speechPreset: VoiceSpeechPreset;
    readonly autoRearm: boolean;
    readonly submissionPolicy: "auto-submit" | "draft";
    readonly speechPlanId: VoiceSpeechPlanId;
    readonly tokenHash: string;
    readonly operationTokenExpiresAt: number;
    readonly retentionExpiresAt: number;
    readonly nowEpochMillis: number;
    readonly now: string;
  }) => Effect.Effect<
    | {
        readonly status: "claimed";
        readonly operation: PersistedVoiceNativeThreadTurn;
      }
    | {
        readonly status: "expired";
        readonly operation: PersistedVoiceNativeThreadTurn;
      }
    | {
        readonly status: "mismatch";
        readonly operation: PersistedVoiceNativeThreadTurn;
      }
    | { readonly status: "revoked" },
    PersistenceSqlError
  >;
  readonly authorize: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceNativeThreadTurn | undefined, PersistenceSqlError>;
  readonly get: (
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<PersistedVoiceNativeThreadTurn | undefined, PersistenceSqlError>;
  readonly claimProcessing: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    leaseToken: string,
    now: number,
    leaseUntil: number,
    updatedAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly setDraftDisposition: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
    updatedAt: string,
  ) => Effect.Effect<"updated" | "unchanged" | "invalid" | "revoked", PersistenceSqlError>;
  readonly beginDispatch: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    leaseToken: string,
    now: number,
    occurredAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly recordAssistantMessages: (
    operationId: VoiceThreadTurnOperationId,
    messages: ReadonlyArray<{
      readonly messageId: MessageId;
      readonly firstSeenSequence: number;
      readonly createdAt: string;
    }>,
  ) => Effect.Effect<
    ReadonlyArray<VoiceNativeThreadTurnAssistantMessageRecord>,
    PersistenceSqlError
  >;
  readonly getReceiptCorrelation: (
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceNativeThreadTurnReceiptCorrelation | undefined, PersistenceSqlError>;
  readonly completeDraft: (input: {
    readonly operationId: VoiceThreadTurnOperationId;
    readonly tokenHash: string;
    readonly leaseToken: string;
    readonly draftId: VoiceDraftArtifactId;
    readonly cipherVersion: number;
    readonly nonce: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly expiresAt: number;
    readonly occurredAt: string;
  }) => Effect.Effect<"completed" | "existing" | "terminal" | "invalid", PersistenceSqlError>;
  readonly readDraft: (
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceNativeThreadTurnDraftRecord | undefined, PersistenceSqlError>;
  readonly readDraftAuthorized: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
    occurredAt: string,
  ) => Effect.Effect<
    | { readonly status: "ready"; readonly draft: VoiceNativeThreadTurnDraftRecord }
    | { readonly status: "unavailable" | "revoked" },
    PersistenceSqlError
  >;
  readonly consumeDraft: (
    operationId: VoiceThreadTurnOperationId,
    draftId: VoiceDraftArtifactId,
    tokenHash: string,
    now: number,
    consumedAt: string,
  ) => Effect.Effect<
    "consumed" | "already-consumed" | "expired" | "not-found" | "revoked",
    PersistenceSqlError
  >;
  readonly expireDrafts: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<VoiceThreadTurnOperationId>, PersistenceSqlError>;
  readonly detach: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
    detachedAt: string,
  ) => Effect.Effect<"detached" | "revoked", PersistenceSqlError>;
  readonly detachInternal: (
    operationId: VoiceThreadTurnOperationId,
    detachedAt: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly acceptDispatch: (input: {
    readonly operationId: VoiceThreadTurnOperationId;
    readonly tokenHash: string;
    readonly leaseToken: string;
    readonly occurredAt: string;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly releaseProcessing: (
    operationId: VoiceThreadTurnOperationId,
    leaseToken: string,
    occurredAt: string,
    failureCode: "transcription-failed" | "dispatch-failed" | "target-unavailable",
    retryable: boolean,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly appendEvent: (
    operationId: VoiceThreadTurnOperationId,
    event: VoiceNativeThreadTurnEventWithoutSequence,
    updates?: {
      readonly phase?: VoiceNativeThreadTurnPhase;
      readonly turnId?: TurnId | null;
    },
  ) => Effect.Effect<VoiceNativeThreadTurnEvent | undefined, PersistenceSqlError>;
  readonly finalize: (input: {
    readonly operationId: VoiceThreadTurnOperationId;
    readonly occurredAt: string;
    readonly outcome: "completed" | "failed" | "cancelled";
    readonly speechOutcome?: "completed" | "no-speech" | "failed";
    readonly failureCode?:
      | "audio-invalid"
      | "transcription-failed"
      | "dispatch-failed"
      | "target-unavailable"
      | "turn-failed"
      | "speech-failed"
      | "operation-expired";
    readonly retryable?: boolean;
    readonly leaseToken?: string;
    readonly requireUnleased?: boolean;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly listEvents: (
    operationId: VoiceThreadTurnOperationId,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<VoiceNativeThreadTurnEvent>, PersistenceSqlError>;
  readonly readEventPage: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<
    | {
        readonly operation: PersistedVoiceNativeThreadTurn;
        readonly events: ReadonlyArray<VoiceNativeThreadTurnEvent>;
      }
    | undefined,
    PersistenceSqlError
  >;
  readonly acknowledge: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    input: {
      readonly acknowledgedSequence: number;
      readonly speechPlanId: VoiceSpeechPlanId;
      readonly highestStartedSegment: number | null;
      readonly highestDrainedSegment: number | null;
      readonly segmentDispositions: ReadonlyArray<VoiceSpeechSegmentDisposition>;
      readonly occurredAt: string;
    },
    now: number,
  ) => Effect.Effect<"acknowledged" | "invalid" | "revoked", PersistenceSqlError>;
  readonly putSpeechSegmentAndEvent: (
    segment: VoiceNativeThreadTurnSpeechSegmentRecord,
  ) => Effect.Effect<
    "inserted" | "existing" | "mismatch" | "terminal" | "detached",
    PersistenceSqlError
  >;
  readonly resolveAssistantRevision: (assistantMessageId: MessageId) => Effect.Effect<
    | {
        readonly sourceEventSequence: number;
        readonly sourceTextSha256: string;
      }
    | undefined,
    PersistenceSqlError
  >;
  readonly getSpeechSegment: (
    operationId: VoiceThreadTurnOperationId,
    segmentIndex: number,
  ) => Effect.Effect<VoiceNativeThreadTurnSpeechSegmentRecord | undefined, PersistenceSqlError>;
  readonly listSpeechSegments: (
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<ReadonlyArray<VoiceNativeThreadTurnSpeechSegmentRecord>, PersistenceSqlError>;
  readonly getSpeechSegmentAuthorized: (
    operationId: VoiceThreadTurnOperationId,
    segmentIndex: number,
    tokenHash: string,
    now: number,
  ) => Effect.Effect<
    | { readonly status: "ready"; readonly segment: VoiceNativeThreadTurnSpeechSegmentRecord }
    | { readonly status: "missing" | "detached" | "revoked" },
    PersistenceSqlError
  >;
  readonly getSpeechSegmentText: (
    operationId: VoiceThreadTurnOperationId,
    segmentIndex: number,
  ) => Effect.Effect<string | undefined, PersistenceSqlError>;
  readonly cancel: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    occurredAt: string,
    now: number,
  ) => Effect.Effect<
    "cancelled" | "terminal" | "dispatch-committed" | "revoked",
    PersistenceSqlError
  >;
  readonly expireAndPurge: (
    now: number,
    occurredAt: string,
    retentionCutoff: number,
  ) => Effect.Effect<ReadonlyArray<VoiceThreadTurnOperationId>, PersistenceSqlError>;
  readonly listRecoverableOperationIds: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<VoiceThreadTurnOperationId>, PersistenceSqlError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceNativeRuntimeId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceNativeThreadTurnStore extends Context.Service<
  VoiceNativeThreadTurnStore,
  VoiceNativeThreadTurnStoreShape
>()("t3/persistence/Services/VoiceNativeThreadTurns/VoiceNativeThreadTurnStore") {}

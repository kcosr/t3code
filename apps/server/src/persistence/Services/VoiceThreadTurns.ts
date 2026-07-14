import type {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceDraftArtifactId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceThreadTurnEvent,
  VoiceThreadTurnOperationId,
  VoiceThreadTurnPhase,
  VoiceSpeechPlanId,
  VoiceSpeechPreset,
  VoiceTurnClientOperationId,
  VoiceSpeechSegmentDisposition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceThreadTurn {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly runtimeGeneration: number;
  readonly modeSessionId: VoiceModeSessionId;
  readonly turnClientOperationId: VoiceTurnClientOperationId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly speechPreset: VoiceSpeechPreset;
  readonly speechEnabled: boolean;
  readonly autoRearm: boolean;
  readonly submissionPolicy: "auto-submit" | "draft";
  readonly speechPlanId: VoiceSpeechPlanId;
  readonly phase: VoiceThreadTurnPhase | "draft-ready";
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

export interface VoiceThreadTurnAssistantMessageRecord {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly messageId: MessageId;
  readonly firstSeenSequence: number;
  readonly createdAt: string;
}

export interface VoiceThreadTurnDraftRecord {
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

export interface VoiceThreadTurnReceiptCorrelation {
  readonly operationId: VoiceThreadTurnOperationId;
  readonly runtimeId: VoiceRuntimeId;
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

export interface VoiceThreadTurnSpeechSegmentRecord {
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

export type VoiceThreadTurnEventWithoutSequence = VoiceThreadTurnEvent extends infer Event
  ? Event extends { readonly sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;

export interface VoiceThreadTurnStoreShape {
  readonly claim: (input: {
    readonly operationId: VoiceThreadTurnOperationId;
    readonly authSessionId: AuthSessionId;
    readonly runtimeId: VoiceRuntimeId;
    readonly runtimeInstanceId: VoiceRuntimeInstanceId;
    readonly runtimeGeneration: number;
    readonly modeSessionId: VoiceModeSessionId;
    readonly turnClientOperationId: VoiceTurnClientOperationId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly speechPreset: VoiceSpeechPreset;
    readonly speechEnabled: boolean;
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
        readonly operation: PersistedVoiceThreadTurn;
      }
    | {
        readonly status: "expired";
        readonly operation: PersistedVoiceThreadTurn;
      }
    | {
        readonly status: "mismatch";
        readonly operation: PersistedVoiceThreadTurn;
      }
    | { readonly status: "revoked" },
    PersistenceSqlError
  >;
  readonly authorize: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceThreadTurn | undefined, PersistenceSqlError>;
  readonly get: (
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<PersistedVoiceThreadTurn | undefined, PersistenceSqlError>;
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
  ) => Effect.Effect<ReadonlyArray<VoiceThreadTurnAssistantMessageRecord>, PersistenceSqlError>;
  readonly getReceiptCorrelation: (
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceThreadTurnReceiptCorrelation | undefined, PersistenceSqlError>;
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
  ) => Effect.Effect<VoiceThreadTurnDraftRecord | undefined, PersistenceSqlError>;
  readonly readDraftAuthorized: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
    occurredAt: string,
  ) => Effect.Effect<
    | { readonly status: "ready"; readonly draft: VoiceThreadTurnDraftRecord }
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
    event: VoiceThreadTurnEventWithoutSequence,
    updates?: {
      readonly phase?: VoiceThreadTurnPhase;
      readonly turnId?: TurnId | null;
    },
  ) => Effect.Effect<VoiceThreadTurnEvent | undefined, PersistenceSqlError>;
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
  ) => Effect.Effect<ReadonlyArray<VoiceThreadTurnEvent>, PersistenceSqlError>;
  readonly readEventPage: (
    operationId: VoiceThreadTurnOperationId,
    tokenHash: string,
    now: number,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<
    | {
        readonly operation: PersistedVoiceThreadTurn;
        readonly events: ReadonlyArray<VoiceThreadTurnEvent>;
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
    segment: VoiceThreadTurnSpeechSegmentRecord,
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
  ) => Effect.Effect<VoiceThreadTurnSpeechSegmentRecord | undefined, PersistenceSqlError>;
  readonly listSpeechSegments: (
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<ReadonlyArray<VoiceThreadTurnSpeechSegmentRecord>, PersistenceSqlError>;
  readonly getSpeechSegmentAuthorized: (
    operationId: VoiceThreadTurnOperationId,
    segmentIndex: number,
    tokenHash: string,
    now: number,
  ) => Effect.Effect<
    | { readonly status: "ready"; readonly segment: VoiceThreadTurnSpeechSegmentRecord }
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
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceThreadTurnStore extends Context.Service<
  VoiceThreadTurnStore,
  VoiceThreadTurnStoreShape
>()("t3/persistence/Services/VoiceThreadTurns/VoiceThreadTurnStore") {}

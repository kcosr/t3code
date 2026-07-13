import type {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceNativeRuntimeId,
  VoiceNativeThreadTurnEvent,
  VoiceNativeThreadTurnOperationId,
  VoiceNativeThreadTurnPhase,
  VoiceSpeechPreset,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeThreadTurn {
  readonly operationId: VoiceNativeThreadTurnOperationId;
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly runtimeGeneration: number;
  readonly clientOperationId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly speechPreset: VoiceSpeechPreset;
  readonly autoRearm: boolean;
  readonly phase: VoiceNativeThreadTurnPhase;
  readonly processingLeaseUntil: number | null;
  readonly processingLeaseToken: string | null;
  readonly processingAttempt: number;
  readonly commandId: CommandId | null;
  readonly messageId: MessageId | null;
  readonly turnId: TurnId | null;
  readonly lastSequence: number;
  readonly acknowledgedSequence: number;
  readonly speechTerminal: "completed" | "no-speech" | "failed" | null;
  readonly dispatchAccepted: boolean;
  readonly expiresAt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VoiceNativeThreadTurnSpeechSegmentRecord {
  readonly operationId: VoiceNativeThreadTurnOperationId;
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
    readonly operationId: VoiceNativeThreadTurnOperationId;
    readonly authSessionId: AuthSessionId;
    readonly runtimeId: VoiceNativeRuntimeId;
    readonly runtimeGeneration: number;
    readonly clientOperationId: string;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly speechPreset: VoiceSpeechPreset;
    readonly autoRearm: boolean;
    readonly tokenHash: string;
    readonly expiresAt: number;
    readonly nowEpochMillis: number;
    readonly now: string;
  }) => Effect.Effect<
    | { readonly status: "claimed"; readonly operation: PersistedVoiceNativeThreadTurn }
    | { readonly status: "expired"; readonly operation: PersistedVoiceNativeThreadTurn }
    | { readonly status: "mismatch"; readonly operation: PersistedVoiceNativeThreadTurn },
    PersistenceSqlError
  >;
  readonly authorize: (
    operationId: VoiceNativeThreadTurnOperationId,
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceNativeThreadTurn | undefined, PersistenceSqlError>;
  readonly get: (
    operationId: VoiceNativeThreadTurnOperationId,
  ) => Effect.Effect<PersistedVoiceNativeThreadTurn | undefined, PersistenceSqlError>;
  readonly claimProcessing: (
    operationId: VoiceNativeThreadTurnOperationId,
    leaseToken: string,
    now: number,
    leaseUntil: number,
    updatedAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly beginDispatch: (
    operationId: VoiceNativeThreadTurnOperationId,
    leaseToken: string,
    now: number,
    occurredAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly acceptDispatch: (input: {
    readonly operationId: VoiceNativeThreadTurnOperationId;
    readonly leaseToken: string;
    readonly occurredAt: string;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly releaseProcessing: (
    operationId: VoiceNativeThreadTurnOperationId,
    leaseToken: string,
    occurredAt: string,
    failureCode: "transcription-failed" | "dispatch-failed" | "target-unavailable",
    retryable: boolean,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly appendEvent: (
    operationId: VoiceNativeThreadTurnOperationId,
    event: VoiceNativeThreadTurnEventWithoutSequence,
    updates?: {
      readonly phase?: VoiceNativeThreadTurnPhase;
      readonly turnId?: TurnId | null;
    },
  ) => Effect.Effect<VoiceNativeThreadTurnEvent | undefined, PersistenceSqlError>;
  readonly finalize: (input: {
    readonly operationId: VoiceNativeThreadTurnOperationId;
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
    operationId: VoiceNativeThreadTurnOperationId,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<VoiceNativeThreadTurnEvent>, PersistenceSqlError>;
  readonly acknowledge: (
    operationId: VoiceNativeThreadTurnOperationId,
    sequence: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly putSpeechSegmentAndEvent: (
    segment: VoiceNativeThreadTurnSpeechSegmentRecord,
  ) => Effect.Effect<"inserted" | "existing" | "mismatch" | "terminal", PersistenceSqlError>;
  readonly resolveAssistantRevision: (
    assistantMessageId: MessageId,
  ) => Effect.Effect<
    { readonly sourceEventSequence: number; readonly sourceTextSha256: string } | undefined,
    PersistenceSqlError
  >;
  readonly getSpeechSegment: (
    operationId: VoiceNativeThreadTurnOperationId,
    segmentIndex: number,
  ) => Effect.Effect<VoiceNativeThreadTurnSpeechSegmentRecord | undefined, PersistenceSqlError>;
  readonly getSpeechSegmentText: (
    operationId: VoiceNativeThreadTurnOperationId,
    segmentIndex: number,
  ) => Effect.Effect<string | undefined, PersistenceSqlError>;
  readonly cancel: (
    operationId: VoiceNativeThreadTurnOperationId,
    occurredAt: string,
  ) => Effect.Effect<"cancelled" | "terminal" | "dispatch-committed", PersistenceSqlError>;
  readonly expireAndPurge: (
    now: number,
    occurredAt: string,
    retentionCutoff: number,
  ) => Effect.Effect<ReadonlyArray<VoiceNativeThreadTurnOperationId>, PersistenceSqlError>;
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

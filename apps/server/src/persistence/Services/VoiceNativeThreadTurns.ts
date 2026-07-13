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
  }) => Effect.Effect<PersistedVoiceNativeThreadTurn, PersistenceSqlError>;
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
    now: number,
    leaseUntil: number,
    updatedAt: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly appendEvent: (
    operationId: VoiceNativeThreadTurnOperationId,
    event: VoiceNativeThreadTurnEventWithoutSequence,
    updates?: {
      readonly phase?: VoiceNativeThreadTurnPhase;
      readonly commandId?: CommandId;
      readonly messageId?: MessageId;
      readonly turnId?: TurnId | null;
      readonly speechTerminal?: "completed" | "no-speech" | "failed";
      readonly dispatchAccepted?: boolean;
      readonly clearProcessingLease?: boolean;
      readonly terminal?: boolean;
    },
  ) => Effect.Effect<VoiceNativeThreadTurnEvent, PersistenceSqlError>;
  readonly listEvents: (
    operationId: VoiceNativeThreadTurnOperationId,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<VoiceNativeThreadTurnEvent>, PersistenceSqlError>;
  readonly acknowledge: (
    operationId: VoiceNativeThreadTurnOperationId,
    sequence: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly putSpeechSegment: (
    segment: VoiceNativeThreadTurnSpeechSegmentRecord,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getSpeechSegment: (
    operationId: VoiceNativeThreadTurnOperationId,
    segmentIndex: number,
  ) => Effect.Effect<VoiceNativeThreadTurnSpeechSegmentRecord | undefined, PersistenceSqlError>;
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

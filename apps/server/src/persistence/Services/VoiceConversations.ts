import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  VoiceConversationEntryId,
  VoiceConversationId,
  VoiceConversationRetention,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const DurableVoiceConversation = Schema.Struct({
  conversationId: VoiceConversationId,
  retention: Schema.Literal("durable"),
  title: Schema.NullOr(TrimmedNonEmptyString),
  activeEpoch: PositiveInt,
  lastCallAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DurableVoiceConversation = typeof DurableVoiceConversation.Type;

export const VoiceConversationJournalEntryKind = Schema.Literals([
  "transcript.user",
  "transcript.assistant",
  "summary",
  "tool-request",
  "tool-result",
  "context-change",
  "context-cleared",
]);
export type VoiceConversationJournalEntryKind = typeof VoiceConversationJournalEntryKind.Type;

export const VoiceConversationJournalEntry = Schema.Struct({
  entryId: VoiceConversationEntryId,
  conversationId: VoiceConversationId,
  epoch: PositiveInt,
  sequence: PositiveInt,
  kind: VoiceConversationJournalEntryKind,
  payload: Schema.Unknown,
  occurredAt: IsoDateTime,
});
export type VoiceConversationJournalEntry = typeof VoiceConversationJournalEntry.Type;

export const CreateVoiceConversationInput = Schema.Struct({
  conversationId: VoiceConversationId,
  retention: VoiceConversationRetention,
  title: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type CreateVoiceConversationInput = typeof CreateVoiceConversationInput.Type;

export const GetVoiceConversationInput = Schema.Struct({
  conversationId: VoiceConversationId,
});
export type GetVoiceConversationInput = typeof GetVoiceConversationInput.Type;

export const ListVoiceConversationsInput = Schema.Struct({
  beforeUpdatedAt: Schema.optionalKey(IsoDateTime),
  beforeConversationId: Schema.optionalKey(VoiceConversationId),
  limit: PositiveInt,
});
export type ListVoiceConversationsInput = typeof ListVoiceConversationsInput.Type;

export const VoiceConversationRepositoryPage = Schema.Struct({
  conversations: Schema.Array(DurableVoiceConversation),
  hasMore: Schema.Boolean,
});
export type VoiceConversationRepositoryPage = typeof VoiceConversationRepositoryPage.Type;

export const DeleteVoiceConversationInput = GetVoiceConversationInput;
export type DeleteVoiceConversationInput = typeof DeleteVoiceConversationInput.Type;

export const UpdateVoiceConversationTitleInput = Schema.Struct({
  conversationId: VoiceConversationId,
  title: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type UpdateVoiceConversationTitleInput = typeof UpdateVoiceConversationTitleInput.Type;

export const MarkVoiceConversationCallStartedInput = Schema.Struct({
  conversationId: VoiceConversationId,
  expectedEpoch: PositiveInt,
  startedAt: IsoDateTime,
});
export type MarkVoiceConversationCallStartedInput =
  typeof MarkVoiceConversationCallStartedInput.Type;

export const ClearVoiceConversationContextInput = Schema.Struct({
  conversationId: VoiceConversationId,
  entryId: VoiceConversationEntryId,
  expectedEpoch: PositiveInt,
  clearedAt: IsoDateTime,
});
export type ClearVoiceConversationContextInput = typeof ClearVoiceConversationContextInput.Type;

export const ClearedVoiceConversationContext = Schema.Struct({
  conversation: DurableVoiceConversation,
  clearedAt: IsoDateTime,
});
export type ClearedVoiceConversationContext = typeof ClearedVoiceConversationContext.Type;

export const AppendVoiceConversationJournalEntryInput = Schema.Struct({
  entryId: VoiceConversationEntryId,
  conversationId: VoiceConversationId,
  expectedEpoch: PositiveInt,
  kind: VoiceConversationJournalEntryKind,
  payload: Schema.Unknown,
  occurredAt: IsoDateTime,
});
export type AppendVoiceConversationJournalEntryInput =
  typeof AppendVoiceConversationJournalEntryInput.Type;

export const ListVoiceConversationContextInput = Schema.Struct({
  conversationId: VoiceConversationId,
  expectedEpoch: PositiveInt,
  limit: Schema.optionalKey(PositiveInt),
});
export type ListVoiceConversationContextInput = typeof ListVoiceConversationContextInput.Type;

export const VoiceConversationTranscriptRow = Schema.Struct({
  entryId: VoiceConversationEntryId,
  conversationId: VoiceConversationId,
  contextEpoch: PositiveInt,
  sequence: PositiveInt,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  occurredAt: IsoDateTime,
});
export type VoiceConversationTranscriptRow = typeof VoiceConversationTranscriptRow.Type;

export const ListVoiceConversationTranscriptInput = Schema.Struct({
  conversationId: VoiceConversationId,
  snapshotThroughSequence: NonNegativeInt,
  beforeSequence: PositiveInt,
  limit: PositiveInt,
});
export type ListVoiceConversationTranscriptInput = typeof ListVoiceConversationTranscriptInput.Type;

export const VoiceConversationTranscriptRepositoryPage = Schema.Struct({
  entries: Schema.Array(VoiceConversationTranscriptRow),
  hasMore: Schema.Boolean,
});
export type VoiceConversationTranscriptRepositoryPage =
  typeof VoiceConversationTranscriptRepositoryPage.Type;

export class VoiceConversationAlreadyExistsError extends Schema.TaggedErrorClass<VoiceConversationAlreadyExistsError>()(
  "VoiceConversationAlreadyExistsError",
  { conversationId: VoiceConversationId },
) {}

export class VoiceConversationNotFoundError extends Schema.TaggedErrorClass<VoiceConversationNotFoundError>()(
  "VoiceConversationNotFoundError",
  { conversationId: VoiceConversationId },
) {}

export class VoiceConversationEpochConflictError extends Schema.TaggedErrorClass<VoiceConversationEpochConflictError>()(
  "VoiceConversationEpochConflictError",
  {
    conversationId: VoiceConversationId,
    expectedEpoch: PositiveInt,
    actualEpoch: PositiveInt,
  },
) {}

export class VoiceConversationEntryConflictError extends Schema.TaggedErrorClass<VoiceConversationEntryConflictError>()(
  "VoiceConversationEntryConflictError",
  {
    conversationId: VoiceConversationId,
    entryId: VoiceConversationEntryId,
  },
) {}

export class EphemeralVoiceConversationPersistenceError extends Schema.TaggedErrorClass<EphemeralVoiceConversationPersistenceError>()(
  "EphemeralVoiceConversationPersistenceError",
  { conversationId: VoiceConversationId },
) {}

export type VoiceConversationRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | VoiceConversationAlreadyExistsError
  | VoiceConversationNotFoundError
  | VoiceConversationEpochConflictError
  | VoiceConversationEntryConflictError
  | EphemeralVoiceConversationPersistenceError;

export interface VoiceConversationRepositoryShape {
  readonly create: (
    input: CreateVoiceConversationInput,
  ) => Effect.Effect<DurableVoiceConversation, VoiceConversationRepositoryError>;
  readonly get: (
    input: GetVoiceConversationInput,
  ) => Effect.Effect<
    Option.Option<DurableVoiceConversation>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly list: (
    input: ListVoiceConversationsInput,
  ) => Effect.Effect<VoiceConversationRepositoryPage, PersistenceSqlError | PersistenceDecodeError>;
  readonly updateTitle: (
    input: UpdateVoiceConversationTitleInput,
  ) => Effect.Effect<
    Option.Option<DurableVoiceConversation>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly markCallStarted: (
    input: MarkVoiceConversationCallStartedInput,
  ) => Effect.Effect<DurableVoiceConversation, VoiceConversationRepositoryError>;
  readonly delete: (
    input: DeleteVoiceConversationInput,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly clearContext: (
    input: ClearVoiceConversationContextInput,
  ) => Effect.Effect<ClearedVoiceConversationContext, VoiceConversationRepositoryError>;
  readonly append: (
    input: AppendVoiceConversationJournalEntryInput,
  ) => Effect.Effect<VoiceConversationJournalEntry, VoiceConversationRepositoryError>;
  readonly listContext: (
    input: ListVoiceConversationContextInput,
  ) => Effect.Effect<
    ReadonlyArray<VoiceConversationJournalEntry>,
    VoiceConversationRepositoryError
  >;
  readonly listTranscript: (
    input: ListVoiceConversationTranscriptInput,
  ) => Effect.Effect<VoiceConversationTranscriptRepositoryPage, VoiceConversationRepositoryError>;
  readonly getTranscriptSnapshotSequence: (
    input: GetVoiceConversationInput,
  ) => Effect.Effect<number, VoiceConversationRepositoryError>;
}

export class VoiceConversationRepository extends Context.Service<
  VoiceConversationRepository,
  VoiceConversationRepositoryShape
>()("t3/persistence/Services/VoiceConversations/VoiceConversationRepository") {}

import {
  IsoDateTime,
  PositiveInt,
  TrimmedNonEmptyString,
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
  "call-boundary",
  "device-handoff",
  "context-cleared",
]);
export type VoiceConversationJournalEntryKind = typeof VoiceConversationJournalEntryKind.Type;

export const VoiceConversationJournalEntry = Schema.Struct({
  entryId: TrimmedNonEmptyString,
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
  limit: Schema.optionalKey(PositiveInt),
});
export type ListVoiceConversationsInput = typeof ListVoiceConversationsInput.Type;

export const DeleteVoiceConversationInput = GetVoiceConversationInput;
export type DeleteVoiceConversationInput = typeof DeleteVoiceConversationInput.Type;

export const ClearVoiceConversationContextInput = Schema.Struct({
  conversationId: VoiceConversationId,
  entryId: TrimmedNonEmptyString,
  expectedEpoch: PositiveInt,
  clearedAt: IsoDateTime,
});
export type ClearVoiceConversationContextInput = typeof ClearVoiceConversationContextInput.Type;

export const AppendVoiceConversationJournalEntryInput = Schema.Struct({
  entryId: TrimmedNonEmptyString,
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
  limit: Schema.optionalKey(PositiveInt),
});
export type ListVoiceConversationContextInput = typeof ListVoiceConversationContextInput.Type;

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
    entryId: TrimmedNonEmptyString,
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
    input?: ListVoiceConversationsInput,
  ) => Effect.Effect<
    ReadonlyArray<DurableVoiceConversation>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly delete: (
    input: DeleteVoiceConversationInput,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly clearContext: (
    input: ClearVoiceConversationContextInput,
  ) => Effect.Effect<DurableVoiceConversation, VoiceConversationRepositoryError>;
  readonly append: (
    input: AppendVoiceConversationJournalEntryInput,
  ) => Effect.Effect<VoiceConversationJournalEntry, VoiceConversationRepositoryError>;
  readonly listContext: (
    input: ListVoiceConversationContextInput,
  ) => Effect.Effect<
    ReadonlyArray<VoiceConversationJournalEntry>,
    VoiceConversationRepositoryError
  >;
}

export class VoiceConversationRepository extends Context.Service<
  VoiceConversationRepository,
  VoiceConversationRepositoryShape
>()("t3/persistence/Services/VoiceConversations/VoiceConversationRepository") {}

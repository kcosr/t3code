import type {
  VoiceConversationClearContextResult,
  VoiceConversationCreateInput,
  VoiceConversationEntryId,
  VoiceConversationId,
  VoiceConversationListPage,
  VoiceConversationListQuery,
  VoiceConversationSummary,
  VoiceConversationTranscriptPage,
  VoiceConversationTranscriptQuery,
  VoiceConversationUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type {
  VoiceConversationJournalEntry,
  VoiceConversationJournalEntryKind,
} from "../../persistence/Services/VoiceConversations.ts";
import type { VoiceError } from "../Errors.ts";

export interface VoiceConversationServiceShape {
  readonly create: (
    input: VoiceConversationCreateInput,
  ) => Effect.Effect<VoiceConversationSummary, VoiceError>;
  readonly listDurable: (
    query: VoiceConversationListQuery,
  ) => Effect.Effect<VoiceConversationListPage, VoiceError>;
  readonly get: (
    conversationId: VoiceConversationId,
  ) => Effect.Effect<Option.Option<VoiceConversationSummary>, VoiceError>;
  readonly updateTitle: (
    conversationId: VoiceConversationId,
    input: VoiceConversationUpdateInput,
  ) => Effect.Effect<VoiceConversationSummary, VoiceError>;
  readonly markCallStarted: (
    conversationId: VoiceConversationId,
    expectedEpoch: number,
  ) => Effect.Effect<VoiceConversationSummary, VoiceError>;
  readonly delete: (conversationId: VoiceConversationId) => Effect.Effect<boolean, VoiceError>;
  readonly clearContext: (
    conversationId: VoiceConversationId,
    expectedEpoch: number,
    idempotencyKey: string,
  ) => Effect.Effect<VoiceConversationClearContextResult, VoiceError>;
  readonly listTranscript: (
    conversationId: VoiceConversationId,
    query: VoiceConversationTranscriptQuery,
  ) => Effect.Effect<VoiceConversationTranscriptPage, VoiceError>;
  readonly listContext: (
    conversationId: VoiceConversationId,
    expectedEpoch: number,
  ) => Effect.Effect<ReadonlyArray<VoiceConversationJournalEntry>, VoiceError>;
  readonly appendContext: (input: {
    readonly conversationId: VoiceConversationId;
    readonly expectedEpoch: number;
    readonly kind: VoiceConversationJournalEntryKind;
    readonly payload: unknown;
  }) => Effect.Effect<VoiceConversationJournalEntry, VoiceError>;
  readonly appendContextIdempotent: (input: {
    readonly entryId: VoiceConversationEntryId;
    readonly conversationId: VoiceConversationId;
    readonly expectedEpoch: number;
    readonly kind: VoiceConversationJournalEntryKind;
    readonly payload: unknown;
  }) => Effect.Effect<VoiceConversationJournalEntry, VoiceError>;
}

export class VoiceConversationService extends Context.Service<
  VoiceConversationService,
  VoiceConversationServiceShape
>()("t3/voice/Services/VoiceConversationService") {}

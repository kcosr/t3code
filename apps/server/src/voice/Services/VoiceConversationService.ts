import type {
  VoiceConversationClearContextResult,
  VoiceConversationCreateInput,
  VoiceConversationId,
  VoiceConversationSummary,
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
  readonly listDurable: Effect.Effect<ReadonlyArray<VoiceConversationSummary>, VoiceError>;
  readonly get: (
    conversationId: VoiceConversationId,
  ) => Effect.Effect<Option.Option<VoiceConversationSummary>, VoiceError>;
  readonly delete: (conversationId: VoiceConversationId) => Effect.Effect<boolean, VoiceError>;
  readonly clearContext: (
    conversationId: VoiceConversationId,
  ) => Effect.Effect<VoiceConversationClearContextResult, VoiceError>;
  readonly listContext: (
    conversationId: VoiceConversationId,
  ) => Effect.Effect<ReadonlyArray<VoiceConversationJournalEntry>, VoiceError>;
  readonly appendContext: (input: {
    readonly conversationId: VoiceConversationId;
    readonly kind: VoiceConversationJournalEntryKind;
    readonly payload: unknown;
  }) => Effect.Effect<VoiceConversationJournalEntry, VoiceError>;
  readonly appendContextIdempotent: (input: {
    readonly entryId: string;
    readonly conversationId: VoiceConversationId;
    readonly kind: VoiceConversationJournalEntryKind;
    readonly payload: unknown;
  }) => Effect.Effect<VoiceConversationJournalEntry, VoiceError>;
}

export class VoiceConversationService extends Context.Service<
  VoiceConversationService,
  VoiceConversationServiceShape
>()("t3/voice/Services/VoiceConversationService") {}

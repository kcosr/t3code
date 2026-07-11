import type {
  HistoryRole,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  VoiceConversationEntryId,
  VoiceConversationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceSqlError } from "../Errors.ts";

export interface HistoryIndexGenerations {
  readonly threadMessage: number;
  readonly voiceEntry: number;
}

export interface HistoryRepositorySearchCursor {
  readonly rawRank: number;
  readonly occurredAt: IsoDateTime;
  readonly itemId: string;
}

interface HistoryRepositorySearchInput {
  readonly query: string;
  readonly roles?: ReadonlyArray<HistoryRole>;
  readonly occurredAfter?: IsoDateTime;
  readonly occurredBefore?: IsoDateTime;
  readonly limit: number;
  readonly after?: HistoryRepositorySearchCursor;
}

export interface ThreadHistorySearchInput extends HistoryRepositorySearchInput {
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
}

export interface VoiceHistorySearchInput extends HistoryRepositorySearchInput {
  readonly conversationId?: VoiceConversationId;
}

export interface ThreadHistorySearchRow {
  readonly source: "thread-message";
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly containerTitle: string | null;
  readonly roleOrKind: string;
  readonly text: string;
  readonly occurredAt: IsoDateTime;
  readonly rawRank: number;
}

export interface VoiceHistorySearchRow {
  readonly source: "voice-entry";
  readonly conversationId: VoiceConversationId;
  readonly entryId: VoiceConversationEntryId;
  readonly containerTitle: string | null;
  readonly roleOrKind: string;
  readonly text: string;
  readonly occurredAt: IsoDateTime;
  readonly rawRank: number;
}

export interface ThreadHistoryRecord {
  readonly source: "thread-message";
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly roleOrKind: string;
  readonly text: string;
  readonly occurredAt: IsoDateTime;
}

export interface VoiceHistoryRecord {
  readonly source: "voice-entry";
  readonly conversationId: VoiceConversationId;
  readonly entryId: VoiceConversationEntryId;
  readonly roleOrKind: string;
  readonly text: string;
  readonly occurredAt: IsoDateTime;
}

export interface ThreadHistoryReadInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly before: number;
  readonly after: number;
}

export interface VoiceHistoryReadInput {
  readonly conversationId: VoiceConversationId;
  readonly entryId: VoiceConversationEntryId;
  readonly before: number;
  readonly after: number;
}

export interface HistoryRepositoryReadResult<Record> {
  readonly target: Record;
  readonly context: ReadonlyArray<Record>;
}

export class HistorySearchQueryError extends Schema.TaggedErrorClass<HistorySearchQueryError>()(
  "HistorySearchQueryError",
  { reason: Schema.Literals(["empty", "too_many_terms"]) },
) {}

export type HistorySearchRepositoryError = PersistenceSqlError | HistorySearchQueryError;

export interface HistorySearchRepositoryShape {
  readonly getGenerations: () => Effect.Effect<HistoryIndexGenerations, PersistenceSqlError>;
  readonly searchThread: (
    input: ThreadHistorySearchInput,
  ) => Effect.Effect<ReadonlyArray<ThreadHistorySearchRow>, HistorySearchRepositoryError>;
  readonly searchVoice: (
    input: VoiceHistorySearchInput,
  ) => Effect.Effect<ReadonlyArray<VoiceHistorySearchRow>, HistorySearchRepositoryError>;
  readonly readThread: (
    input: ThreadHistoryReadInput,
  ) => Effect.Effect<
    Option.Option<HistoryRepositoryReadResult<ThreadHistoryRecord>>,
    PersistenceSqlError
  >;
  readonly readVoice: (
    input: VoiceHistoryReadInput,
  ) => Effect.Effect<
    Option.Option<HistoryRepositoryReadResult<VoiceHistoryRecord>>,
    PersistenceSqlError
  >;
}

export class HistorySearchRepository extends Context.Service<
  HistorySearchRepository,
  HistorySearchRepositoryShape
>()("t3/persistence/Services/HistorySearch/HistorySearchRepository") {}

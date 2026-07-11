import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  VoiceConversationEntryId,
  VoiceConversationId,
} from "./baseSchemas.ts";

export const HISTORY_QUERY_MAX_CHARS = 1_024;
export const HISTORY_CURSOR_MAX_CHARS = 4_096;
export const HISTORY_SEARCH_MAX_RESULTS = 20;
export const HISTORY_EXCERPT_MAX_CHARS = 1_000;
export const HISTORY_READ_CONTEXT_MAX_RECORDS = 10;
export const HISTORY_RECORD_CONTENT_MAX_CHARS = 16_000;

export const HistorySource = Schema.Literals(["thread-message", "voice-entry"]);
export type HistorySource = typeof HistorySource.Type;

export const HistoryThreadMessageRef = Schema.Struct({
  type: Schema.Literal("thread-message"),
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
});
export type HistoryThreadMessageRef = typeof HistoryThreadMessageRef.Type;

export const HistoryVoiceEntryRef = Schema.Struct({
  type: Schema.Literal("voice-entry"),
  conversationId: VoiceConversationId,
  entryId: VoiceConversationEntryId,
});
export type HistoryVoiceEntryRef = typeof HistoryVoiceEntryRef.Type;

export const HistoryItemRef = Schema.Union([HistoryThreadMessageRef, HistoryVoiceEntryRef]);
export type HistoryItemRef = typeof HistoryItemRef.Type;

export const HistoryVoiceScope = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("conversation"),
    conversationId: VoiceConversationId,
  }),
  Schema.Struct({ type: Schema.Literal("all-durable") }),
]);
export type HistoryVoiceScope = typeof HistoryVoiceScope.Type;

export const HistoryRole = Schema.Literals(["user", "assistant", "system"]);
export type HistoryRole = typeof HistoryRole.Type;

const HistoryFilterInstant = IsoDateTime.check(
  Schema.isPattern(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/,
  ),
);

const HistorySources = Schema.Array(HistorySource)
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(2));
const HistoryLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: HISTORY_SEARCH_MAX_RESULTS }),
);
const HistoryCursor = TrimmedNonEmptyString.check(Schema.isMaxLength(HISTORY_CURSOR_MAX_CHARS));
const HistoryContextRadius = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: HISTORY_READ_CONTEXT_MAX_RECORDS }),
);

export const HistorySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(HISTORY_QUERY_MAX_CHARS)),
  sources: HistorySources,
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
  voiceScope: Schema.optionalKey(HistoryVoiceScope),
  roles: Schema.optionalKey(
    Schema.Array(HistoryRole).check(Schema.isMinLength(1)).check(Schema.isMaxLength(3)),
  ),
  occurredAfter: Schema.optionalKey(HistoryFilterInstant),
  occurredBefore: Schema.optionalKey(HistoryFilterInstant),
  limit: HistoryLimit,
  cursor: Schema.optionalKey(HistoryCursor),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HistorySearchInput = typeof HistorySearchInput.Type;

export const HistorySearchMatch = Schema.Struct({
  ref: HistoryItemRef,
  containerTitle: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  roleOrKind: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  occurredAt: IsoDateTime,
  excerpt: Schema.String.check(Schema.isMaxLength(HISTORY_EXCERPT_MAX_CHARS)),
  excerptTruncated: Schema.Boolean,
  score: Schema.Number,
});
export type HistorySearchMatch = typeof HistorySearchMatch.Type;

export const HistorySearchPage = Schema.Struct({
  matches: Schema.Array(HistorySearchMatch).check(Schema.isMaxLength(HISTORY_SEARCH_MAX_RESULTS)),
  nextCursor: Schema.NullOr(HistoryCursor),
});
export type HistorySearchPage = typeof HistorySearchPage.Type;

const HistoryReadWindow = {
  before: HistoryContextRadius,
  after: HistoryContextRadius,
};

export const HistoryReadInput = Schema.Struct({
  ref: HistoryItemRef,
  voiceScope: Schema.optionalKey(HistoryVoiceScope),
  ...HistoryReadWindow,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HistoryReadInput = typeof HistoryReadInput.Type;

export const HistoryRecord = Schema.Struct({
  ref: HistoryItemRef,
  roleOrKind: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  occurredAt: IsoDateTime,
  content: Schema.String.check(Schema.isMaxLength(HISTORY_RECORD_CONTENT_MAX_CHARS)),
  truncated: Schema.Boolean,
});
export type HistoryRecord = typeof HistoryRecord.Type;

export const HistoryReadResult = Schema.Struct({
  target: HistoryRecord,
  context: Schema.Array(HistoryRecord).check(
    Schema.isMaxLength(HISTORY_READ_CONTEXT_MAX_RECORDS * 2),
  ),
});
export type HistoryReadResult = typeof HistoryReadResult.Type;

export const HistoryRequestInvalidReason = Schema.Literals([
  "invalid_query",
  "invalid_filters",
  "invalid_cursor",
  "invalid_reference",
]);
export type HistoryRequestInvalidReason = typeof HistoryRequestInvalidReason.Type;

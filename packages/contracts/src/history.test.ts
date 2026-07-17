import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  HISTORY_EXCERPT_MAX_CHARS,
  HISTORY_QUERY_MAX_CHARS,
  HISTORY_READ_CONTEXT_MAX_RECORDS,
  HISTORY_SEARCH_MAX_RESULTS,
  HistoryReadInput,
  HistorySearchInput,
  HistorySearchPage,
} from "./history.ts";

const decodeSearch = Schema.decodeUnknownSync(HistorySearchInput);
const decodeRead = Schema.decodeUnknownSync(HistoryReadInput);
const decodePage = Schema.decodeUnknownSync(HistorySearchPage);

describe("history contracts", () => {
  it("accepts owner-bound search filters and rejects unknown fields", () => {
    expect(
      decodeSearch({
        query: "android background audio",
        sources: ["thread-message", "voice-entry"],
        projectId: "project-1",
        voiceScope: { type: "all-durable" },
        roles: ["user", "assistant"],
        limit: 10,
      }),
    ).toMatchObject({ query: "android background audio", limit: 10 });

    expect(() =>
      decodeSearch({
        query: "audio",
        sources: ["thread-message"],
        limit: 10,
        sql: "SELECT *",
      }),
    ).toThrow();
  });

  it("bounds queries, result counts, and excerpts", () => {
    expect(() =>
      decodeSearch({
        query: "x".repeat(HISTORY_QUERY_MAX_CHARS + 1),
        sources: ["thread-message"],
        limit: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeSearch({
        query: "audio",
        sources: ["thread-message"],
        limit: HISTORY_SEARCH_MAX_RESULTS + 1,
      }),
    ).toThrow();

    const match = {
      ref: {
        type: "thread-message" as const,
        projectId: "project-1",
        threadId: "thread-1",
        messageId: "message-1",
      },
      containerTitle: "Voice design",
      roleOrKind: "assistant",
      occurredAt: "2026-07-11T00:00:00.000Z",
      excerpt: "x".repeat(HISTORY_EXCERPT_MAX_CHARS + 1),
      excerptTruncated: true,
      score: 1,
    };
    expect(() => decodePage({ matches: [match], nextCursor: null })).toThrow();
  });

  it("accepts only canonical UTC time filters", () => {
    expect(
      decodeSearch({
        query: "audio",
        sources: ["thread-message"],
        occurredAfter: "2026-07-11T01:02:03.004Z",
        limit: 1,
      }).occurredAfter,
    ).toBe("2026-07-11T01:02:03.004Z");
    for (const occurredAfter of [
      "2026-07-11T01:02:03Z",
      "2026-07-11T01:02:03.004-05:00",
      "2026-99-99T01:02:03.004Z",
      "not-a-date",
    ]) {
      expect(() =>
        decodeSearch({
          query: "audio",
          sources: ["thread-message"],
          occurredAfter,
          limit: 1,
        }),
      ).toThrow();
    }
  });

  it("represents explicit voice scopes for owner-bound reads", () => {
    const voiceRef = {
      type: "voice-entry" as const,
      conversationId: "conversation-1",
      entryId: "entry-1",
    };
    expect(decodeRead({ ref: voiceRef, before: 1, after: 1 })).toMatchObject({ ref: voiceRef });
    expect(
      decodeRead({
        ref: voiceRef,
        voiceScope: { type: "conversation", conversationId: "conversation-1" },
        before: HISTORY_READ_CONTEXT_MAX_RECORDS,
        after: HISTORY_READ_CONTEXT_MAX_RECORDS,
      }),
    ).toMatchObject({ ref: voiceRef });
  });

  it("requires project, thread, and message identity for thread reads", () => {
    expect(() =>
      decodeRead({
        ref: { type: "thread-message", threadId: "thread-1", messageId: "message-1" },
        before: 0,
        after: 0,
      }),
    ).toThrow();
  });
});

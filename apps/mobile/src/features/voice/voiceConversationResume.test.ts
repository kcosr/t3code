import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import {
  VoiceConversationId,
  type VoiceConversationListPage,
  type VoiceConversationListQuery,
  type VoiceConversationSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadResumeSelection } from "./voiceConversationResume";

const conversation = (
  id: string,
  retention: VoiceConversationSummary["retention"],
  updatedAt: string,
  lastCallAt: string | null = null,
): VoiceConversationSummary => ({
  conversationId: VoiceConversationId.make(id),
  retention,
  title: id,
  activeEpoch: 1,
  lastCallAt,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt,
});

const clientForPages = (pages: ReadonlyArray<VoiceConversationListPage>) => {
  const remaining = [...pages];
  const queries: Array<VoiceConversationListQuery | undefined> = [];
  const listConversations: VoiceHttpClient["listConversations"] = (query) => {
    queries.push(query);
    const page = remaining.shift();
    if (page === undefined) throw new Error("Unexpected conversation page request");
    return Effect.succeed(page);
  };
  return { client: { listConversations }, queries };
};

describe("loadResumeSelection", () => {
  it("keeps paging until it finds the newest durable conversation", async () => {
    const { client, queries } = clientForPages([
      {
        conversations: [conversation("temporary", "ephemeral", "2026-07-20T00:00:00.000Z")],
        nextCursor: "page-2",
      },
      {
        conversations: [
          conversation(
            "durable",
            "durable",
            "2026-07-18T00:00:00.000Z",
            "2026-07-18T00:00:00.000Z",
          ),
        ],
        nextCursor: null,
      },
    ]);

    await expect(loadResumeSelection(client, new AbortController().signal)).resolves.toEqual({
      type: "continue",
      conversationId: VoiceConversationId.make("durable"),
      takeover: false,
    });
    expect(queries.map((query) => query?.cursor)).toEqual([undefined, "page-2"]);
  });

  it("does not start paging after cancellation", async () => {
    const listConversations = vi.fn<VoiceHttpClient["listConversations"]>(() =>
      Effect.die("must not load"),
    );
    const abort = new AbortController();
    abort.abort();

    await expect(loadResumeSelection({ listConversations }, abort.signal)).resolves.toBeNull();
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("stops before requesting another page when cancellation arrives", async () => {
    const abort = new AbortController();
    const listConversations = vi.fn<VoiceHttpClient["listConversations"]>(() =>
      Effect.sync(() => {
        abort.abort();
        return {
          conversations: [conversation("temporary", "ephemeral", "2026-07-20T00:00:00.000Z")],
          nextCursor: "page-2",
        };
      }),
    );

    await expect(loadResumeSelection({ listConversations }, abort.signal)).resolves.toBeNull();
    expect(listConversations).toHaveBeenCalledOnce();
  });
});

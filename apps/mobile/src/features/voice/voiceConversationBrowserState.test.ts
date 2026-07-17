import {
  VoiceConversationEntryId,
  VoiceConversationId,
  type VoiceConversationSummary,
  type VoiceConversationTranscriptEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeVoiceConversations,
  mergeVoiceTranscriptEntries,
  removeVoiceConversation,
  replaceVoiceConversation,
  sortVoiceConversations,
  voiceTranscriptRows,
} from "./voiceConversationBrowserState";

const summary = (id: string, updatedAt: string): VoiceConversationSummary => ({
  conversationId: VoiceConversationId.make(id),
  retention: "durable",
  title: id,
  activeEpoch: 1,
  lastCallAt: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt,
});

const entry = (
  id: string,
  sequence: number,
  contextEpoch = 1,
): VoiceConversationTranscriptEntry => ({
  entryId: VoiceConversationEntryId.make(id),
  contextEpoch,
  sequence,
  role: sequence % 2 === 0 ? "assistant" : "user",
  text: id,
  truncated: false,
  occurredAt: "2026-07-10T00:00:00.000Z",
});

describe("voice conversation browser state", () => {
  it("sorts summaries deterministically and reorders an updated conversation", () => {
    const older = summary("older", "2026-07-10T00:00:00.000Z");
    const newer = summary("newer", "2026-07-11T00:00:00.000Z");
    expect(sortVoiceConversations([older, newer]).map((item) => item.conversationId)).toEqual([
      "newer",
      "older",
    ]);

    const renamed = { ...older, title: "Renamed", updatedAt: "2026-07-12T00:00:00.000Z" };
    expect(replaceVoiceConversation([newer, older], renamed)).toEqual([renamed, newer]);
    expect(removeVoiceConversation([renamed, newer], renamed.conversationId)).toEqual([newer]);
    expect(mergeVoiceConversations([newer], [older, newer])).toEqual([newer, older]);
  });

  it("prepends cursor pages in sequence order and deduplicates stable entry ids", () => {
    const newest = [entry("entry-3", 3), entry("entry-4", 4)];
    const older = [entry("entry-1", 1), entry("entry-2", 2), entry("entry-3", 3)];
    expect(mergeVoiceTranscriptEntries(newest, older).map((item) => item.entryId)).toEqual([
      "entry-1",
      "entry-2",
      "entry-3",
      "entry-4",
    ]);
  });

  it("merges conversation pages by id in deterministic list order", () => {
    const older = summary("older", "2026-07-10T00:00:00.000Z");
    const newer = summary("newer", "2026-07-11T00:00:00.000Z");
    expect(mergeVoiceConversations([newer], [older, { ...newer, title: "Updated" }])).toEqual([
      { ...newer, title: "Updated" },
      older,
    ]);
  });

  it("inserts stable epoch separators and identifies model-visible context", () => {
    const rows = voiceTranscriptRows(
      [entry("old-user", 1, 1), entry("old-assistant", 2, 1), entry("new-user", 4, 2)],
      2,
    );
    expect(
      rows.map((row) => (row.type === "entry" ? row.id : `${row.contextEpoch}:${row.active}`)),
    ).toEqual(["1:false", "old-user", "old-assistant", "2:true", "new-user"]);
  });

  it("keeps epoch separator identities stable when an earlier page is prepended", () => {
    const newest = [entry("entry-3", 3), entry("entry-4", 4)];
    const initialEpochRow = voiceTranscriptRows(newest, 1)[0];
    const mergedEpochRow = voiceTranscriptRows(
      mergeVoiceTranscriptEntries(newest, [entry("entry-1", 1), entry("entry-2", 2)]),
      1,
    )[0];

    expect(initialEpochRow).toMatchObject({ type: "epoch", id: "epoch:1" });
    expect(mergedEpochRow).toMatchObject({ type: "epoch", id: "epoch:1" });
  });
});

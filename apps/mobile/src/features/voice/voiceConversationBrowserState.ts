import type {
  VoiceConversationSummary,
  VoiceConversationTranscriptEntry,
} from "@t3tools/contracts";

export type VoiceTranscriptRow =
  | {
      readonly type: "epoch";
      readonly id: string;
      readonly contextEpoch: number;
      readonly active: boolean;
    }
  | {
      readonly type: "entry";
      readonly id: string;
      readonly entry: VoiceConversationTranscriptEntry;
    };

export function sortVoiceConversations(
  conversations: ReadonlyArray<VoiceConversationSummary>,
): ReadonlyArray<VoiceConversationSummary> {
  return [...conversations].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.conversationId.localeCompare(right.conversationId),
  );
}

export function replaceVoiceConversation(
  conversations: ReadonlyArray<VoiceConversationSummary>,
  updated: VoiceConversationSummary,
): ReadonlyArray<VoiceConversationSummary> {
  return sortVoiceConversations([
    ...conversations.filter(
      (conversation) => conversation.conversationId !== updated.conversationId,
    ),
    updated,
  ]);
}

export function mergeVoiceConversations(
  current: ReadonlyArray<VoiceConversationSummary>,
  incoming: ReadonlyArray<VoiceConversationSummary>,
): ReadonlyArray<VoiceConversationSummary> {
  const byId = new Map(current.map((conversation) => [conversation.conversationId, conversation]));
  for (const conversation of incoming) byId.set(conversation.conversationId, conversation);
  return sortVoiceConversations([...byId.values()]);
}

export function removeVoiceConversation(
  conversations: ReadonlyArray<VoiceConversationSummary>,
  conversationId: VoiceConversationSummary["conversationId"],
): ReadonlyArray<VoiceConversationSummary> {
  return conversations.filter((conversation) => conversation.conversationId !== conversationId);
}

export function mergeVoiceTranscriptEntries(
  current: ReadonlyArray<VoiceConversationTranscriptEntry>,
  incoming: ReadonlyArray<VoiceConversationTranscriptEntry>,
): ReadonlyArray<VoiceConversationTranscriptEntry> {
  const byId = new Map(current.map((entry) => [entry.entryId, entry] as const));
  for (const entry of incoming) byId.set(entry.entryId, entry);
  return [...byId.values()].sort(
    (left, right) => left.sequence - right.sequence || left.entryId.localeCompare(right.entryId),
  );
}

export function voiceTranscriptRows(
  entries: ReadonlyArray<VoiceConversationTranscriptEntry>,
  activeContextEpoch: number,
): ReadonlyArray<VoiceTranscriptRow> {
  const rows: Array<VoiceTranscriptRow> = [];
  let previousEpoch: number | null = null;
  for (const entry of entries) {
    if (entry.contextEpoch !== previousEpoch) {
      rows.push({
        type: "epoch",
        id: `epoch:${entry.contextEpoch}`,
        contextEpoch: entry.contextEpoch,
        active: entry.contextEpoch === activeContextEpoch,
      });
      previousEpoch = entry.contextEpoch;
    }
    rows.push({ type: "entry", id: entry.entryId, entry });
  }
  return rows;
}

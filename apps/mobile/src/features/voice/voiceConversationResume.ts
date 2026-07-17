import {
  durableVoiceConversations,
  resumeVoiceConversationSelection,
  type VoiceHttpClient,
} from "@t3tools/client-runtime/voice";
import {
  VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
  type VoiceConversationSelection,
  type VoiceConversationSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export async function loadResumeSelection(
  client: Pick<VoiceHttpClient, "listConversations">,
  signal: AbortSignal,
): Promise<VoiceConversationSelection | null> {
  const conversations: Array<VoiceConversationSummary> = [];
  let cursor: string | undefined;
  let shouldLoad = true;
  do {
    if (signal.aborted) return null;
    const page = await Effect.runPromise(
      client.listConversations({
        ...(cursor === undefined ? {} : { cursor }),
        limit: VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
      }),
      { signal },
    );
    if (signal.aborted) return null;
    conversations.push(...page.conversations);
    if (page.nextCursor === null) {
      shouldLoad = false;
      continue;
    }

    const best = durableVoiceConversations(conversations)[0];
    const oldestUpdatedAt = page.conversations.at(-1)?.updatedAt;
    if (
      best !== undefined &&
      oldestUpdatedAt !== undefined &&
      (best.lastCallAt ?? best.createdAt).localeCompare(oldestUpdatedAt) >= 0
    ) {
      shouldLoad = false;
    }
    cursor = page.nextCursor;
  } while (shouldLoad);
  return signal.aborted ? null : resumeVoiceConversationSelection(conversations);
}

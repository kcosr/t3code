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

/**
 * Page durable conversations until the newest resume candidate is known, matching
 * the Android resume loader used for stop → Start history continuity.
 */
export async function loadResumeSelection(
  client: Pick<VoiceHttpClient, "listConversations">,
  signal?: AbortSignal,
): Promise<VoiceConversationSelection> {
  const conversations: Array<VoiceConversationSummary> = [];
  let cursor: string | undefined;
  let shouldLoad = true;
  do {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const page = await Effect.runPromise(
      client.listConversations({
        ...(cursor === undefined ? {} : { cursor }),
        limit: VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
      }),
      signal !== undefined ? { signal } : undefined,
    );
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

  return resumeVoiceConversationSelection(conversations);
}

/** Prefer continue with takeover when resuming after an intentional local stop. */
export function selectionForResumeStart(
  selection: VoiceConversationSelection,
): VoiceConversationSelection {
  if (selection.type === "continue") {
    return { ...selection, takeover: true };
  }
  return selection;
}

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import {
  VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
  VoiceNativeRuntimeTarget,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VoiceConversationId,
  type VoiceConversationSummary,
  type VoiceNativeRuntimeTarget as VoiceNativeRuntimeTargetType,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PersistedVoiceThreadTarget } from "./masterVoiceState";
import { durableVoiceConversations, newVoiceConversationTitle } from "./masterVoiceState";

type NativeRuntimeTargetClient = Pick<VoiceHttpClient, "createConversation" | "listConversations">;
type NativeRuntimeThreadShell = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "environmentId" | "id" | "projectId"
>;

export class NativeVoiceRuntimeTargetUnavailableError extends Data.TaggedError(
  "NativeVoiceRuntimeTargetUnavailableError",
)<{
  readonly mode: "thread";
}> {
  override get message(): string {
    return "The selected background voice thread is no longer available.";
  }
}

export const canonicalNativeVoiceRuntimeTargetIdentity = Schema.encodeSync(
  Schema.fromJsonString(VoiceNativeRuntimeTarget),
);

export interface ResolvedNativeVoiceRuntimeTarget {
  readonly target: VoiceNativeRuntimeTargetType;
  readonly targetIdentity: string;
}

async function newestDurableConversation(
  client: NativeRuntimeTargetClient,
): Promise<VoiceConversationSummary | null> {
  const conversations: Array<VoiceConversationSummary> = [];
  let cursor: string | undefined;
  let shouldLoad = true;
  do {
    const page = await Effect.runPromise(
      client.listConversations({
        ...(cursor === undefined ? {} : { cursor }),
        limit: VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
      }),
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
  return durableVoiceConversations(conversations)[0] ?? null;
}

async function resolveRealtimeConversationId(input: {
  readonly client: NativeRuntimeTargetClient;
  readonly activeConversationId: VoiceConversationId | null;
}): Promise<VoiceConversationId> {
  if (input.activeConversationId !== null) return input.activeConversationId;
  const existing = await newestDurableConversation(input.client);
  if (existing !== null) return existing.conversationId;
  const created = await Effect.runPromise(
    input.client.createConversation({
      retention: "durable",
      title: newVoiceConversationTitle(),
    }),
  );
  return created.conversationId;
}

function withIdentity(target: VoiceNativeRuntimeTargetType): ResolvedNativeVoiceRuntimeTarget {
  return { target, targetIdentity: canonicalNativeVoiceRuntimeTargetIdentity(target) };
}

export async function resolveNativeVoiceRuntimeTarget(input: {
  readonly client: NativeRuntimeTargetClient;
  readonly mode: "realtime" | "thread";
  readonly environmentId: EnvironmentId;
  readonly activeConversationId: VoiceConversationId | null;
  readonly focus: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  } | null;
  readonly threadTarget: PersistedVoiceThreadTarget | null | undefined;
  readonly threads: ReadonlyArray<NativeRuntimeThreadShell>;
  readonly autoRearm: boolean;
}): Promise<ResolvedNativeVoiceRuntimeTarget> {
  if (input.mode === "realtime") {
    const conversationId = await resolveRealtimeConversationId(input);
    const focus =
      input.focus?.environmentId === input.environmentId
        ? {
            type: "thread" as const,
            projectId: input.focus.projectId,
            threadId: input.focus.threadId,
          }
        : { type: "none" as const };
    return withIdentity({
      mode: "realtime",
      conversation: { type: "continue", conversationId },
      focus,
    });
  }

  const selected = input.threadTarget;
  const thread =
    selected === null ||
    selected === undefined ||
    selected.environmentId !== String(input.environmentId)
      ? undefined
      : input.threads.find(
          (candidate) =>
            candidate.environmentId === input.environmentId &&
            String(candidate.id) === selected.threadId &&
            candidate.archivedAt === null,
        );
  if (thread === undefined) {
    throw new NativeVoiceRuntimeTargetUnavailableError({ mode: "thread" });
  }
  return withIdentity({
    mode: "thread",
    projectId: thread.projectId,
    threadId: thread.id,
    speechPreset: "default",
    autoRearm: input.autoRearm,
  });
}

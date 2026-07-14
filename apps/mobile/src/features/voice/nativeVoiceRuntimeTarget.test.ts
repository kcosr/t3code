import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  type VoiceConversationListPage,
  type VoiceConversationSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  nativeVoiceRuntimeReadinessTargetId,
  NativeVoiceRuntimeTargetUnavailableError,
  resolveNativeVoiceRuntimeTarget,
} from "./nativeVoiceRuntimeTarget";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const CONVERSATION_ID = VoiceConversationId.make("conversation-1");

const conversation = (
  conversationId: string,
  retention: "durable" | "ephemeral",
  createdAt: string,
): VoiceConversationSummary => ({
  conversationId: VoiceConversationId.make(conversationId),
  retention,
  title: conversationId,
  activeEpoch: 1,
  lastCallAt: null,
  createdAt,
  updatedAt: createdAt,
});

const client = (pages: ReadonlyArray<VoiceConversationListPage>) => {
  let page = 0;
  let creates = 0;
  return {
    value: {
      listConversations: () => Effect.succeed(pages[page++]!),
      createConversation: () => {
        creates += 1;
        return Effect.succeed(
          conversation("conversation-created", "durable", "2026-07-12T05:00:00.000Z"),
        );
      },
    },
    creates: () => creates,
  };
};

const thread = (archivedAt: string | null = null) =>
  ({
    environmentId: ENVIRONMENT_ID,
    id: THREAD_ID,
    projectId: PROJECT_ID,
    archivedAt,
  }) as const;

const threadRuntimeSettings = {
  endpointPolicy: {
    endSilenceMs: 2_200,
    noSpeechTimeoutMs: null,
    maximumUtteranceMs: 600_000,
  },
  speechEnabled: true,
  rearmGuardMs: 500,
} as const;

describe("resolveNativeVoiceRuntimeTarget", () => {
  it("keeps the active Realtime conversation without listing or creating another", async () => {
    const voice = client([]);
    const result = await resolveNativeVoiceRuntimeTarget({
      client: voice.value,
      mode: "realtime",
      environmentId: ENVIRONMENT_ID,
      activeConversationId: CONVERSATION_ID,
      focus: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, threadId: THREAD_ID },
      threadTarget: null,
      threads: [],
      autoRearm: false,
    });

    expect(result.target).toEqual({
      mode: "realtime",
      conversation: { type: "continue", conversationId: CONVERSATION_ID },
      focus: { type: "thread", projectId: PROJECT_ID, threadId: THREAD_ID },
    });
    expect(result.targetIdentity).toBe(
      '{"conversation":{"conversationId":"conversation-1","type":"continue"},"focus":{"projectId":"project-1","threadId":"thread-1","type":"thread"},"mode":"realtime"}',
    );
    expect(nativeVoiceRuntimeReadinessTargetId(result.target)).toBe("conversation-1");
    expect(voice.creates()).toBe(0);
  });

  it("selects the newest durable conversation and ignores a newer ephemeral one", async () => {
    const voice = client([
      {
        conversations: [
          conversation("ephemeral-new", "ephemeral", "2026-07-12T05:00:00.000Z"),
          conversation("durable-old", "durable", "2026-07-12T04:00:00.000Z"),
        ],
        nextCursor: null,
      },
    ]);
    const result = await resolveNativeVoiceRuntimeTarget({
      client: voice.value,
      mode: "realtime",
      environmentId: ENVIRONMENT_ID,
      activeConversationId: null,
      focus: null,
      threadTarget: null,
      threads: [],
      autoRearm: false,
    });

    expect(result.target).toMatchObject({
      conversation: { conversationId: "durable-old" },
      focus: { type: "none" },
    });
    expect(voice.creates()).toBe(0);
  });

  it("creates one durable conversation when none exists", async () => {
    const voice = client([{ conversations: [], nextCursor: null }]);
    const result = await resolveNativeVoiceRuntimeTarget({
      client: voice.value,
      mode: "realtime",
      environmentId: ENVIRONMENT_ID,
      activeConversationId: null,
      focus: null,
      threadTarget: null,
      threads: [],
      autoRearm: false,
    });

    expect(result.target).toMatchObject({
      conversation: { conversationId: "conversation-created" },
    });
    expect(voice.creates()).toBe(1);
  });

  it("derives the exact project and thread target from the live shell", async () => {
    const voice = client([]);
    const result = await resolveNativeVoiceRuntimeTarget({
      client: voice.value,
      mode: "thread",
      environmentId: ENVIRONMENT_ID,
      activeConversationId: null,
      focus: null,
      threadTarget: {
        environmentId: String(ENVIRONMENT_ID),
        threadId: String(THREAD_ID),
        generation: 4,
      },
      threads: [thread()],
      autoRearm: true,
      ...threadRuntimeSettings,
    });
    expect(result.targetIdentity).toBe(
      '{"autoRearm":true,"endpointPolicy":{"endSilenceMs":2200,"maximumUtteranceMs":600000,"noSpeechTimeoutMs":null},"environmentId":"environment-1","mode":"thread","projectId":"project-1","rearmGuardMs":500,"speechEnabled":true,"speechPreset":"default","threadId":"thread-1"}',
    );

    expect(result.target).toEqual({
      mode: "thread",
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      speechPreset: "default",
      autoRearm: true,
      ...threadRuntimeSettings,
    });
    expect(nativeVoiceRuntimeReadinessTargetId(result.target)).toBe("project-1/thread-1");
    expect(nativeVoiceRuntimeReadinessTargetId(result.target)).not.toContain(
      String(ENVIRONMENT_ID),
    );
  });

  it("rejects an archived or missing thread target", async () => {
    const voice = client([]);
    await expect(
      resolveNativeVoiceRuntimeTarget({
        client: voice.value,
        mode: "thread",
        environmentId: ENVIRONMENT_ID,
        activeConversationId: null,
        focus: null,
        threadTarget: {
          environmentId: String(ENVIRONMENT_ID),
          threadId: String(THREAD_ID),
          generation: 4,
        },
        threads: [thread("2026-07-12T05:00:00.000Z")],
        autoRearm: true,
        ...threadRuntimeSettings,
      }),
    ).rejects.toBeInstanceOf(NativeVoiceRuntimeTargetUnavailableError);
  });
});

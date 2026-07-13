import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  type VoiceConversationSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  durableVoiceConversations,
  continueVoiceConversationSelection,
  isSameMasterVoiceFocus,
  masterVoiceEnvironmentId,
  nextVoiceThreadTarget,
  reconcileMasterVoiceFocus,
  newVoiceConversationSelection,
  newVoiceConversationTitle,
  resumeVoiceConversationSelection,
  VoiceFocusUpdateQueue,
  type MasterVoiceFocus,
} from "./masterVoiceState";

const environmentId = EnvironmentId.make("environment-one");
const localDateTime = new Date(2026, 6, 11, 14, 5);
const focus: MasterVoiceFocus = {
  environmentId,
  projectId: ProjectId.make("project-one"),
  threadId: ThreadId.make("thread-one"),
  threadTitle: "Voice work",
};

describe("voice thread target", () => {
  it("persists a newly selected thread with a monotonic target generation", () => {
    expect(nextVoiceThreadTarget(undefined, focus)).toEqual({
      environmentId,
      threadId: focus.threadId,
      generation: 1,
    });
    expect(nextVoiceThreadTarget(null, focus)).toEqual({
      environmentId,
      threadId: focus.threadId,
      generation: 1,
    });
    expect(
      nextVoiceThreadTarget(
        { environmentId: "previous", threadId: "previous", generation: 8 },
        focus,
      ),
    ).toEqual({ environmentId, threadId: focus.threadId, generation: 9 });
  });

  it("does not rewrite the selected target or clear it outside a thread", () => {
    const current = { environmentId, threadId: focus.threadId, generation: 8 };
    expect(nextVoiceThreadTarget(current, focus)).toBeNull();
    expect(nextVoiceThreadTarget(current, null)).toBeNull();
  });
});

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

describe("master voice state", () => {
  it("serializes focus updates and only commits the latest request", async () => {
    const queue = new VoiceFocusUpdateQueue();
    const order: Array<string> = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(
      async () => {
        order.push("first:start");
        await firstBlocked;
        order.push("first:end");
      },
      () => order.push("first:commit"),
    );
    await Promise.resolve();
    const second = queue.enqueue(
      async () => {
        order.push("second:start");
      },
      () => order.push("second:commit"),
    );
    releaseFirst();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:commit"]);
  });

  it("keeps the active environment authoritative across route focus changes", () => {
    expect(masterVoiceEnvironmentId(environmentId, null)).toBe(environmentId);
    expect(masterVoiceEnvironmentId(null, focus)).toBe(environmentId);
  });

  it("sorts only durable conversations for explicit selection", () => {
    expect(
      durableVoiceConversations([
        conversation("older", "durable", "2026-07-10T00:00:00.000Z"),
        conversation("temporary", "ephemeral", "2026-07-11T00:00:00.000Z"),
        conversation("newer", "durable", "2026-07-12T00:00:00.000Z"),
      ]).map(({ conversationId }) => conversationId),
    ).toEqual(["newer", "older"]);
  });

  it("resumes the most recently active durable conversation by default", () => {
    expect(
      resumeVoiceConversationSelection([
        conversation("older", "durable", "2026-07-13T00:00:00.000Z", "2026-07-10T00:00:00.000Z"),
        conversation("temporary", "ephemeral", "2026-07-12T00:00:00.000Z"),
        conversation("latest", "durable", "2026-07-11T00:00:00.000Z", "2026-07-11T00:00:00.000Z"),
      ]),
    ).toEqual({
      type: "continue",
      conversationId: VoiceConversationId.make("latest"),
      takeover: false,
    });
  });

  it("falls back to creation time when no call has started", () => {
    expect(
      resumeVoiceConversationSelection([
        conversation("older", "durable", "2026-07-13T00:00:00.000Z"),
        {
          ...conversation("newer", "durable", "2026-07-11T00:00:00.000Z"),
          createdAt: "2026-07-11T00:00:00.000Z",
        },
      ]),
    ).toMatchObject({ conversationId: VoiceConversationId.make("newer") });
  });

  it("creates the first durable conversation when there is nothing to resume", () => {
    expect(
      resumeVoiceConversationSelection(
        [conversation("temporary", "ephemeral", "2026-07-12T00:00:00.000Z")],
        localDateTime,
      ),
    ).toEqual({
      type: "new",
      retention: "durable",
      title: "Voice · 2026-07-11 14:05",
    });
  });

  it("keeps explicit new and resume selections distinct", () => {
    expect(newVoiceConversationSelection(localDateTime)).toEqual({
      type: "new",
      retention: "durable",
      title: "Voice · 2026-07-11 14:05",
    });
    expect(continueVoiceConversationSelection(VoiceConversationId.make("selected"))).toEqual({
      type: "continue",
      conversationId: VoiceConversationId.make("selected"),
      takeover: false,
    });
  });

  it("formats new conversation titles from the local date and time", () => {
    expect(newVoiceConversationTitle(new Date(2026, 0, 2, 3, 4))).toBe("Voice · 2026-01-02 03:04");
  });

  it("compares focus by environment, project, and thread identity", () => {
    expect(isSameMasterVoiceFocus(focus, { ...focus, threadTitle: "Renamed" })).toBe(true);
    expect(
      isSameMasterVoiceFocus(focus, {
        ...focus,
        threadId: ThreadId.make("thread-two"),
      }),
    ).toBe(false);
  });

  it("preserves an active voice session while navigating away from thread routes", () => {
    expect(reconcileMasterVoiceFocus({ environmentId, focus }, null)).toEqual({
      type: "preserve",
    });
  });

  it("updates focus without replacing the active environment", () => {
    const nextFocus = {
      ...focus,
      threadId: ThreadId.make("thread-two"),
      threadTitle: "Next thread",
    };

    expect(reconcileMasterVoiceFocus({ environmentId, focus }, nextFocus)).toEqual({
      type: "update",
      attachment: { environmentId, focus: nextFocus },
    });
  });

  it("refreshes a resolved thread title without requiring a server focus write", () => {
    expect(
      reconcileMasterVoiceFocus(
        { environmentId, focus: { ...focus, threadTitle: "Thread" } },
        focus,
      ),
    ).toEqual({ type: "refresh", attachment: { environmentId, focus } });
  });

  it("stops instead of carrying an active voice session into another environment", () => {
    const nextFocus = {
      ...focus,
      environmentId: EnvironmentId.make("environment-two"),
    };

    expect(reconcileMasterVoiceFocus({ environmentId, focus }, nextFocus)).toEqual({
      type: "stop",
    });
  });
});

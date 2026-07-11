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
  reconcileMasterVoiceFocus,
  newVoiceConversationSelection,
  resumeVoiceConversationSelection,
  type MasterVoiceFocus,
} from "./masterVoiceState";

const environmentId = EnvironmentId.make("environment-one");
const focus: MasterVoiceFocus = {
  environmentId,
  projectId: ProjectId.make("project-one"),
  threadId: ThreadId.make("thread-one"),
  threadTitle: "Voice work",
};

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
      resumeVoiceConversationSelection([
        conversation("temporary", "ephemeral", "2026-07-12T00:00:00.000Z"),
      ]),
    ).toEqual({ type: "new", retention: "durable", title: "T3 Voice" });
  });

  it("keeps explicit new and resume selections distinct", () => {
    expect(newVoiceConversationSelection()).toEqual({
      type: "new",
      retention: "durable",
      title: "T3 Voice",
    });
    expect(continueVoiceConversationSelection(VoiceConversationId.make("selected"))).toEqual({
      type: "continue",
      conversationId: VoiceConversationId.make("selected"),
      takeover: false,
    });
  });

  it("compares focus by environment, project, and thread identity", () => {
    expect(isSameMasterVoiceFocus(focus, { ...focus, threadTitle: "Renamed" })).toBe(true);
    expect(isSameMasterVoiceFocus(focus, { ...focus, threadId: ThreadId.make("thread-two") })).toBe(
      false,
    );
  });

  it("preserves an active call while navigating away from thread routes", () => {
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

  it("stops instead of carrying an active call into another environment", () => {
    const nextFocus = {
      ...focus,
      environmentId: EnvironmentId.make("environment-two"),
    };

    expect(reconcileMasterVoiceFocus({ environmentId, focus }, nextFocus)).toEqual({
      type: "stop",
    });
  });
});

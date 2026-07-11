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
  isSameMasterVoiceFocus,
  masterVoiceEnvironmentId,
  reconcileMasterVoiceFocus,
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
): VoiceConversationSummary => ({
  conversationId: VoiceConversationId.make(id),
  retention,
  title: id,
  activeEpoch: 1,
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

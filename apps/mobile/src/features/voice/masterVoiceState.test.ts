import type { VoiceRuntimeSnapshot } from "@t3tools/client-runtime/voice";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  VoiceConversationId,
  type VoiceConversationSummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  admittedClientActionFocusState,
  bindVoiceConversationBrowser,
  canOfferThreadVoiceSwitch,
  durableVoiceConversations,
  continueVoiceConversationSelection,
  masterVoiceEnvironmentId,
  prepareVoiceRuntimeAttachment,
  reconcileVoiceAudioRoutePickerState,
  newVoiceConversationSelection,
  newVoiceConversationTitle,
  resumeVoiceConversationSelection,
  settleVoiceAudioRoutePickerSelection,
  threadVoiceStartForFocus,
  voiceRuntimeCommandEnvironmentMatches,
  voiceRuntimePresentationPhase,
  voiceRuntimeSnapshotEnvironmentId,
  type MasterVoiceFocus,
} from "./masterVoiceState";
import { resolveVoicePreferences } from "./voicePreferences";

const environmentId = EnvironmentId.make("environment-one");
const localDateTime = new Date(2026, 6, 11, 14, 5);
const focus: MasterVoiceFocus = {
  environmentId,
  projectId: ProjectId.make("project-one"),
  threadId: ThreadId.make("thread-one"),
  threadTitle: "Voice work",
  runtimeMode: "approval-required",
  interactionMode: "default",
  interactionRequired: false,
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
    expect(
      masterVoiceEnvironmentId(
        environmentId,
        { ...focus, environmentId: EnvironmentId.make("environment-two") },
        EnvironmentId.make("environment-three"),
      ),
    ).toBe(environmentId);
  });

  it("remounts the conversation browser instead of pairing an old row with a new environment", () => {
    const oldEnvironmentId = EnvironmentId.make("environment-old");
    const newEnvironmentId = EnvironmentId.make("environment-new");
    const context = { focus: null, threadSwitch: null };
    const oldBinding = bindVoiceConversationBrowser(oldEnvironmentId, context);
    const newBinding = bindVoiceConversationBrowser(newEnvironmentId, context);
    const oldConversation = continueVoiceConversationSelection(
      VoiceConversationId.make("old-environment-conversation"),
    );

    expect(newBinding.mountKey).not.toBe(oldBinding.mountKey);
    expect(oldBinding.targetFor(oldConversation)).toMatchObject({
      environmentId: oldEnvironmentId,
      conversation: oldConversation,
    });
    expect(newBinding.targetFor(oldConversation)).toMatchObject({
      environmentId: newEnvironmentId,
      conversation: oldConversation,
    });
  });

  it("maps Auto Listen and Auto Submit settings into the native Thread runtime", () => {
    const oneShotReview = threadVoiceStartForFocus(
      focus,
      resolveVoicePreferences({
        voiceAutoListenEnabled: false,
        voiceAutoSubmitEnabled: false,
      }),
      false,
    );
    const continuousSubmit = threadVoiceStartForFocus(
      focus,
      resolveVoicePreferences({
        voiceAutoListenEnabled: true,
        voiceAutoSubmitEnabled: true,
      }),
      true,
    );

    expect(oneShotReview?.settings).toMatchObject({
      autoRearm: false,
      submission: "review",
      playResponses: false,
    });
    expect(continuousSubmit?.settings).toMatchObject({
      autoRearm: true,
      submission: "auto-submit",
      playResponses: true,
    });
  });

  it("offers notification Thread switching only for a ready, empty, unblocked composer", () => {
    const eligible = {
      composerDraftsReady: true,
      composerContentEmpty: true,
      interactionRequired: false,
    };
    expect(canOfferThreadVoiceSwitch(eligible)).toBe(true);
    expect(canOfferThreadVoiceSwitch({ ...eligible, composerDraftsReady: false })).toBe(false);
    expect(canOfferThreadVoiceSwitch({ ...eligible, composerContentEmpty: false })).toBe(false);
    expect(canOfferThreadVoiceSwitch({ ...eligible, interactionRequired: true })).toBe(false);
  });

  it("keeps route-picker progress across unrelated snapshots and clears it on route selection", () => {
    const selecting = { selectingRouteId: "bluetooth", error: null };
    const unchanged = reconcileVoiceAudioRoutePickerState(selecting, {
      controlsAvailable: true,
      routes: [
        { id: "speaker", label: "Speaker", type: "speaker", selected: true },
        { id: "bluetooth", label: "Headset", type: "bluetooth", selected: false },
      ],
    });

    expect(unchanged).toBe(selecting);
    expect(settleVoiceAudioRoutePickerSelection(selecting, "bluetooth")).toEqual({
      selectingRouteId: null,
      error: null,
    });
    expect(settleVoiceAudioRoutePickerSelection(selecting, "speaker")).toBe(selecting);
    expect(
      reconcileVoiceAudioRoutePickerState(selecting, {
        controlsAvailable: true,
        routes: [
          { id: "speaker", label: "Speaker", type: "speaker", selected: false },
          { id: "bluetooth", label: "Headset", type: "bluetooth", selected: true },
        ],
      }),
    ).toEqual({ selectingRouteId: null, error: null });
    expect(
      reconcileVoiceAudioRoutePickerState(selecting, {
        controlsAvailable: false,
        routes: [],
      }),
    ).toBeNull();
  });

  it("rejects a captured old-environment conversation against a new ready runtime", () => {
    expect(voiceRuntimeCommandEnvironmentMatches(environmentId, environmentId, environmentId)).toBe(
      true,
    );
    expect(
      voiceRuntimeCommandEnvironmentMatches(
        environmentId,
        EnvironmentId.make("environment-two"),
        EnvironmentId.make("environment-two"),
      ),
    ).toBe(false);
    expect(
      voiceRuntimeCommandEnvironmentMatches(
        environmentId,
        environmentId,
        EnvironmentId.make("environment-two"),
      ),
    ).toBe(false);
    expect(voiceRuntimeCommandEnvironmentMatches(environmentId, null, environmentId)).toBe(false);
  });

  it("does not expose a runtime until snapshot subscription hydration succeeds", async () => {
    const detach = vi.fn();
    const subscribe = vi.fn(async () => detach);
    const runtime = { adapter: { subscribe } };

    const attachment = await prepareVoiceRuntimeAttachment({
      runtime,
      listener: () => undefined,
      isDisposed: () => false,
    });

    expect(attachment?.runtime).toBe(runtime);
    expect(attachment?.detach).toBe(detach);

    const failedRuntime = {
      adapter: {
        subscribe: vi.fn(async () => {
          throw new Error("snapshot hydration failed");
        }),
      },
    };
    await expect(
      prepareVoiceRuntimeAttachment({
        runtime: failedRuntime,
        listener: () => undefined,
        isDisposed: () => false,
      }),
    ).rejects.toThrow("snapshot hydration failed");
  });

  it("detaches a subscription that finishes after its provider was disposed", async () => {
    const detach = vi.fn();
    const runtime = { adapter: { subscribe: vi.fn(async () => detach) } };

    await expect(
      prepareVoiceRuntimeAttachment({
        runtime,
        listener: () => undefined,
        isDisposed: () => true,
      }),
    ).resolves.toBeNull();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("derives active environment and presentation only from the complete native snapshot", () => {
    const realtime: VoiceRuntimeSnapshot = {
      mode: "realtime",
      phase: "connected",
      generation: 2,
      sequence: 8,
      target: {
        environmentId,
        conversation: {
          type: "new",
          retention: "durable",
          title: "Voice",
        },
        focus: null,
        threadSwitch: null,
      },
      muted: false,
      audioRoutes: [],
      transcript: [],
      pendingConfirmations: [],
      pendingClientActions: [],
    };
    expect(voiceRuntimeSnapshotEnvironmentId(realtime)).toBe(environmentId);
    expect(voiceRuntimePresentationPhase(realtime)).toBe("active");
    expect(
      voiceRuntimePresentationPhase({
        mode: "failed",
        operation: "realtime",
        failure: { code: "network", message: "Network failed", retryable: true },
        generation: 2,
        sequence: 9,
      }),
    ).toBe("error");
    expect(voiceRuntimeSnapshotEnvironmentId({ mode: "idle", generation: 3, sequence: 10 })).toBe(
      null,
    );
  });

  it("defers context reconciliation until client-action navigation admits the exact focus", () => {
    const admitted = {
      actionId: VoiceClientActionId.make("activate-thread"),
      environmentId,
      projectId: focus.projectId,
      threadId: focus.threadId,
    };
    expect(admittedClientActionFocusState(null, focus)).toBe("none");
    expect(
      admittedClientActionFocusState(admitted, {
        ...focus,
        environmentId: EnvironmentId.make("environment-two"),
      }),
    ).toBe("waiting");
    expect(admittedClientActionFocusState(admitted, focus)).toBe("admitted");
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
});

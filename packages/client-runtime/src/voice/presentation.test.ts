// @effect-diagnostics globalDate:off
import type { VoiceRuntimeSnapshot } from "./runtime.ts";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
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
  createVoiceRuntimeRetryCoordinator,
  durableVoiceConversations,
  isThreadVoiceStartAvailable,
  continueVoiceConversationSelection,
  masterVoiceEnvironmentId,
  prepareVoiceRuntimeAttachment,
  reconcileVoiceAudioRoutePickerState,
  newVoiceConversationSelection,
  newVoiceConversationTitle,
  resumeVoiceConversationSelection,
  settleVoiceAudioRoutePickerSelection,
  stopVoiceRuntimeStrict,
  threadVoiceStartForFocus,
  voiceRuntimeCommandEnvironmentMatches,
  voiceRuntimePresentationPhase,
  voiceRuntimeSnapshotEnvironmentId,
  type MasterVoiceFocus,
  type ThreadVoiceStartPreferences,
} from "./presentation.ts";

const voicePreferences = (
  overrides: Partial<ThreadVoiceStartPreferences> = {},
): ThreadVoiceStartPreferences => ({
  autoListenEnabled: false,
  autoSubmitEnabled: true,
  endSilenceMs: 2_200,
  noSpeechTimeoutMs: null,
  maximumUtteranceMs: 120_000,
  postPlaybackGuardMs: 750,
  transcriptionTimeoutMs: 600_000,
  submissionTimeoutMs: 30_000,
  responseTimeoutMs: 600_000,
  ...overrides,
});

const environmentId = EnvironmentId.make("environment-one");
const localDateTime = new Date(2026, 6, 11, 14, 5);
const focus: MasterVoiceFocus = {
  environmentId,
  projectId: ProjectId.make("project-one"),
  threadId: ThreadId.make("thread-one"),
  threadTitle: "Voice work",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  interactionRequired: false,
  activeThreadBusy: false,
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
      voicePreferences({ autoListenEnabled: false, autoSubmitEnabled: false }),
      false,
    );
    const continuousSubmit = threadVoiceStartForFocus(
      focus,
      voicePreferences({ autoListenEnabled: true, autoSubmitEnabled: true }),
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
    expect(continuousSubmit?.target.modelSelection).toEqual(focus.modelSelection);
  });

  it("offers notification Thread switching only for a ready, empty, unblocked composer", () => {
    const eligible = {
      preferencesReady: true,
      composerDraftsReady: true,
      composerContentEmpty: true,
      interactionRequired: false,
      activeThreadBusy: false,
    };
    expect(canOfferThreadVoiceSwitch(eligible)).toBe(true);
    expect(canOfferThreadVoiceSwitch({ ...eligible, preferencesReady: false })).toBe(false);
    expect(canOfferThreadVoiceSwitch({ ...eligible, composerDraftsReady: false })).toBe(false);
    expect(canOfferThreadVoiceSwitch({ ...eligible, composerContentEmpty: false })).toBe(false);
    expect(canOfferThreadVoiceSwitch({ ...eligible, interactionRequired: true })).toBe(false);
    expect(canOfferThreadVoiceSwitch({ ...eligible, activeThreadBusy: true })).toBe(false);
  });

  it("offers Thread start only from Idle or connected Realtime", () => {
    const realtime = (phase: "starting" | "connected" | "stopping"): VoiceRuntimeSnapshot => ({
      mode: "realtime",
      phase,
      generation: 2,
      sequence: 8,
      target: {
        environmentId,
        conversation: { type: "new", retention: "durable", title: "Voice" },
        focus: null,
        threadSwitch: null,
      },
      muted: false,
      audioRoutes: [],
      transcript: [],
      pendingConfirmations: [],
      pendingClientActions: [],
    });

    expect(isThreadVoiceStartAvailable(realtime("connected"), false)).toBe(true);
    expect(isThreadVoiceStartAvailable(realtime("starting"), true)).toBe(false);
    expect(isThreadVoiceStartAvailable(realtime("stopping"), true)).toBe(false);
    expect(isThreadVoiceStartAvailable({ mode: "idle", generation: 3, sequence: 9 }, true)).toBe(
      true,
    );
    expect(isThreadVoiceStartAvailable({ mode: "idle", generation: 3, sequence: 9 }, false)).toBe(
      false,
    );
    expect(
      isThreadVoiceStartAvailable(
        {
          mode: "failed",
          environmentId,
          operation: "thread",
          failure: { code: "failed", message: "Failed", retryable: true },
          generation: 3,
          sequence: 9,
        },
        true,
      ),
    ).toBe(false);
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

  it("retries a transient runtime attachment failure with deterministic backoff", async () => {
    vi.useFakeTimers();
    try {
      const expected = { mode: "attached" };
      const operation = vi
        .fn(async () => expected)
        .mockRejectedValueOnce(new Error("binder unavailable"));
      const retry = createVoiceRuntimeRetryCoordinator([250]);

      const result = retry.run(operation);
      await vi.advanceTimersByTimeAsync(0);
      expect(operation).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(250);

      await expect(result).resolves.toBe(expected);
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues retrying at the capped delay until attachment recovers", async () => {
    vi.useFakeTimers();
    try {
      const expected = { mode: "attached" };
      const operation = vi
        .fn(async () => expected)
        .mockRejectedValueOnce(new Error("first failure"))
        .mockRejectedValueOnce(new Error("second failure"))
        .mockRejectedValueOnce(new Error("slow binder recovery"))
        .mockRejectedValueOnce(new Error("still recovering"))
        .mockRejectedValueOnce(new Error("final transient failure"));
      const persistentFailure = vi.fn();
      const retry = createVoiceRuntimeRetryCoordinator([10, 20], persistentFailure);

      const result = retry.run(operation);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(20);

      await expect(result).resolves.toBe(expected);
      expect(operation).toHaveBeenCalledTimes(6);
      expect(persistentFailure).toHaveBeenCalledOnce();
      expect(persistentFailure).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels retry waits and detaches an attachment that resolves after disposal", async () => {
    vi.useFakeTimers();
    try {
      const delayedOperation = vi.fn(async () => {
        throw new Error("retry");
      });
      const delayedRetry = createVoiceRuntimeRetryCoordinator([250]);
      const delayedResult = delayedRetry.run(delayedOperation);
      await vi.advanceTimersByTimeAsync(0);
      delayedRetry.cancel();
      await expect(delayedResult).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(250);
      expect(delayedOperation).toHaveBeenCalledOnce();

      let resolveSubscribe!: (detach: () => void) => void;
      const detach = vi.fn();
      const runtime = {
        adapter: {
          subscribe: vi.fn(
            () =>
              new Promise<() => void>((resolve) => {
                resolveSubscribe = resolve;
              }),
          ),
        },
      };
      const attachmentRetry = createVoiceRuntimeRetryCoordinator([]);
      const attachment = attachmentRetry.run(() =>
        prepareVoiceRuntimeAttachment({
          runtime,
          listener: () => undefined,
          isDisposed: attachmentRetry.isCancelled,
        }),
      );

      attachmentRetry.cancel();
      resolveSubscribe(detach);

      await expect(attachment).resolves.toBeNull();
      expect(detach).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
        environmentId,
        operation: "realtime",
        failure: { code: "network", message: "Network failed", retryable: true },
        generation: 2,
        sequence: 9,
      }),
    ).toBe("error");
    expect(
      voiceRuntimeSnapshotEnvironmentId({
        mode: "failed",
        environmentId,
        operation: "realtime",
        failure: { code: "network", message: "Network failed", retryable: true },
        generation: 2,
        sequence: 9,
      }),
    ).toBe(environmentId);
    expect(voiceRuntimeSnapshotEnvironmentId({ mode: "idle", generation: 3, sequence: 10 })).toBe(
      null,
    );
  });

  it("propagates stop failures so audio handoffs cannot continue", async () => {
    await expect(stopVoiceRuntimeStrict(null)).rejects.toThrow(
      "Native voice controls are unavailable",
    );
    const stop = vi.fn(async () => {
      throw new Error("binder unavailable");
    });

    await expect(stopVoiceRuntimeStrict({ adapter: { stop } })).rejects.toThrow(
      "binder unavailable",
    );
    expect(stop).toHaveBeenCalledOnce();
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

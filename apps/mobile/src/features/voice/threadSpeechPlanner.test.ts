import { describe, expect, it } from "vite-plus/test";

import {
  hydrateThreadSpeechPreference,
  initialThreadSpeechPlannerState,
  interruptThreadSpeech,
  isThreadSpeechSuspended,
  noteThreadSpeechEarlyToggle,
  planThreadSpeechToggle,
  restoreThreadSpeechPreference,
  setThreadSpeechEnabled,
  syncExternalThreadSpeechPreference,
  updateThreadSpeech,
} from "./threadSpeechPlanner";

describe("threadSpeechPlanner", () => {
  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ] as const)(
    "reports dictation=%s and realtime=%s suspension as %s",
    (dictation, realtime, expected) => {
      expect(isThreadSpeechSuspended(dictation, realtime)).toBe(expected);
    },
  );
  it("restores speech without replaying the current streaming response", () => {
    const latest = {
      id: "existing",
      text: "This part of the response was already rendered.",
      streaming: true,
    };
    const restored = restoreThreadSpeechPreference(initialThreadSpeechPlannerState(), true, latest);

    expect(restored.state).toMatchObject({
      enabled: true,
      baselineMessageId: "existing",
      active: null,
    });
    expect(updateThreadSpeech(restored.state, latest, () => "playback-1").actions).toEqual([]);
    expect(
      updateThreadSpeech(
        restored.state,
        { id: "next", text: "This response is new.", streaming: false },
        () => "playback-2",
      ).actions,
    ).toEqual([
      { type: "start", playbackId: "playback-2", messageId: "next" },
      {
        type: "segment",
        playbackId: "playback-2",
        segment: {
          index: 0,
          text: "This response is new.",
          finalSegment: true,
        },
      },
      { type: "finish", playbackId: "playback-2" },
    ]);
  });

  it("ignores the assistant message already visible when speech is enabled", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, {
      id: "old",
      text: "Already complete.",
      streaming: false,
    });

    expect(
      updateThreadSpeech(
        enabled.state,
        { id: "old", text: "Already complete.", streaming: false },
        () => "playback-1",
      ).actions,
    ).toEqual([]);
  });

  it("starts before a streaming response completes and flushes in order", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;
    const first = updateThreadSpeech(
      enabled,
      {
        id: "new",
        text: "This sentence is long enough to begin speaking. Next",
        streaming: true,
      },
      () => "playback-1",
    );
    expect(first.actions).toEqual([
      { type: "start", playbackId: "playback-1", messageId: "new" },
      {
        type: "segment",
        playbackId: "playback-1",
        segment: {
          index: 0,
          text: "This sentence is long enough to begin speaking.",
          finalSegment: false,
        },
      },
    ]);

    const completed = updateThreadSpeech(
      first.state,
      {
        id: "new",
        text: "This sentence is long enough to begin speaking. Next phrase.",
        streaming: false,
      },
      () => "unused",
    );
    expect(completed.actions).toEqual([
      {
        type: "segment",
        playbackId: "playback-1",
        segment: { index: 1, text: "Next phrase.", finalSegment: true },
      },
      { type: "finish", playbackId: "playback-1" },
    ]);
  });

  it("can attach to a response that is already streaming when enabled", () => {
    const latest = {
      id: "active",
      text: "This response is already streaming and ready to speak.",
      streaming: true,
    };
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, latest).state;
    const result = updateThreadSpeech(enabled, latest, () => "playback-1");

    expect(result.actions[0]).toEqual({
      type: "start",
      playbackId: "playback-1",
      messageId: "active",
    });
    expect(result.actions[1]).toMatchObject({
      type: "segment",
      segment: { text: latest.text },
    });
  });

  it("cancels active playback when disabled", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;
    const active = updateThreadSpeech(
      enabled,
      { id: "new", text: "Response in progress", streaming: true },
      () => "playback-1",
    ).state;

    expect(setThreadSpeechEnabled(active, false, null).actions).toEqual([
      { type: "cancel", playbackId: "playback-1" },
    ]);
  });

  it("plans one immediate cancellation without a duplicate queued cancel", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;
    const active = updateThreadSpeech(
      enabled,
      { id: "new", text: "Response in progress", streaming: true },
      () => "playback-1",
    ).state;

    expect(planThreadSpeechToggle(active, null, () => "unused")).toMatchObject({
      enabled: false,
      cancelPlaybackId: "playback-1",
      actions: [],
    });
  });

  it("interrupts the current response without disabling future spoken responses", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;
    const latest = {
      id: "current",
      text: "Response in progress",
      streaming: true,
    };
    const active = updateThreadSpeech(enabled, latest, () => "playback-1").state;

    const interrupted = interruptThreadSpeech(active, latest);

    expect(interrupted).toMatchObject({
      enabled: true,
      baselineMessageId: "current",
      active: null,
    });
    expect(updateThreadSpeech(interrupted, latest, () => "playback-2").actions).toEqual([]);
    expect(
      updateThreadSpeech(
        interrupted,
        { id: "next", text: "A later response.", streaming: false },
        () => "playback-2",
      ).actions[0],
    ).toEqual({ type: "start", playbackId: "playback-2", messageId: "next" });
  });

  it("defers response planning and preference playback while dictation is active", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;
    const latest = { id: "new", text: "A response arrived during dictation.", streaming: true };

    expect(updateThreadSpeech(enabled, latest, () => "playback-1", true)).toEqual({
      state: enabled,
      actions: [],
    });

    const disabled = planThreadSpeechToggle(enabled, latest, () => "playback-1", true);
    expect(disabled).toMatchObject({ enabled: false, actions: [] });
    const reenabled = planThreadSpeechToggle(disabled.state, latest, () => "playback-2", true);
    expect(reenabled).toMatchObject({ enabled: true, actions: [] });
    expect(updateThreadSpeech(reenabled.state, latest, () => "playback-2").actions[0]).toEqual({
      type: "start",
      playbackId: "playback-2",
      messageId: "new",
    });
  });

  it("replaces an interrupted response without dropping the new completed message", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;
    const active = updateThreadSpeech(
      enabled,
      {
        id: "first",
        text: "First response is still streaming",
        streaming: true,
      },
      () => "playback-1",
    ).state;

    const result = updateThreadSpeech(
      active,
      { id: "second", text: "Replacement response.", streaming: false },
      () => "playback-2",
    );

    expect(result.actions).toEqual([
      { type: "cancel", playbackId: "playback-1" },
      { type: "start", playbackId: "playback-2", messageId: "second" },
      {
        type: "segment",
        playbackId: "playback-2",
        segment: {
          index: 0,
          text: "Replacement response.",
          finalSegment: true,
        },
      },
      { type: "finish", playbackId: "playback-2" },
    ]);
  });

  describe("preference hydration", () => {
    const completed = {
      id: "visible",
      text: "Already on screen.",
      streaming: false,
    } as const;

    it("waits until both preferences and history are ready", () => {
      const state = initialThreadSpeechPlannerState();
      expect(
        hydrateThreadSpeechPreference(state, {
          historyReady: false,
          preferencesReady: true,
          persistedEnabled: true,
          latest: completed,
        }),
      ).toEqual({ state, actions: [], didHydrate: false });
      expect(
        hydrateThreadSpeechPreference(state, {
          historyReady: true,
          preferencesReady: false,
          persistedEnabled: true,
          latest: completed,
        }),
      ).toEqual({ state, actions: [], didHydrate: false });
    });

    it("applies a persisted preference once both gates open", () => {
      const hydrated = hydrateThreadSpeechPreference(initialThreadSpeechPlannerState(), {
        historyReady: true,
        preferencesReady: true,
        persistedEnabled: true,
        latest: completed,
      });
      expect(hydrated.didHydrate).toBe(true);
      expect(hydrated.state).toMatchObject({
        enabled: true,
        baselineMessageId: "visible",
        active: null,
        hydration: {
          preferenceHydrated: true,
          toggledBeforePreferenceHydration: false,
          earlyToggleNeedsBaseline: false,
          lastObservedPreference: true,
        },
      });
      expect(updateThreadSpeech(hydrated.state, completed, () => "playback-1").actions).toEqual([]);

      const again = hydrateThreadSpeechPreference(hydrated.state, {
        historyReady: true,
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      });
      expect(again).toEqual({ state: hydrated.state, actions: [], didHydrate: false });
    });

    it("lets an early toggle after history is ready win over the persisted value", () => {
      let state = noteThreadSpeechEarlyToggle(initialThreadSpeechPlannerState(), true);
      state = planThreadSpeechToggle(state, completed, () => "playback-1").state;
      expect(state.enabled).toBe(true);

      const hydrated = hydrateThreadSpeechPreference(state, {
        historyReady: true,
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      });
      expect(hydrated.didHydrate).toBe(true);
      expect(hydrated.actions).toEqual([]);
      expect(hydrated.state.enabled).toBe(true);
      expect(hydrated.state.hydration).toMatchObject({
        preferenceHydrated: true,
        toggledBeforePreferenceHydration: true,
        earlyToggleNeedsBaseline: false,
        lastObservedPreference: null,
      });
    });

    it("baselines the visible message when the user toggles before history is ready", () => {
      let state = noteThreadSpeechEarlyToggle(initialThreadSpeechPlannerState(), false);
      state = planThreadSpeechToggle(state, null, () => "playback-1").state;
      expect(state.enabled).toBe(true);
      expect(state.hydration.earlyToggleNeedsBaseline).toBe(true);

      const hydrated = hydrateThreadSpeechPreference(state, {
        historyReady: true,
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      });
      expect(hydrated.state).toMatchObject({
        enabled: true,
        baselineMessageId: "visible",
        active: null,
        hydration: {
          preferenceHydrated: true,
          lastObservedPreference: false,
        },
      });
      expect(updateThreadSpeech(hydrated.state, completed, () => "playback-1").actions).toEqual([]);
    });

    it("keeps the final early-toggle intent when the user toggles twice", () => {
      let state = noteThreadSpeechEarlyToggle(initialThreadSpeechPlannerState(), true);
      state = planThreadSpeechToggle(state, completed, () => "playback-1").state;
      state = noteThreadSpeechEarlyToggle(state, true);
      state = planThreadSpeechToggle(state, completed, () => "playback-2").state;
      expect(state.enabled).toBe(false);

      const hydrated = hydrateThreadSpeechPreference(state, {
        historyReady: true,
        preferencesReady: true,
        persistedEnabled: true,
        latest: completed,
      });
      expect(hydrated.state.enabled).toBe(false);
    });

    it("synchronizes external preference changes after hydration", () => {
      const hydrated = hydrateThreadSpeechPreference(initialThreadSpeechPlannerState(), {
        historyReady: true,
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      }).state;

      const same = syncExternalThreadSpeechPreference(hydrated, {
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      });
      expect(same.kind).toBe("none");

      const enable = syncExternalThreadSpeechPreference(same.state, {
        preferencesReady: true,
        persistedEnabled: true,
        latest: completed,
      });
      expect(enable.kind).toBe("enable");
      expect(enable.state.enabled).toBe(true);

      const disable = syncExternalThreadSpeechPreference(enable.state, {
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      });
      expect(disable.kind).toBe("disable_no_persist");
      expect(disable.state.enabled).toBe(true);
      expect(disable.state.hydration.lastObservedPreference).toBe(false);
    });

    it("seeds lastObserved without applying when early-toggle skipped restore", () => {
      let state = noteThreadSpeechEarlyToggle(initialThreadSpeechPlannerState(), true);
      state = planThreadSpeechToggle(state, completed, () => "playback-1").state;
      state = hydrateThreadSpeechPreference(state, {
        historyReady: true,
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      }).state;
      expect(state.hydration.lastObservedPreference).toBeNull();

      const seeded = syncExternalThreadSpeechPreference(state, {
        preferencesReady: true,
        persistedEnabled: false,
        latest: completed,
      });
      expect(seeded.kind).toBe("none");
      expect(seeded.state.hydration.lastObservedPreference).toBe(false);
      expect(seeded.state.enabled).toBe(true);
    });
  });
});

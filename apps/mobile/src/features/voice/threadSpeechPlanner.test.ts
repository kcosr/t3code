import { describe, expect, it } from "vite-plus/test";

import {
  initialThreadSpeechPlannerState,
  interruptThreadSpeech,
  planThreadSpeechToggle,
  restoreThreadSpeechPreference,
  setThreadSpeechEnabled,
  updateThreadSpeech,
} from "./threadSpeechPlanner";

describe("threadSpeechPlanner", () => {
  it("restores speech without replaying the current streaming response", () => {
    const latest = {
      id: "existing",
      text: "This part of the response was already rendered.",
      streaming: true,
    };
    const restored = restoreThreadSpeechPreference(initialThreadSpeechPlannerState(), true, latest);

    expect(restored.state).toEqual({
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
      { type: "start", playbackId: "playback-2" },
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
      { type: "start", playbackId: "playback-1" },
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

    expect(interrupted).toEqual({
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
    ).toEqual({ type: "start", playbackId: "playback-2" });
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
      { type: "start", playbackId: "playback-2" },
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
});

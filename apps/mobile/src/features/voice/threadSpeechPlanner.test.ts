import { describe, expect, it } from "vite-plus/test";

import {
  initialThreadSpeechPlannerState,
  planThreadSpeechToggle,
  setThreadSpeechEnabled,
  updateThreadSpeech,
} from "./threadSpeechPlanner";

describe("threadSpeechPlanner", () => {
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

    expect(result.actions[0]).toEqual({ type: "start", playbackId: "playback-1" });
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

  it("replaces an interrupted response without dropping the new completed message", () => {
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;
    const active = updateThreadSpeech(
      enabled,
      { id: "first", text: "First response is still streaming", streaming: true },
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
        segment: { index: 0, text: "Replacement response.", finalSegment: true },
      },
      { type: "finish", playbackId: "playback-2" },
    ]);
  });
});

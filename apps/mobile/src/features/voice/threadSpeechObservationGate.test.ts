import { describe, expect, it } from "vitest";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  LOCAL_THREAD_SPEECH_ANCHOR_MILLIS,
  ThreadSpeechObservationGate,
  type ThreadSpeechObservation,
} from "./threadSpeechObservationGate";
import {
  initialThreadSpeechPlannerState,
  observeThreadSpeechHistorically,
  setThreadSpeechEnabled,
  updateThreadSpeech,
} from "./threadSpeechPlanner";

const assistant = (id: string, turnId: string | null = "turn-1"): ThreadSpeechObservation => ({
  id,
  text: "response",
  streaming: true,
  turnId,
});

const message = (
  id: string,
  role: "user" | "assistant",
  turnId: string | null = "turn-1",
): ThreadFeedEntry =>
  ({
    type: "message",
    id,
    createdAt: "2026-07-14T00:00:00.000Z",
    message: {
      id,
      role,
      text: role === "user" ? "question" : "response",
      turnId,
      streaming: role === "assistant",
    },
  }) as ThreadFeedEntry;

const observe = (
  gate: ThreadSpeechObservationGate,
  input: {
    latestAssistant: ThreadSpeechObservation | null;
    feed?: ReadonlyArray<ThreadFeedEntry>;
    syncStatus?: "empty" | "cached" | "synchronizing" | "live" | "deleted";
    nativeAssistantMessageIds?: ReadonlySet<string>;
    monotonicMillis?: number;
  },
) => {
  const decision = gate.previewAutomaticPlayback({
    scopeKey: "environment:thread",
    syncStatus: input.syncStatus ?? "live",
    latestAssistant: input.latestAssistant,
    feed: input.feed ?? [],
    nativeAssistantMessageIds: input.nativeAssistantMessageIds ?? new Set(),
    monotonicMillis: input.monotonicMillis ?? 0,
  });
  decision.commit();
  return decision.automaticPlaybackEligible;
};

describe("ThreadSpeechObservationGate", () => {
  it("permanently treats the initial live projection as historical", () => {
    const gate = new ThreadSpeechObservationGate();
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];

    expect(observe(gate, { latestAssistant: projected, feed })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 1);
    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 2 })).toBe(false);
  });

  it("baselines messages first observed from cache or a gap rebase", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 1);
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];

    expect(
      observe(gate, {
        latestAssistant: projected,
        feed,
        syncStatus: "synchronizing",
        monotonicMillis: 2,
      }),
    ).toBe(false);
    expect(
      observe(gate, { latestAssistant: projected, feed, syncStatus: "live", monotonicMillis: 3 }),
    ).toBe(false);
  });

  it("allows only a response following a fresh local command anchor", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 100);
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];

    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 101 })).toBe(true);
    expect(
      observe(gate, {
        latestAssistant: { ...projected, text: "response continued" },
        feed,
        monotonicMillis: LOCAL_THREAD_SPEECH_ANCHOR_MILLIS + 1_000,
      }),
    ).toBe(true);
    expect(
      observe(gate, {
        latestAssistant: assistant("assistant-2", "turn-2"),
        feed: [...feed, message("assistant-2", "assistant", "turn-2")],
        monotonicMillis: 102,
      }),
    ).toBe(false);
  });

  it("rejects stale and mismatched local command anchors", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 10);
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];
    expect(
      observe(gate, {
        latestAssistant: assistant("assistant-1"),
        feed,
        monotonicMillis: 10 + LOCAL_THREAD_SPEECH_ANCHOR_MILLIS + 1,
      }),
    ).toBe(false);

    gate.recordLocalCommand("environment:thread", "user-2", 1_000_000);
    const mismatch = [
      message("user-2", "user", "turn-2"),
      message("assistant-2", "assistant", "turn-3"),
    ];
    expect(
      observe(gate, {
        latestAssistant: assistant("assistant-2", "turn-3"),
        feed: mismatch,
        monotonicMillis: 1_000_001,
      }),
    ).toBe(false);
  });

  it("requires exact projected turn provenance for the local command", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 10);
    const feed = [message("user-1", "user", null), message("assistant-1", "assistant", null)];

    expect(
      observe(gate, {
        latestAssistant: assistant("assistant-1", null),
        feed,
        monotonicMillis: 11,
      }),
    ).toBe(false);
  });

  it("closes projection-before-receipt races without reviving historical speech", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    const projected = assistant("native-assistant");
    const feed = [message("native-user", "user"), message("native-assistant", "assistant")];

    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 10 })).toBe(false);
    expect(
      observe(gate, {
        latestAssistant: projected,
        feed,
        nativeAssistantMessageIds: new Set(["native-assistant"]),
        monotonicMillis: 11,
      }),
    ).toBe(false);
  });

  it("stops eligibility if a native receipt lands after local projection", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 10);
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];
    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 11 })).toBe(true);
    expect(
      observe(gate, {
        latestAssistant: projected,
        feed,
        nativeAssistantMessageIds: new Set(["assistant-1"]),
        monotonicMillis: 12,
      }),
    ).toBe(false);
    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 13 })).toBe(false);
  });

  it("cancels planned React playback when a native receipt closes the projection race", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 10);
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];
    const enabled = setThreadSpeechEnabled(initialThreadSpeechPlannerState(), true, null).state;

    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 11 })).toBe(true);
    const planned = updateThreadSpeech(enabled, projected, () => "playback-1");
    expect(planned.actions[0]).toEqual({
      type: "start",
      playbackId: "playback-1",
      messageId: "assistant-1",
    });

    expect(
      observe(gate, {
        latestAssistant: projected,
        feed,
        nativeAssistantMessageIds: new Set(["assistant-1"]),
        monotonicMillis: 12,
      }),
    ).toBe(false);
    expect(observeThreadSpeechHistorically(planned.state, projected).actions).toEqual([
      { type: "cancel", playbackId: "playback-1" },
    ]);
  });

  it("does not consume a local anchor when a render is interrupted", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 10);
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];

    const interrupted = gate.previewAutomaticPlayback({
      scopeKey: "environment:thread",
      syncStatus: "live",
      latestAssistant: projected,
      feed,
      nativeAssistantMessageIds: new Set(),
      monotonicMillis: 11,
    });
    expect(interrupted.automaticPlaybackEligible).toBe(true);

    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 12 })).toBe(true);
  });

  it("commits Strict Mode effect replays idempotently", () => {
    const gate = new ThreadSpeechObservationGate();
    const baseline = gate.previewAutomaticPlayback({
      scopeKey: "environment:thread",
      syncStatus: "live",
      latestAssistant: null,
      feed: [],
      nativeAssistantMessageIds: new Set(),
      monotonicMillis: 1,
    });
    baseline.commit();
    baseline.commit();

    gate.recordLocalCommand("environment:thread", "user-1", 10);
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];
    const response = gate.previewAutomaticPlayback({
      scopeKey: "environment:thread",
      syncStatus: "live",
      latestAssistant: projected,
      feed,
      nativeAssistantMessageIds: new Set(),
      monotonicMillis: 11,
    });
    expect(response.automaticPlaybackEligible).toBe(true);
    response.commit();
    response.commit();

    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 12 })).toBe(true);
  });

  it("does not let an interrupted receipt projection mutate the committed classification", () => {
    const gate = new ThreadSpeechObservationGate();
    expect(observe(gate, { latestAssistant: null })).toBe(false);
    gate.recordLocalCommand("environment:thread", "user-1", 10);
    const projected = assistant("assistant-1");
    const feed = [message("user-1", "user"), message("assistant-1", "assistant")];

    const interrupted = gate.previewAutomaticPlayback({
      scopeKey: "environment:thread",
      syncStatus: "live",
      latestAssistant: projected,
      feed,
      nativeAssistantMessageIds: new Set(["assistant-1"]),
      monotonicMillis: 11,
    });
    expect(interrupted.automaticPlaybackEligible).toBe(false);

    expect(observe(gate, { latestAssistant: projected, feed, monotonicMillis: 12 })).toBe(true);
  });
});

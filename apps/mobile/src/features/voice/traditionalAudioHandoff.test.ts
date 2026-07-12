import type { T3VoiceRuntimeState } from "@t3tools/mobile-voice-native";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  dictationResumeTransition,
  releasePlaybackForRecording,
  runExclusiveTraditionalAudioTransition,
  startDictationWithAudioHandoff,
} from "./traditionalAudioHandoff";

const idleState = (): T3VoiceRuntimeState => ({
  phase: "idle",
  isForeground: false,
  activeRecordingId: null,
  activePlaybackId: null,
  activeRealtimeSessionId: null,
  realtimeConnectionState: null,
  realtimeMuted: false,
  sequence: 1,
});

describe("releasePlaybackForRecording", () => {
  it("waits for a pending playback start before cancelling it", async () => {
    let resolveStart: (() => void) | undefined;
    const pendingStart = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const cancelPlaybackAsync = vi.fn(async () => undefined);
    const release = releasePlaybackForRecording({
      native: { cancelPlaybackAsync, getStateAsync: async () => idleState() },
      playbackId: "playback-1",
      pendingStart,
    });

    await Promise.resolve();
    expect(cancelPlaybackAsync).not.toHaveBeenCalled();
    resolveStart?.();
    await release;

    expect(cancelPlaybackAsync).toHaveBeenCalledWith({ playbackId: "playback-1" });
  });

  it("accepts a cancellation race only after native playback is idle", async () => {
    await expect(
      releasePlaybackForRecording({
        native: {
          cancelPlaybackAsync: async () => {
            throw new Error("Playback already completed");
          },
          getStateAsync: async () => idleState(),
        },
        playbackId: "playback-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects while playback still owns the native runtime", async () => {
    const busy = { ...idleState(), phase: "playing" as const, activePlaybackId: "playback-1" };

    await expect(
      releasePlaybackForRecording({
        native: {
          cancelPlaybackAsync: async () => {
            throw new Error("Cancellation failed");
          },
          getStateAsync: async () => busy,
        },
        playbackId: "playback-1",
      }),
    ).rejects.toThrow("Cancellation failed");
  });

  it("bounds a playback start that never settles", async () => {
    await expect(
      releasePlaybackForRecording({
        native: {
          cancelPlaybackAsync: async () => undefined,
          getStateAsync: async () => idleState(),
        },
        playbackId: "playback-1",
        pendingStart: new Promise(() => undefined),
        timeoutMs: 10,
      }),
    ).rejects.toThrow("timed out");
  });
});

describe("runExclusiveTraditionalAudioTransition", () => {
  it("ignores a second microphone transition while the first is pending", async () => {
    const lock = { active: false };
    let finish: (() => void) | undefined;
    const transition = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const first = runExclusiveTraditionalAudioTransition(lock, transition);
    await expect(runExclusiveTraditionalAudioTransition(lock, transition)).resolves.toBe(false);
    expect(transition).toHaveBeenCalledTimes(1);
    finish?.();
    await expect(first).resolves.toBe(true);
    expect(lock.active).toBe(false);
  });
});

describe("traditional audio handoff coordination", () => {
  it("awaits realtime and playback release before starting dictation", async () => {
    const order: string[] = [];
    const started = await startDictationWithAudioHandoff({
      stopRealtime: async () => {
        order.push("realtime-stopped");
      },
      interruptPlayback: async () => {
        order.push("playback-interrupted");
        return true;
      },
      startDictation: async () => {
        order.push("dictation-started");
        return true;
      },
      resumePlayback: () => order.push("playback-resumed"),
    });

    expect(started).toBe(true);
    expect(order).toEqual(["realtime-stopped", "playback-interrupted", "dictation-started"]);
  });

  it("resumes playback exactly once when dictation fails to start", async () => {
    const resumePlayback = vi.fn();
    await expect(
      startDictationWithAudioHandoff({
        stopRealtime: async () => undefined,
        interruptPlayback: async () => true,
        startDictation: async () => false,
        resumePlayback,
      }),
    ).resolves.toBe(false);
    expect(resumePlayback).toHaveBeenCalledTimes(1);
  });

  it("resumes once when active dictation returns to idle", () => {
    const recording = dictationResumeTransition(false, "recording");
    const transcribing = dictationResumeTransition(recording.wasActive, "transcribing");
    const idle = dictationResumeTransition(transcribing.wasActive, "idle");
    const repeatedIdle = dictationResumeTransition(idle.wasActive, "idle");

    expect(recording).toEqual({ wasActive: true, resume: false });
    expect(transcribing).toEqual({ wasActive: true, resume: false });
    expect(idle).toEqual({ wasActive: false, resume: true });
    expect(repeatedIdle).toEqual({ wasActive: false, resume: false });
  });
});

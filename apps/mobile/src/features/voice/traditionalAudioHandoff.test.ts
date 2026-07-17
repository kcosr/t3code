import type { T3VoiceNativeModule, T3VoiceRuntimeState } from "@t3tools/mobile-voice-native";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  dictationResumeTransition,
  interruptTraditionalAudioForRealtime,
  releaseRecordingForRealtime,
  releasePlaybackForRecording,
  startDictationWithAudioHandoff,
} from "./traditionalAudioHandoff";

const idleState = (): T3VoiceRuntimeState => ({
  phase: "idle",
  isForeground: false,
  activeRecordingId: null,
  activePlaybackId: null,
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

describe("traditional audio handoff coordination", () => {
  it("releases dictation and playback in order before Realtime starts", async () => {
    const calls: string[] = [];

    await interruptTraditionalAudioForRealtime({
      cancelDictation: async () => {
        calls.push("dictation");
      },
      interruptPlayback: async () => {
        calls.push("playback");
        return true;
      },
      rollback: () => calls.push("rollback"),
    });

    expect(calls).toEqual(["dictation", "playback"]);
  });

  it("rejects Realtime startup when playback ownership cannot be released", async () => {
    const rollback = vi.fn();
    await expect(
      interruptTraditionalAudioForRealtime({
        cancelDictation: async () => undefined,
        interruptPlayback: async () => false,
        rollback,
      }),
    ).rejects.toThrow("Traditional voice playback could not be interrupted");
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("does not touch playback when dictation ownership cannot be released", async () => {
    const interruptPlayback = vi.fn(async () => true);
    const rollback = vi.fn();

    await expect(
      interruptTraditionalAudioForRealtime({
        cancelDictation: async () => {
          throw new Error("Recorder still active");
        },
        interruptPlayback,
        rollback,
      }),
    ).rejects.toThrow("Recorder still active");
    expect(interruptPlayback).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("waits for pending recording operations before verifying microphone release", async () => {
    const order: string[] = [];
    let settleStart!: () => void;
    let settleStop!: () => void;
    const pendingStart = new Promise<void>((resolve) => {
      settleStart = resolve;
    });
    const pendingStop = new Promise<void>((resolve) => {
      settleStop = resolve;
    });
    const native = {
      cancelRecordingAsync: async () => order.push("cancel"),
      getStateAsync: async () => {
        order.push("verify");
        return { phase: "idle", activeRecordingId: null };
      },
    } as unknown as T3VoiceNativeModule;
    const release = releaseRecordingForRealtime({
      native,
      pendingStart,
      pendingStop,
      getRecordingId: () => null,
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    settleStart();
    await Promise.resolve();
    expect(order).toEqual([]);
    settleStop();
    await release;
    expect(order).toEqual(["verify"]);
  });

  it("rejects realtime acquisition while the native recorder still owns the microphone", async () => {
    const native = {
      cancelRecordingAsync: async () => undefined,
      getStateAsync: async () => ({ phase: "recording", activeRecordingId: "recording-a" }),
    } as unknown as T3VoiceNativeModule;

    await expect(
      releaseRecordingForRealtime({
        native,
        pendingStart: null,
        pendingStop: null,
        getRecordingId: () => "recording-a",
      }),
    ).rejects.toThrow("Traditional voice recording could not be interrupted");
  });

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

  it("does not continue a dictation handoff when native voice fails to stop", async () => {
    const interruptPlayback = vi.fn(async () => true);
    const startDictation = vi.fn(async () => true);

    await expect(
      startDictationWithAudioHandoff({
        stopRealtime: async () => {
          throw new Error("native media is still active");
        },
        interruptPlayback,
        startDictation,
        resumePlayback: vi.fn(),
      }),
    ).rejects.toThrow("native media is still active");
    expect(interruptPlayback).not.toHaveBeenCalled();
    expect(startDictation).not.toHaveBeenCalled();
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

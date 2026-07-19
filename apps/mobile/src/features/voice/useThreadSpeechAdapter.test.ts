import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isAndroidThreadPlaybackForScope,
  makeAndroidThreadSpeechCommands,
  selectThreadSpeechImplementation,
  startReactThreadPlayback,
} from "./threadSpeechAdapterPolicy";

describe("Thread speech platform adapter", () => {
  it("selects native authority for Android without a React fallback", () => {
    expect(selectThreadSpeechImplementation("android")).toBe("android-native");
    expect(selectThreadSpeechImplementation("ios")).toBe("react");
    expect(selectThreadSpeechImplementation("web")).toBe("react");
  });

  it("matches native playback to the exact environment-scoped Thread key", () => {
    const playback = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-1"),
      phase: "playing" as const,
    };

    expect(isAndroidThreadPlaybackForScope(playback, "environment-a:thread-1")).toBe(true);
    expect(isAndroidThreadPlaybackForScope(playback, "environment-b:thread-1")).toBe(false);
    expect(isAndroidThreadPlaybackForScope(playback, "prefix-thread-1")).toBe(false);
  });

  it("never enters the generic PCM playback API on Android", async () => {
    const startPlaybackAsync = vi.fn(async () => undefined);
    const skipThreadPlaybackAsync = vi.fn(async () => undefined);
    const saveEnabled = vi.fn();
    const reportError = vi.fn();
    const native = { skipThreadPlaybackAsync, startPlaybackAsync };
    const commands = makeAndroidThreadSpeechCommands({
      native,
      saveEnabled,
      reportError,
    });

    commands.setEnabled(true);
    await commands.interrupt();
    await commands.interruptForRealtime();

    expect(saveEnabled).toHaveBeenCalledWith(true);
    expect(skipThreadPlaybackAsync).toHaveBeenCalledTimes(1);
    expect(startPlaybackAsync).not.toHaveBeenCalled();
  });

  it("keeps the non-Android React adapter connected to generic PCM playback", async () => {
    const startPlaybackAsync = vi.fn(async () => undefined);
    expect(selectThreadSpeechImplementation("web")).toBe("react");

    await startReactThreadPlayback(
      { startPlaybackAsync },
      { playbackId: "playback-web", sampleRate: 24_000, channelCount: 1 },
    );

    expect(startPlaybackAsync).toHaveBeenCalledWith({
      playbackId: "playback-web",
      sampleRate: 24_000,
      channelCount: 1,
    });
  });

  it("treats an inactive native Thread cycle as an idempotent interrupt", async () => {
    const skipThreadPlaybackAsync = vi.fn(async () => {
      throw Object.assign(new Error("The voice command is not valid in the current state."), {
        code: "voice-runtime-invalid-state",
      });
    });
    const reportError = vi.fn();
    const commands = makeAndroidThreadSpeechCommands({
      native: { skipThreadPlaybackAsync },
      saveEnabled: vi.fn(),
      reportError,
    });

    await expect(commands.interrupt()).resolves.toBe(true);
    expect(reportError).toHaveBeenLastCalledWith(null);
  });

  it("reports genuine native interrupt failures", async () => {
    const failure = Object.assign(new Error("Native service disconnected."), {
      code: "voice-runtime-command-failed",
    });
    const reportError = vi.fn();
    const commands = makeAndroidThreadSpeechCommands({
      native: { skipThreadPlaybackAsync: vi.fn(async () => Promise.reject(failure)) },
      saveEnabled: vi.fn(),
      reportError,
    });

    await expect(commands.interrupt()).resolves.toBe(false);
    expect(reportError).toHaveBeenLastCalledWith(failure.message);
  });

  it("leaves Thread teardown to the native Realtime transition", async () => {
    const skipThreadPlaybackAsync = vi.fn(async () => undefined);
    const commands = makeAndroidThreadSpeechCommands({
      native: { skipThreadPlaybackAsync },
      saveEnabled: vi.fn(),
      reportError: vi.fn(),
    });

    await expect(commands.interruptForRealtime()).resolves.toBe(true);
    expect(skipThreadPlaybackAsync).not.toHaveBeenCalled();
  });
});

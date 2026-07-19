import type { VoiceRuntimeSnapshot, VoiceThreadPhase } from "@t3tools/client-runtime/voice";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { NativeThreadResponsePreferenceSync } from "./nativeThreadResponsePreference";

const threadSnapshot = (
  phase: VoiceThreadPhase,
  playResponses: boolean,
  generation = 4,
): VoiceRuntimeSnapshot => ({
  mode: "thread",
  phase,
  generation,
  sequence: generation,
  target: {
    environmentId: EnvironmentId.make("environment-voice"),
    projectId: ProjectId.make("project-voice"),
    threadId: ThreadId.make("thread-voice"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  settings: {
    submission: "auto-submit",
    playResponses,
    autoRearm: true,
    endpointDetection: {
      endSilenceMs: 900,
      noSpeechTimeoutMs: 8_000,
      maximumUtteranceMs: 60_000,
    },
    rearmDelayMs: 400,
    transcriptionTimeoutMs: 30_000,
    submissionTimeoutMs: 30_000,
    responseTimeoutMs: 120_000,
  },
  transcript: null,
  reviewId: null,
  attention: null,
});

describe("VoiceRuntimeProvider native Thread response preference sync", () => {
  it.each([
    { phase: "waiting" as const, current: false, desired: true },
    { phase: "playing" as const, current: true, desired: false },
  ])(
    "updates an active $phase cycle without a Thread screen consumer",
    async ({ phase, current, desired }) => {
      let snapshot = threadSnapshot(phase, current);
      const updateThreadPlayResponsesAsync = vi.fn(async ({ playResponses }) => {
        snapshot = threadSnapshot(phase, playResponses);
      });
      const sync = new NativeThreadResponsePreferenceSync({
        native: { updateThreadPlayResponsesAsync },
        getSnapshot: () => snapshot,
      });

      await sync.synchronize(desired);

      expect(updateThreadPlayResponsesAsync).toHaveBeenCalledWith({
        expectedGeneration: 4,
        playResponses: desired,
      });
    },
  );

  it("drops a queued preference operation after the native generation changes", async () => {
    let snapshot = threadSnapshot("waiting", false, 4);
    const updateThreadPlayResponsesAsync = vi.fn(async () => undefined);
    const sync = new NativeThreadResponsePreferenceSync({
      native: { updateThreadPlayResponsesAsync },
      getSnapshot: () => snapshot,
    });

    const pending = sync.synchronize(true);
    snapshot = threadSnapshot("waiting", false, 5);
    await pending;

    expect(updateThreadPlayResponsesAsync).not.toHaveBeenCalled();
  });

  it("does not retarget queued work to the replacement generation", async () => {
    let snapshot = threadSnapshot("waiting", false, 4);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstUpdate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const updateThreadPlayResponsesAsync = vi
      .fn<(input: { expectedGeneration: number; playResponses: boolean }) => Promise<void>>()
      .mockImplementationOnce(async () => {
        markFirstStarted();
        return firstUpdate;
      })
      .mockImplementation(async () => undefined);
    const sync = new NativeThreadResponsePreferenceSync({
      native: { updateThreadPlayResponsesAsync },
      getSnapshot: () => snapshot,
    });

    const first = sync.synchronize(true);
    await firstStarted;
    const second = sync.synchronize(true);
    snapshot = threadSnapshot("waiting", false, 5);
    releaseFirst();
    await Promise.all([first, second]);

    expect(updateThreadPlayResponsesAsync).toHaveBeenCalledTimes(1);
    expect(updateThreadPlayResponsesAsync).toHaveBeenCalledWith({
      expectedGeneration: 4,
      playResponses: true,
    });
  });
});

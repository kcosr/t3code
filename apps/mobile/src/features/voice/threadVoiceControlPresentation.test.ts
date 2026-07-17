import type { VoiceRuntimeSnapshot } from "@t3tools/client-runtime/voice";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { threadVoiceControlPresentation } from "./threadVoiceControlPresentation";

const idle: VoiceRuntimeSnapshot = { mode: "idle", generation: 0, sequence: 0 };
const threadSnapshot = (phase: "recording" | "waiting"): VoiceRuntimeSnapshot => ({
  mode: "thread",
  phase,
  generation: 1,
  sequence: 1,
  target: {
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("openai"), model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  settings: {
    submission: "auto-submit",
    playResponses: true,
    autoRearm: true,
    endpointDetection: {
      endSilenceMs: 1_000,
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

describe("threadVoiceControlPresentation", () => {
  it("presents the inactive control as a start command", () => {
    expect(threadVoiceControlPresentation(idle, false)).toEqual({
      active: false,
      command: "start",
      accessibilityLabel: "Start Auto Listen",
      icon: "waveform",
    });
  });

  it("presents recording as the native finish command", () => {
    expect(threadVoiceControlPresentation(threadSnapshot("recording"), true)).toMatchObject({
      command: "finish-recording",
      accessibilityLabel: "Finish Thread voice recording",
      icon: "checkmark",
    });
  });

  it("presents every other active phase as the native stop command", () => {
    expect(threadVoiceControlPresentation(threadSnapshot("waiting"), true)).toMatchObject({
      command: "stop",
      accessibilityLabel: "Stop Thread voice",
      icon: "stop.fill",
    });
  });
});

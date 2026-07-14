import { describe, expect, it } from "vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
  VoiceThreadTurnOperationId,
  VoiceTurnClientOperationId,
  type VoiceRuntimeSnapshot,
  type VoiceThreadOperationPhase,
} from "@t3tools/contracts";

import {
  canonicalVoiceViewModel,
  voiceFocusIntent,
  voiceMuteIntent,
  voiceRouteIntent,
  voiceStartIntent,
  voiceStopIntent,
  voiceWaveformIntent,
} from "./canonicalVoiceViewModel";

const runtimeId = VoiceRuntimeId.make("runtime-1");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("instance-1");
const environmentId = EnvironmentId.make("environment-1");
const conversationId = VoiceConversationId.make("conversation-1");
const realtimeModeSessionId = VoiceModeSessionId.make("mode-1");
const threadModeSessionId = VoiceModeSessionId.make("thread-mode-1");
const threadTurnClientOperationId = VoiceTurnClientOperationId.make("client-turn-1");

const baseSnapshot: VoiceRuntimeSnapshot = {
  runtimeId,
  runtimeInstanceId,
  generation: 4,
  sequence: 8,
  availability: "ready",
  target: {
    mode: "realtime",
    environmentId,
    conversationId,
  },
  operation: {
    kind: "realtime",
    modeSessionId: realtimeModeSessionId,
    phase: "connected",
    conversationId,
    sessionId: VoiceSessionId.make("session-1"),
    muted: false,
  },
  mediaOwner: { kind: "realtime-peer", modeSessionId: realtimeModeSessionId },
  readiness: { state: "active", mode: "realtime" },
  route: { inputRouteId: "system", outputRouteId: "speaker" },
  failure: null,
};

const realtimePhases = [
  ["preparing", "starting", "Preparing voice", true],
  ["negotiating", "starting", "Connecting", true],
  ["cueing", "starting", "Voice ready", true],
  ["connected", "connected", "Voice active", true],
  ["draining", "stopping", "Finishing voice response", true],
  ["stopping", "stopping", "Ending voice", true],
  ["retrying", "starting", "Reconnecting", true],
  ["recovering", "starting", "Restoring voice", true],
  ["completed", "completed", "Voice ended", false],
  ["failed", "failed", "Voice failed", false],
  ["cancelled", "cancelled", "Voice cancelled", false],
] as const;

const threadPhases = [
  ["arming", "starting", "Starting microphone", true],
  ["recording", "listening", "Listening", true],
  ["finalizing", "working", "Finishing recording", true],
  ["uploading", "working", "Uploading audio", true],
  ["transcribing", "working", "Transcribing", true],
  ["dispatching", "working", "Sending message", true],
  ["waiting", "working", "Agent working", true],
  ["playing", "speaking", "Speaking response", true],
  ["playback-drained", "working", "Response finished", true],
  ["guarding", "working", "Waiting to listen", true],
  ["rearming", "starting", "Starting microphone", true],
  ["draft-ready", "completed", "Draft ready", false],
  ["retrying", "working", "Retrying voice", true],
  ["recovering", "working", "Restoring voice", true],
  ["completed", "completed", "Voice turn complete", false],
  ["failed", "failed", "Voice turn failed", false],
  ["cancelled", "cancelled", "Voice turn cancelled", false],
] as const;

function realtimeSnapshot(phase: (typeof realtimePhases)[number][0]): VoiceRuntimeSnapshot {
  return {
    ...baseSnapshot,
    operation: {
      kind: "realtime",
      modeSessionId: realtimeModeSessionId,
      phase,
      conversationId,
      sessionId: VoiceSessionId.make("session-1"),
      muted: false,
    },
  };
}

function threadSnapshot(
  phase: VoiceThreadOperationPhase,
  mediaOwner: VoiceRuntimeSnapshot["mediaOwner"] = { kind: "none" },
): VoiceRuntimeSnapshot {
  return {
    ...baseSnapshot,
    target: {
      mode: "thread",
      environmentId,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      speechPreset: "default",
      autoRearm: true,
      endpointPolicy: {
        endSilenceMs: 2_200,
        noSpeechTimeoutMs: null,
        maximumUtteranceMs: 3_600_000,
      },
      speechEnabled: true,
      rearmGuardMs: 2_000,
    },
    operation: {
      kind: "thread-turn",
      modeSessionId: threadModeSessionId,
      phase,
      turnClientOperationId: threadTurnClientOperationId,
      turnOperationId: VoiceThreadTurnOperationId.make("server-turn-1"),
    },
    mediaOwner,
    readiness: { state: "active", mode: "thread" },
  };
}

const waveformStart = {
  modeSessionId: VoiceModeSessionId.make("next-thread-mode"),
  turnClientOperationId: VoiceTurnClientOperationId.make("next-client-turn"),
  submissionPolicy: "auto-submit",
  draftContext: null,
  interruptionPolicy: "drain-conflicting",
} as const;

describe("canonicalVoiceViewModel", () => {
  it.each(realtimePhases)("maps Realtime %s to %s", (phase, uiPhase, label, active) => {
    expect(canonicalVoiceViewModel(realtimeSnapshot(phase))).toMatchObject({
      mode: "realtime",
      operationPhase: phase,
      uiPhase,
      label,
      active,
      muted: false,
      target: baseSnapshot.target,
      attention: null,
    });
  });

  it.each(threadPhases)("maps Thread %s to %s", (phase, uiPhase, label, active) => {
    expect(canonicalVoiceViewModel(threadSnapshot({ phase }))).toMatchObject({
      mode: "thread",
      operationPhase: phase,
      uiPhase,
      label,
      active,
      muted: false,
      attention: null,
    });
  });

  it.each([
    ["user", "Voice paused"],
    ["authority", "Waiting for voice access"],
    ["network", "Waiting for network"],
  ] as const)("projects paused reason %s", (reason, label) => {
    expect(canonicalVoiceViewModel(threadSnapshot({ phase: "paused", reason }))).toMatchObject({
      uiPhase: "paused",
      label,
      active: true,
      attention: { kind: "paused", reason, label },
    });
  });

  it.each([
    ["approval", "Approval required"],
    ["user-input", "Input required"],
    ["inaccessible-target", "Open T3 to continue"],
    ["draft-review", "Review voice draft"],
  ] as const)("projects attention reason %s", (reason, label) => {
    expect(
      canonicalVoiceViewModel(threadSnapshot({ phase: "attention-required", reason })),
    ).toMatchObject({
      uiPhase: "attention",
      label,
      active: true,
      attention: { kind: "required", reason, label },
    });
  });

  it("projects media ownership independently from operation phase", () => {
    expect(
      canonicalVoiceViewModel(
        threadSnapshot(
          { phase: "waiting" },
          { kind: "recorder", owner: "thread-mode", root: { kind: "none" } },
        ),
      ).media,
    ).toMatchObject({
      busy: true,
      microphoneActive: true,
      playbackActive: false,
      realtimePeerActive: false,
      cueActive: false,
    });
    expect(
      canonicalVoiceViewModel(
        threadSnapshot(
          { phase: "playing" },
          { kind: "player", owner: "thread-mode", root: { kind: "none" } },
        ),
      ).media,
    ).toMatchObject({ microphoneActive: false, playbackActive: true });
  });

  it("preserves sanitized failure details without synthesizing an error", () => {
    const failure = {
      code: "network-unavailable",
      message: "Voice network is unavailable.",
      retryable: true,
      occurredAt: "2026-07-14T00:00:00.000Z",
    } as const;
    const failed = {
      ...realtimeSnapshot("failed"),
      failure,
    } as VoiceRuntimeSnapshot;
    expect(canonicalVoiceViewModel(failed).error).toEqual(failure);
    expect(canonicalVoiceViewModel(realtimeSnapshot("failed")).error).toBeNull();
  });

  it("projects the canonical idle state even when readiness is enabled", () => {
    const snapshot = {
      ...baseSnapshot,
      operation: { kind: "none" },
      mediaOwner: { kind: "none" },
      readiness: { state: "ready", mode: "realtime" },
    } as VoiceRuntimeSnapshot;
    expect(canonicalVoiceViewModel(snapshot)).toMatchObject({
      mode: "none",
      operationPhase: null,
      uiPhase: "idle",
      label: "Voice",
      active: false,
      muted: false,
      media: { busy: false },
    });
  });
});

describe("canonical voice command intents", () => {
  it("creates exact start intents for both modes", () => {
    expect(
      voiceStartIntent({
        modeSessionId: VoiceModeSessionId.make("realtime-mode"),
        interruptionPolicy: "stop-conflicting",
      }),
    ).toEqual({
      kind: "start-realtime",
      modeSessionId: "realtime-mode",
      interruptionPolicy: "stop-conflicting",
    });
    expect(voiceStartIntent(waveformStart)).toEqual({
      kind: "start-thread-mode",
      ...waveformStart,
    });
  });

  it("derives stop, mute, route, and focus from the active mode identity", () => {
    expect(voiceStopIntent(baseSnapshot, "drain")).toEqual({
      kind: "stop-mode",
      modeSessionId: "mode-1",
      policy: "drain",
    });
    expect(voiceMuteIntent(baseSnapshot, true)).toEqual({
      kind: "set-realtime-muted",
      modeSessionId: "mode-1",
      muted: true,
    });
    expect(
      voiceRouteIntent(baseSnapshot, { inputRouteId: "mic", outputRouteId: "speaker" }),
    ).toEqual({
      kind: "set-audio-route",
      modeSessionId: "mode-1",
      inputRouteId: "mic",
      outputRouteId: "speaker",
    });
    expect(
      voiceFocusIntent(baseSnapshot, {
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      kind: "update-realtime-focus",
      modeSessionId: "mode-1",
      focus: { projectId: "project-1", threadId: "thread-1" },
    });
  });

  it("rejects mode-specific intents when no compatible operation exists", () => {
    const thread = threadSnapshot({ phase: "waiting" });
    const idle = { ...baseSnapshot, operation: { kind: "none" } } as VoiceRuntimeSnapshot;
    expect(voiceMuteIntent(thread, true)).toBeNull();
    expect(voiceFocusIntent(thread, null)).toBeNull();
    expect(voiceStopIntent(idle, "immediate")).toBeNull();
    expect(voiceRouteIntent(idle, { inputRouteId: null, outputRouteId: null })).toBeNull();
  });

  it("starts Thread mode from idle or Realtime", () => {
    expect(voiceWaveformIntent(baseSnapshot, waveformStart)).toEqual({
      kind: "start-thread-mode",
      ...waveformStart,
    });
    const idle = { ...baseSnapshot, operation: { kind: "none" } } as VoiceRuntimeSnapshot;
    expect(voiceWaveformIntent(idle, waveformStart)).toEqual({
      kind: "start-thread-mode",
      ...waveformStart,
    });
  });

  it("finishes recording to an editable draft and cancels an armed turn", () => {
    expect(voiceWaveformIntent(threadSnapshot({ phase: "recording" }), waveformStart)).toEqual({
      kind: "finish-thread-turn",
      modeSessionId: "thread-mode-1",
      turnClientOperationId: "client-turn-1",
      outcome: "finish-to-draft",
      draftContext: null,
    });
    expect(voiceWaveformIntent(threadSnapshot({ phase: "arming" }), waveformStart)).toEqual({
      kind: "cancel-thread-turn",
      modeSessionId: "thread-mode-1",
      turnClientOperationId: "client-turn-1",
    });
  });

  it("resumes a paused turn, blocks attention, and pauses other active phases", () => {
    expect(
      voiceWaveformIntent(threadSnapshot({ phase: "paused", reason: "user" }), waveformStart),
    ).toEqual({
      kind: "resume-thread-mode",
      modeSessionId: "thread-mode-1",
      turnClientOperationId: "client-turn-1",
    });
    expect(
      voiceWaveformIntent(
        threadSnapshot({ phase: "attention-required", reason: "approval" }),
        waveformStart,
      ),
    ).toBeNull();
    expect(voiceWaveformIntent(threadSnapshot({ phase: "waiting" }), waveformStart)).toEqual({
      kind: "stop-mode",
      modeSessionId: "thread-mode-1",
      policy: "pause-after-turn",
    });
  });
});

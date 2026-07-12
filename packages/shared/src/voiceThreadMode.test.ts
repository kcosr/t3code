import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  initialVoiceThreadModeState,
  transitionVoiceThreadMode,
  type VoiceThreadModeConfig,
  type VoiceThreadModeState,
  type VoiceThreadModeTarget,
  type VoiceThreadModeToken,
} from "./voiceThreadMode.ts";

const config: VoiceThreadModeConfig = {
  rearmGuardMs: 750,
  transcriptionTimeoutMs: 600_000,
  submissionTimeoutMs: 30_000,
};
const target = (generation = 1): VoiceThreadModeTarget => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  generation,
});

const transition = (
  state: VoiceThreadModeState,
  event: Parameters<typeof transitionVoiceThreadMode>[1],
) => transitionVoiceThreadMode(state, event, config);

const activate = (threadBusy = false) =>
  transition(initialVoiceThreadModeState(), {
    type: "activate",
    target: target(),
    policy: "auto-submit",
    playbackRequired: true,
    threadBusy,
  });

const listening = (): {
  readonly state: VoiceThreadModeState;
  readonly token: VoiceThreadModeToken;
} => {
  const activated = activate();
  const token = activated.state.activeToken!;
  return {
    state: transition(activated.state, {
      type: "arm-succeeded",
      token,
      recordingId: "recording-1",
    }).state,
    token,
  };
};

describe("voiceThreadMode", () => {
  it("arms only after explicit activation and waits for an existing thread turn", () => {
    expect(initialVoiceThreadModeState().phase).toBe("paused");
    const waiting = activate(true);
    expect(waiting.state.phase).toBe("waiting-thread");
    expect(waiting.commands).toEqual([]);

    const armed = transition(waiting.state, { type: "thread-busy-changed", busy: false });
    expect(armed.state.phase).toBe("arming");
    expect(armed.commands).toEqual([{ type: "start-recording", token: armed.state.activeToken }]);
  });

  it("fences late recorder acquisition and cleans up the orphan", () => {
    const activated = activate();
    const staleToken = activated.state.activeToken!;
    const paused = transition(activated.state, { type: "pause", reason: "user" });
    const late = transition(paused.state, {
      type: "arm-succeeded",
      token: staleToken,
      recordingId: "recording-late",
    });

    expect(late.state).toEqual(paused.state);
    expect(late.commands).toContainEqual({
      type: "cancel-recording",
      recordingId: "recording-late",
    });
  });

  it("does not regress phases on duplicate same-token recording events", () => {
    const active = listening();
    const transcribing = transition(active.state, {
      type: "recording-completed",
      token: active.token,
    });
    const duplicateArm = transition(transcribing.state, {
      type: "arm-succeeded",
      token: active.token,
      recordingId: "recording-late",
    });
    expect(duplicateArm.state.phase).toBe("transcribing");
    expect(duplicateArm.commands).toEqual([
      { type: "cancel-recording", recordingId: "recording-late" },
    ]);
    expect(
      transition(transcribing.state, {
        type: "recording-endpointing",
        token: active.token,
      }).state.phase,
    ).toBe("transcribing");
  });

  it("cleans up the previous operation when directly reactivated", () => {
    const active = listening();
    const reactivated = transition(active.state, {
      type: "activate",
      target: target(2),
      policy: "auto-submit",
      playbackRequired: false,
      threadBusy: false,
    });
    expect(reactivated.commands).toContainEqual({
      type: "cancel-recording",
      recordingId: "recording-1",
    });
    expect(reactivated.commands.at(-1)).toEqual({
      type: "start-recording",
      token: reactivated.state.activeToken,
    });
  });

  it("moves an endpointed recording through automatic submission", () => {
    const active = listening();
    const endpointing = transition(active.state, {
      type: "recording-endpointing",
      token: active.token,
    });
    const transcribing = transition(endpointing.state, {
      type: "recording-completed",
      token: active.token,
    });
    const completed = transition(transcribing.state, {
      type: "transcription-completed",
      token: active.token,
      transcript: "  hello world  ",
    });

    expect(endpointing.state.phase).toBe("endpointing");
    expect(transcribing.state.phase).toBe("transcribing");
    expect(completed.state.phase).toBe("submitting");
    expect(completed.commands).toEqual([
      { type: "cancel-transcription-timeout" },
      { type: "start-submission-timeout", token: completed.state.activeToken },
      {
        type: "submit-transcript",
        token: completed.state.activeToken,
        target: target(),
        transcript: "hello world",
      },
    ]);
  });

  it("puts review policy transcripts in the draft without submitting or rearming", () => {
    const activated = transition(initialVoiceThreadModeState(), {
      type: "activate",
      target: target(),
      policy: "review",
      playbackRequired: true,
      threadBusy: false,
    });
    const token = activated.state.activeToken!;
    const active = transition(activated.state, {
      type: "arm-succeeded",
      token,
      recordingId: "recording-1",
    });
    const transcribing = transition(active.state, { type: "recording-completed", token });
    const reviewed = transition(transcribing.state, {
      type: "transcription-completed",
      token,
      transcript: "review me",
    });

    expect(reviewed.state.phase).toBe("reviewing");
    expect(reviewed.commands).toEqual([
      { type: "cancel-transcription-timeout" },
      { type: "set-review-draft", transcript: "review me" },
    ]);
    expect(
      transition(reviewed.state, { type: "thread-busy-changed", busy: false }).state.phase,
    ).toBe("reviewing");
  });

  it("pauses rather than looping after empty transcription or media failure", () => {
    const active = listening();
    const transcribing = transition(active.state, {
      type: "recording-completed",
      token: active.token,
    });
    const empty = transition(transcribing.state, {
      type: "transcription-completed",
      token: active.token,
      transcript: "   ",
    });
    expect(empty.state).toMatchObject({ phase: "paused", pauseReason: "empty-transcript" });

    const armed = activate();
    const failed = transition(armed.state, {
      type: "arm-failed",
      token: { ...armed.state.activeToken!, operation: armed.state.activeToken!.operation + 1 },
    });
    expect(failed.state.phase).toBe("arming");
  });

  it("waits for both assistant completion and native playback drain before guarding", () => {
    const active = listening();
    const transcribing = transition(active.state, {
      type: "recording-completed",
      token: active.token,
    });
    const submitting = transition(transcribing.state, {
      type: "transcription-completed",
      token: active.token,
      transcript: "hello",
    });
    const submitToken = submitting.state.activeToken!;
    const waiting = transition(submitting.state, {
      type: "submission-succeeded",
      token: submitToken,
      messageId: MessageId.make("message-1"),
    });
    const started = transition(waiting.state, {
      type: "assistant-stream-started",
      messageId: "assistant-1",
    });
    const speaking = transition(started.state, {
      type: "playback-started",
      playbackId: "playback-1",
      messageId: "assistant-1",
    });
    const textDone = transition(speaking.state, {
      type: "assistant-stream-completed",
      messageId: "assistant-1",
    });
    expect(textDone.state.phase).toBe("speaking");
    expect(textDone.commands).toEqual([]);

    const drained = transition(textDone.state, {
      type: "playback-drained",
      playbackId: "playback-1",
      messageId: "assistant-1",
    });
    expect(drained.state.phase).toBe("guarding");
    expect(drained.commands).toEqual([
      { type: "cancel-response-timeout" },
      { type: "start-guard", token: drained.state.activeToken, delayMs: 750 },
    ]);
  });

  it("also guards when playback drains before the assistant stream completes", () => {
    const base: VoiceThreadModeState = {
      ...initialVoiceThreadModeState(),
      phase: "speaking",
      target: target(),
      assistantMessageId: "assistant-1",
      playbackId: "playback-1",
      pauseReason: null,
    };
    const drained = transition(base, {
      type: "playback-drained",
      playbackId: "playback-1",
      messageId: "assistant-1",
    });
    expect(drained.state.phase).toBe("speaking");
    const done = transition(drained.state, {
      type: "assistant-stream-completed",
      messageId: "assistant-1",
    });
    expect(done.state.phase).toBe("guarding");
  });

  it("guards after the response without waiting for playback when TTS is disabled", () => {
    const waiting: VoiceThreadModeState = {
      ...initialVoiceThreadModeState(),
      phase: "waiting-response",
      target: target(),
      playbackRequired: false,
      submittedMessageId: MessageId.make("message-1"),
      pauseReason: null,
    };
    const started = transition(waiting, {
      type: "assistant-stream-started",
      messageId: "assistant-1",
    });
    const completed = transition(started.state, {
      type: "assistant-stream-completed",
      messageId: "assistant-1",
    });
    expect(completed.state.phase).toBe("guarding");
  });

  it("bounds transcription and submission with phase- and token-fenced timeouts", () => {
    const active = listening();
    const transcribing = transition(active.state, {
      type: "recording-completed",
      token: active.token,
    });
    expect(transcribing.commands).toEqual([
      { type: "start-transcription-timeout", token: active.token },
    ]);
    expect(
      transition(transcribing.state, {
        type: "transcription-timeout",
        token: active.token,
      }).state,
    ).toMatchObject({ phase: "paused", pauseReason: "transcription-timeout" });

    const submitting = transition(transcribing.state, {
      type: "transcription-completed",
      token: active.token,
      transcript: "hello",
    });
    expect(
      transition(submitting.state, {
        type: "submission-timeout",
        token: submitting.state.activeToken!,
      }).state,
    ).toMatchObject({ phase: "paused", pauseReason: "submission-timeout" });
    expect(
      transition(submitting.state, {
        type: "transcription-timeout",
        token: active.token,
      }).state.phase,
    ).toBe("submitting");
  });

  it("rearms exactly once after the matching guard token", () => {
    const base = transition(
      {
        ...initialVoiceThreadModeState(),
        phase: "speaking",
        target: target(),
        assistantMessageId: "assistant-1",
        assistantStreamComplete: true,
        playbackId: "playback-1",
        pauseReason: null,
      },
      { type: "playback-drained", playbackId: "playback-1", messageId: "assistant-1" },
    );
    const token = base.state.activeToken!;
    const rearmed = transition(base.state, { type: "guard-elapsed", token });
    expect(rearmed.state.phase).toBe("arming");
    expect(rearmed.commands).toEqual([
      { type: "start-recording", token: rearmed.state.activeToken },
    ]);
    expect(transition(rearmed.state, { type: "guard-elapsed", token }).commands).toEqual([]);
  });

  it.each([
    ["target-changed", { type: "target-changed", target: target(2) } as const],
    ["realtime", { type: "realtime-active" } as const],
    ["interaction", { type: "interaction-required" } as const],
  ])("pauses and cleans up on %s", (_name, event) => {
    const active = listening();
    const result = transition(active.state, event);
    expect(result.state.phase).toBe("paused");
    expect(result.commands).toContainEqual({
      type: "cancel-recording",
      recordingId: "recording-1",
    });
  });

  it("does not resume automatically when Realtime ends", () => {
    const active = listening();
    const paused = transition(active.state, { type: "realtime-active" });
    expect(transition(paused.state, { type: "thread-busy-changed", busy: false })).toEqual({
      state: paused.state,
      commands: [],
    });
  });

  it("cancels listening and playback independently from the underlying thread turn", () => {
    const speaking: VoiceThreadModeState = {
      ...initialVoiceThreadModeState(),
      phase: "speaking",
      target: target(),
      playbackId: "playback-1",
      submittedMessageId: MessageId.make("message-1"),
      pauseReason: null,
    };
    const paused = transition(speaking, { type: "pause", reason: "user" });
    expect(paused.commands).toContainEqual({
      type: "cancel-playback",
      playbackId: "playback-1",
    });
    expect(paused.commands.some((command) => command.type === "submit-transcript")).toBe(false);
  });

  it("bounds response waiting with a token-fenced timeout", () => {
    const active = listening();
    const transcribing = transition(active.state, {
      type: "recording-completed",
      token: active.token,
    });
    const submitting = transition(transcribing.state, {
      type: "transcription-completed",
      token: active.token,
      transcript: "hello",
    });
    const token = submitting.state.activeToken!;
    const waiting = transition(submitting.state, {
      type: "submission-succeeded",
      token,
      messageId: MessageId.make("message-1"),
    });
    const stale = { ...token, operation: token.operation - 1 };
    expect(transition(waiting.state, { type: "response-timeout", token: stale }).state.phase).toBe(
      "waiting-response",
    );
    expect(transition(waiting.state, { type: "response-timeout", token }).state).toMatchObject({
      phase: "paused",
      pauseReason: "response-timeout",
    });
  });
});

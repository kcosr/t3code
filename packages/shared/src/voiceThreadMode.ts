import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

export type VoiceThreadModePolicy = "review" | "auto-submit";

export interface VoiceThreadModeTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly generation: number;
}

export interface VoiceThreadModeToken {
  readonly targetGeneration: number;
  readonly cycle: number;
  readonly operation: number;
}

export type VoiceThreadModePhase =
  | "paused"
  | "waiting-thread"
  | "arming"
  | "listening"
  | "endpointing"
  | "transcribing"
  | "reviewing"
  | "submitting"
  | "waiting-response"
  | "speaking"
  | "guarding";

export type VoiceThreadModePauseReason =
  | "user"
  | "disabled"
  | "target-changed"
  | "realtime-active"
  | "permission"
  | "audio-route"
  | "lifecycle"
  | "no-speech"
  | "recording-failed"
  | "transcription-failed"
  | "transcription-timeout"
  | "empty-transcript"
  | "submission-failed"
  | "submission-timeout"
  | "interaction-required"
  | "response-timeout"
  | "playback-cancelled"
  | "playback-failed";

export interface VoiceThreadModeState {
  readonly phase: VoiceThreadModePhase;
  readonly target: VoiceThreadModeTarget | null;
  readonly policy: VoiceThreadModePolicy;
  readonly playbackRequired: boolean;
  readonly cycle: number;
  readonly nextOperation: number;
  readonly activeToken: VoiceThreadModeToken | null;
  readonly recordingId: string | null;
  readonly transcript: string;
  readonly submittedMessageId: MessageId | null;
  readonly assistantMessageId: string | null;
  readonly assistantStreamComplete: boolean;
  readonly playbackId: string | null;
  readonly playbackDrained: boolean;
  readonly sawThreadBusy: boolean;
  readonly pauseReason: VoiceThreadModePauseReason | null;
}

export interface VoiceThreadModeConfig {
  readonly rearmGuardMs: number;
  readonly transcriptionTimeoutMs: number;
  readonly submissionTimeoutMs: number;
}

export type VoiceThreadModeEvent =
  | {
      readonly type: "activate";
      readonly target: VoiceThreadModeTarget;
      readonly policy: VoiceThreadModePolicy;
      readonly playbackRequired: boolean;
      readonly threadBusy: boolean;
    }
  | { readonly type: "pause"; readonly reason: VoiceThreadModePauseReason }
  | {
      readonly type: "target-changed";
      readonly target: VoiceThreadModeTarget | null;
    }
  | { readonly type: "realtime-active" }
  | { readonly type: "thread-busy-changed"; readonly busy: boolean }
  | {
      readonly type: "arm-succeeded";
      readonly token: VoiceThreadModeToken;
      recordingId: string;
    }
  | { readonly type: "arm-failed"; readonly token: VoiceThreadModeToken }
  | {
      readonly type: "recording-endpointing";
      readonly token: VoiceThreadModeToken;
    }
  | {
      readonly type: "recording-completed";
      readonly token: VoiceThreadModeToken;
    }
  | {
      readonly type: "transcription-completed";
      readonly token: VoiceThreadModeToken;
      readonly transcript: string;
    }
  | {
      readonly type: "transcription-failed";
      readonly token: VoiceThreadModeToken;
    }
  | { readonly type: "review-submit"; readonly transcript: string }
  | { readonly type: "review-discard" }
  | {
      readonly type: "submission-succeeded";
      readonly token: VoiceThreadModeToken;
      readonly messageId: MessageId;
    }
  | { readonly type: "submission-failed"; readonly token: VoiceThreadModeToken }
  | { readonly type: "interaction-required" }
  | { readonly type: "assistant-stream-started"; readonly messageId: string }
  | { readonly type: "assistant-stream-completed"; readonly messageId: string }
  | {
      readonly type: "playback-started";
      readonly playbackId: string;
      readonly messageId: string;
    }
  | {
      readonly type: "playback-drained";
      readonly playbackId: string;
      readonly messageId: string;
    }
  | {
      readonly type: "playback-cancelled";
      readonly playbackId: string;
      readonly messageId: string;
    }
  | {
      readonly type: "playback-failed";
      readonly playbackId: string;
      readonly messageId: string;
    }
  | { readonly type: "guard-elapsed"; readonly token: VoiceThreadModeToken }
  | {
      readonly type: "transcription-timeout";
      readonly token: VoiceThreadModeToken;
    }
  | {
      readonly type: "submission-timeout";
      readonly token: VoiceThreadModeToken;
    }
  | { readonly type: "response-timeout"; readonly token: VoiceThreadModeToken };

export type VoiceThreadModeCommand =
  | { readonly type: "start-recording"; readonly token: VoiceThreadModeToken }
  | { readonly type: "cancel-recording"; readonly recordingId: string | null }
  | { readonly type: "cancel-playback"; readonly playbackId: string | null }
  | { readonly type: "set-review-draft"; readonly transcript: string }
  | {
      readonly type: "submit-transcript";
      readonly token: VoiceThreadModeToken;
      readonly target: VoiceThreadModeTarget;
      readonly transcript: string;
    }
  | {
      readonly type: "start-guard";
      readonly token: VoiceThreadModeToken;
      readonly delayMs: number;
    }
  | { readonly type: "cancel-guard" }
  | {
      readonly type: "start-response-timeout";
      readonly token: VoiceThreadModeToken;
    }
  | { readonly type: "cancel-response-timeout" }
  | {
      readonly type: "start-transcription-timeout";
      readonly token: VoiceThreadModeToken;
    }
  | { readonly type: "cancel-transcription-timeout" }
  | {
      readonly type: "start-submission-timeout";
      readonly token: VoiceThreadModeToken;
    }
  | { readonly type: "cancel-submission-timeout" };

export interface VoiceThreadModeTransition {
  readonly state: VoiceThreadModeState;
  readonly commands: ReadonlyArray<VoiceThreadModeCommand>;
}

export const initialVoiceThreadModeState = (): VoiceThreadModeState => ({
  phase: "paused",
  target: null,
  policy: "auto-submit",
  playbackRequired: true,
  cycle: 0,
  nextOperation: 0,
  activeToken: null,
  recordingId: null,
  transcript: "",
  submittedMessageId: null,
  assistantMessageId: null,
  assistantStreamComplete: false,
  playbackId: null,
  playbackDrained: false,
  sawThreadBusy: false,
  pauseReason: "disabled",
});

const sameToken = (left: VoiceThreadModeToken | null, right: VoiceThreadModeToken): boolean =>
  left !== null &&
  left.targetGeneration === right.targetGeneration &&
  left.cycle === right.cycle &&
  left.operation === right.operation;

const cleanupCommands = (state: VoiceThreadModeState): ReadonlyArray<VoiceThreadModeCommand> => [
  { type: "cancel-recording", recordingId: state.recordingId },
  ...(state.playbackId === null
    ? []
    : [{ type: "cancel-playback" as const, playbackId: state.playbackId }]),
  { type: "cancel-guard" },
  { type: "cancel-response-timeout" },
  { type: "cancel-transcription-timeout" },
  { type: "cancel-submission-timeout" },
];

const pause = (
  state: VoiceThreadModeState,
  reason: VoiceThreadModePauseReason,
  target: VoiceThreadModeTarget | null = state.target,
): VoiceThreadModeTransition => ({
  state: {
    ...state,
    phase: "paused",
    target,
    cycle: state.cycle + 1,
    activeToken: null,
    recordingId: null,
    transcript: "",
    submittedMessageId: null,
    assistantMessageId: null,
    assistantStreamComplete: false,
    playbackId: null,
    playbackDrained: false,
    sawThreadBusy: false,
    pauseReason: reason,
  },
  commands: cleanupCommands(state),
});

const beginOperation = (
  state: VoiceThreadModeState,
  phase: VoiceThreadModePhase,
): {
  readonly state: VoiceThreadModeState;
  readonly token: VoiceThreadModeToken;
} => {
  const target = state.target;
  if (target === null) throw new Error("Voice thread mode requires a target");
  const operation = state.nextOperation + 1;
  const token = {
    targetGeneration: target.generation,
    cycle: state.cycle,
    operation,
  } satisfies VoiceThreadModeToken;
  return {
    state: { ...state, phase, nextOperation: operation, activeToken: token },
    token,
  };
};

const arm = (state: VoiceThreadModeState): VoiceThreadModeTransition => {
  const next = beginOperation(state, "arming");
  return {
    state: next.state,
    commands: [{ type: "start-recording", token: next.token }],
  };
};

const maybeBeginGuard = (
  state: VoiceThreadModeState,
  config: VoiceThreadModeConfig,
): VoiceThreadModeTransition => {
  if (!state.assistantStreamComplete || (state.playbackRequired && !state.playbackDrained)) {
    return { state, commands: [] };
  }
  const next = beginOperation(state, "guarding");
  return {
    state: next.state,
    commands: [
      { type: "cancel-response-timeout" },
      { type: "start-guard", token: next.token, delayMs: config.rearmGuardMs },
    ],
  };
};

export function transitionVoiceThreadMode(
  state: VoiceThreadModeState,
  event: VoiceThreadModeEvent,
  config: VoiceThreadModeConfig,
): VoiceThreadModeTransition {
  switch (event.type) {
    case "activate": {
      const activated: VoiceThreadModeState = {
        ...initialVoiceThreadModeState(),
        target: event.target,
        policy: event.policy,
        playbackRequired: event.playbackRequired,
        cycle: state.cycle + 1,
        nextOperation: state.nextOperation,
        pauseReason: null,
      };
      const next: VoiceThreadModeTransition = event.threadBusy
        ? { state: { ...activated, phase: "waiting-thread" }, commands: [] }
        : arm(activated);
      return {
        state: next.state,
        commands: [...(state.phase === "paused" ? [] : cleanupCommands(state)), ...next.commands],
      };
    }
    case "pause":
      return pause(state, event.reason);
    case "target-changed":
      return pause(state, "target-changed", event.target);
    case "realtime-active":
      return pause(state, "realtime-active");
    case "thread-busy-changed":
      if (state.phase === "waiting-thread" && !event.busy) return arm(state);
      if (state.phase === "waiting-response") {
        return {
          state: { ...state, sawThreadBusy: state.sawThreadBusy || event.busy },
          commands: [],
        };
      }
      return { state, commands: [] };
    case "arm-succeeded":
      if (state.phase !== "arming" || !sameToken(state.activeToken, event.token)) {
        return {
          state,
          commands: [{ type: "cancel-recording", recordingId: event.recordingId }],
        };
      }
      return {
        state: { ...state, phase: "listening", recordingId: event.recordingId },
        commands: [],
      };
    case "arm-failed":
      return state.phase === "arming" && sameToken(state.activeToken, event.token)
        ? pause(state, "recording-failed")
        : { state, commands: [] };
    case "recording-endpointing":
      return state.phase === "listening" && sameToken(state.activeToken, event.token)
        ? { state: { ...state, phase: "endpointing" }, commands: [] }
        : { state, commands: [] };
    case "recording-completed":
      return (state.phase === "listening" || state.phase === "endpointing") &&
        sameToken(state.activeToken, event.token)
        ? {
            state: { ...state, phase: "transcribing" },
            commands: [{ type: "start-transcription-timeout", token: event.token }],
          }
        : { state, commands: [] };
    case "transcription-completed": {
      if (state.phase !== "transcribing" || !sameToken(state.activeToken, event.token)) {
        return { state, commands: [] };
      }
      const transcript = event.transcript.trim();
      if (!transcript) return pause(state, "empty-transcript");
      if (state.policy === "review") {
        return {
          state: {
            ...state,
            phase: "reviewing",
            recordingId: null,
            transcript,
          },
          commands: [
            { type: "cancel-transcription-timeout" },
            { type: "set-review-draft", transcript },
          ],
        };
      }
      const next = beginOperation({ ...state, recordingId: null, transcript }, "submitting");
      return {
        state: next.state,
        commands: [
          { type: "cancel-transcription-timeout" },
          { type: "start-submission-timeout", token: next.token },
          {
            type: "submit-transcript",
            token: next.token,
            target: state.target!,
            transcript,
          },
        ],
      };
    }
    case "transcription-failed":
      return state.phase === "transcribing" && sameToken(state.activeToken, event.token)
        ? pause(state, "transcription-failed")
        : { state, commands: [] };
    case "transcription-timeout":
      return state.phase === "transcribing" && sameToken(state.activeToken, event.token)
        ? pause(state, "transcription-timeout")
        : { state, commands: [] };
    case "review-submit": {
      if (state.phase !== "reviewing" || state.target === null) return { state, commands: [] };
      const transcript = event.transcript.trim();
      if (!transcript) return pause(state, "empty-transcript");
      const next = beginOperation({ ...state, transcript }, "submitting");
      return {
        state: next.state,
        commands: [
          { type: "start-submission-timeout", token: next.token },
          {
            type: "submit-transcript",
            token: next.token,
            target: state.target,
            transcript,
          },
        ],
      };
    }
    case "review-discard":
      return pause(state, "user");
    case "submission-succeeded":
      if (state.phase !== "submitting" || !sameToken(state.activeToken, event.token)) {
        return { state, commands: [] };
      }
      return {
        state: {
          ...state,
          phase: "waiting-response",
          submittedMessageId: event.messageId,
          sawThreadBusy: false,
        },
        commands: [
          { type: "cancel-submission-timeout" },
          { type: "start-response-timeout", token: event.token },
        ],
      };
    case "submission-failed":
      return state.phase === "submitting" && sameToken(state.activeToken, event.token)
        ? pause(state, "submission-failed")
        : { state, commands: [] };
    case "submission-timeout":
      return state.phase === "submitting" && sameToken(state.activeToken, event.token)
        ? pause(state, "submission-timeout")
        : { state, commands: [] };
    case "interaction-required":
      return pause(state, "interaction-required");
    case "assistant-stream-started":
      if (state.phase !== "waiting-response" && state.phase !== "speaking") {
        return { state, commands: [] };
      }
      if (state.assistantMessageId !== null && state.assistantMessageId !== event.messageId) {
        return { state, commands: [] };
      }
      return {
        state: {
          ...state,
          assistantMessageId: event.messageId,
          assistantStreamComplete: false,
        },
        commands: [],
      };
    case "assistant-stream-completed":
      if (state.assistantMessageId !== event.messageId) return { state, commands: [] };
      return maybeBeginGuard({ ...state, assistantStreamComplete: true }, config);
    case "playback-started":
      if (state.phase !== "waiting-response" && state.phase !== "speaking") {
        return { state, commands: [] };
      }
      if (state.assistantMessageId !== event.messageId || state.playbackId !== null) {
        return { state, commands: [] };
      }
      return {
        state: { ...state, phase: "speaking", playbackId: event.playbackId },
        commands: [],
      };
    case "playback-drained":
      if (
        state.assistantMessageId !== event.messageId ||
        (state.playbackId !== null && state.playbackId !== event.playbackId)
      ) {
        return { state, commands: [] };
      }
      return maybeBeginGuard(
        {
          ...state,
          phase: "speaking",
          playbackId: event.playbackId,
          playbackDrained: true,
        },
        config,
      );
    case "playback-cancelled":
      return state.assistantMessageId === event.messageId &&
        (state.playbackId === null || state.playbackId === event.playbackId)
        ? pause(state, "playback-cancelled")
        : { state, commands: [] };
    case "playback-failed":
      return state.assistantMessageId === event.messageId &&
        (state.playbackId === null || state.playbackId === event.playbackId)
        ? pause(state, "playback-failed")
        : { state, commands: [] };
    case "guard-elapsed":
      return state.phase === "guarding" && sameToken(state.activeToken, event.token)
        ? arm({
            ...state,
            assistantMessageId: null,
            assistantStreamComplete: false,
            playbackId: null,
          })
        : { state, commands: [] };
    case "response-timeout":
      return (state.phase === "waiting-response" || state.phase === "speaking") &&
        sameToken(state.activeToken, event.token)
        ? pause(state, "response-timeout")
        : { state, commands: [] };
  }
}

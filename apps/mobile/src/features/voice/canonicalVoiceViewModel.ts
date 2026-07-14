import type { VoiceRuntimeCommandRequest } from "@t3tools/client-runtime/voice";
import type {
  VoiceRealtimeOperationPhase,
  VoiceRuntimeFailure,
  VoiceRuntimeMediaOwner,
  VoiceRuntimeSnapshot,
  VoiceRuntimeTarget,
  VoiceThreadOperationPhase,
} from "@t3tools/contracts";

type CommandIntent<Kind extends VoiceRuntimeCommandRequest["kind"]> = Extract<
  VoiceRuntimeCommandRequest,
  { readonly kind: Kind }
>;

export type CanonicalVoiceUiPhase =
  | "idle"
  | "starting"
  | "listening"
  | "connected"
  | "working"
  | "speaking"
  | "stopping"
  | "paused"
  | "attention"
  | "completed"
  | "failed"
  | "cancelled";

export type CanonicalVoiceOperationPhase =
  | VoiceRealtimeOperationPhase
  | VoiceThreadOperationPhase["phase"];

type VoicePausedReason = Extract<VoiceThreadOperationPhase, { phase: "paused" }>["reason"];
type VoiceAttentionReason = Extract<
  VoiceThreadOperationPhase,
  { phase: "attention-required" }
>["reason"];

export type CanonicalVoiceAttention =
  | {
      readonly kind: "paused";
      readonly reason: VoicePausedReason;
      readonly label: string;
    }
  | {
      readonly kind: "required";
      readonly reason: VoiceAttentionReason;
      readonly label: string;
    };

export interface CanonicalVoiceMediaViewModel {
  readonly owner: VoiceRuntimeMediaOwner;
  readonly busy: boolean;
  readonly microphoneActive: boolean;
  readonly playbackActive: boolean;
  readonly realtimePeerActive: boolean;
  readonly cueActive: boolean;
}

export interface CanonicalVoiceViewModel {
  readonly mode: "none" | "realtime" | "thread";
  readonly operationPhase: CanonicalVoiceOperationPhase | null;
  readonly uiPhase: CanonicalVoiceUiPhase;
  readonly label: string;
  readonly active: boolean;
  readonly muted: boolean;
  readonly target: VoiceRuntimeTarget | null;
  readonly media: CanonicalVoiceMediaViewModel;
  readonly error: VoiceRuntimeFailure | null;
  readonly attention: CanonicalVoiceAttention | null;
}

const REALTIME_PRESENTATION = {
  preparing: { uiPhase: "starting", label: "Preparing voice", active: true },
  negotiating: { uiPhase: "starting", label: "Connecting", active: true },
  cueing: { uiPhase: "starting", label: "Voice ready", active: true },
  connected: { uiPhase: "connected", label: "Voice active", active: true },
  draining: { uiPhase: "stopping", label: "Finishing voice response", active: true },
  stopping: { uiPhase: "stopping", label: "Ending voice", active: true },
  retrying: { uiPhase: "starting", label: "Reconnecting", active: true },
  recovering: { uiPhase: "starting", label: "Restoring voice", active: true },
  completed: { uiPhase: "completed", label: "Voice ended", active: false },
  failed: { uiPhase: "failed", label: "Voice failed", active: false },
  cancelled: { uiPhase: "cancelled", label: "Voice cancelled", active: false },
} as const;

const THREAD_PRESENTATION = {
  arming: { uiPhase: "starting", label: "Starting microphone", active: true },
  recording: { uiPhase: "listening", label: "Listening", active: true },
  finalizing: { uiPhase: "working", label: "Finishing recording", active: true },
  uploading: { uiPhase: "working", label: "Uploading audio", active: true },
  transcribing: { uiPhase: "working", label: "Transcribing", active: true },
  dispatching: { uiPhase: "working", label: "Sending message", active: true },
  waiting: { uiPhase: "working", label: "Agent working", active: true },
  playing: { uiPhase: "speaking", label: "Speaking response", active: true },
  "playback-drained": { uiPhase: "working", label: "Response finished", active: true },
  guarding: { uiPhase: "working", label: "Waiting to listen", active: true },
  rearming: { uiPhase: "starting", label: "Starting microphone", active: true },
  "draft-ready": { uiPhase: "completed", label: "Draft ready", active: false },
  retrying: { uiPhase: "working", label: "Retrying voice", active: true },
  recovering: { uiPhase: "working", label: "Restoring voice", active: true },
  completed: { uiPhase: "completed", label: "Voice turn complete", active: false },
  failed: { uiPhase: "failed", label: "Voice turn failed", active: false },
  cancelled: { uiPhase: "cancelled", label: "Voice turn cancelled", active: false },
} as const;

const PAUSED_LABELS: Readonly<Record<VoicePausedReason, string>> = {
  user: "Voice paused",
  authority: "Waiting for voice access",
  network: "Waiting for network",
};

const ATTENTION_LABELS: Readonly<Record<VoiceAttentionReason, string>> = {
  approval: "Approval required",
  "user-input": "Input required",
  "inaccessible-target": "Open T3 to continue",
  "draft-review": "Review voice draft",
};

function mediaViewModel(owner: VoiceRuntimeMediaOwner): CanonicalVoiceMediaViewModel {
  return {
    owner,
    busy: owner.kind !== "none",
    microphoneActive: owner.kind === "recorder" || owner.kind === "realtime-peer",
    playbackActive: owner.kind === "player" || owner.kind === "realtime-peer",
    realtimePeerActive: owner.kind === "realtime-peer",
    cueActive: owner.kind === "cue-player",
  };
}

/** Projects the canonical native snapshot without inferring media ownership from operation phase. */
export function canonicalVoiceViewModel(snapshot: VoiceRuntimeSnapshot): CanonicalVoiceViewModel {
  const common = {
    target: snapshot.target,
    media: mediaViewModel(snapshot.mediaOwner),
    error: snapshot.failure,
  } as const;

  if (snapshot.operation.kind === "none") {
    return {
      ...common,
      mode: "none",
      operationPhase: null,
      uiPhase: "idle",
      label: "Voice",
      active: false,
      muted: false,
      attention: null,
    };
  }

  if (snapshot.operation.kind === "realtime") {
    const presentation = REALTIME_PRESENTATION[snapshot.operation.phase];
    return {
      ...common,
      mode: "realtime",
      operationPhase: snapshot.operation.phase,
      ...presentation,
      muted: snapshot.operation.muted,
      attention: null,
    };
  }

  const phase = snapshot.operation.phase;
  if (phase.phase === "paused") {
    return {
      ...common,
      mode: "thread",
      operationPhase: phase.phase,
      uiPhase: "paused",
      label: PAUSED_LABELS[phase.reason],
      active: true,
      muted: false,
      attention: { kind: "paused", reason: phase.reason, label: PAUSED_LABELS[phase.reason] },
    };
  }
  if (phase.phase === "attention-required") {
    return {
      ...common,
      mode: "thread",
      operationPhase: phase.phase,
      uiPhase: "attention",
      label: ATTENTION_LABELS[phase.reason],
      active: true,
      muted: false,
      attention: {
        kind: "required",
        reason: phase.reason,
        label: ATTENTION_LABELS[phase.reason],
      },
    };
  }
  const presentation = THREAD_PRESENTATION[phase.phase];
  return {
    ...common,
    mode: "thread",
    operationPhase: phase.phase,
    ...presentation,
    muted: false,
    attention: null,
  };
}

export type VoiceStartIntentInput =
  | Omit<CommandIntent<"start-realtime">, "kind">
  | Omit<CommandIntent<"start-thread-mode">, "kind">;

export function voiceStartIntent(input: VoiceStartIntentInput): VoiceRuntimeCommandRequest {
  return "turnClientOperationId" in input
    ? { kind: "start-thread-mode", ...input }
    : { kind: "start-realtime", ...input };
}

export function voiceStopIntent(
  snapshot: VoiceRuntimeSnapshot,
  policy: CommandIntent<"stop-mode">["policy"],
): CommandIntent<"stop-mode"> | null {
  const operation = snapshot.operation;
  if (operation.kind === "none") return null;
  return { kind: "stop-mode", modeSessionId: operation.modeSessionId, policy };
}

export function voiceMuteIntent(
  snapshot: VoiceRuntimeSnapshot,
  muted: boolean,
): CommandIntent<"set-realtime-muted"> | null {
  const operation = snapshot.operation;
  if (operation.kind !== "realtime") return null;
  return { kind: "set-realtime-muted", modeSessionId: operation.modeSessionId, muted };
}

export function voiceRouteIntent(
  snapshot: VoiceRuntimeSnapshot,
  route: Pick<CommandIntent<"set-audio-route">, "inputRouteId" | "outputRouteId">,
): CommandIntent<"set-audio-route"> | null {
  const operation = snapshot.operation;
  if (operation.kind === "none") return null;
  return { kind: "set-audio-route", modeSessionId: operation.modeSessionId, ...route };
}

export function voiceFocusIntent(
  snapshot: VoiceRuntimeSnapshot,
  focus: CommandIntent<"update-realtime-focus">["focus"],
): CommandIntent<"update-realtime-focus"> | null {
  const operation = snapshot.operation;
  if (operation.kind !== "realtime") return null;
  return { kind: "update-realtime-focus", modeSessionId: operation.modeSessionId, focus };
}

export type VoiceWaveformIntentInput = Omit<CommandIntent<"start-thread-mode">, "kind">;

/**
 * Maps the foreground waveform toggle to one canonical runtime command. A recording stops to an
 * editable draft; other live Thread phases pause after the accepted turn reaches a safe boundary.
 */
export function voiceWaveformIntent(
  snapshot: VoiceRuntimeSnapshot,
  start: VoiceWaveformIntentInput,
): VoiceRuntimeCommandRequest | null {
  const operation = snapshot.operation;
  if (operation.kind !== "thread-turn") return { kind: "start-thread-mode", ...start };

  const phase = operation.phase.phase;
  if (phase === "recording") {
    if (operation.turnClientOperationId === null) return null;
    return {
      kind: "finish-thread-turn",
      modeSessionId: operation.modeSessionId,
      turnClientOperationId: operation.turnClientOperationId,
      outcome: "finish-to-draft",
      draftContext: start.draftContext,
    };
  }
  if (phase === "arming") {
    if (operation.turnClientOperationId === null) return null;
    return {
      kind: "cancel-thread-turn",
      modeSessionId: operation.modeSessionId,
      turnClientOperationId: operation.turnClientOperationId,
    };
  }
  if (phase === "paused") {
    if (operation.turnClientOperationId === null) return null;
    return {
      kind: "resume-thread-mode",
      modeSessionId: operation.modeSessionId,
      turnClientOperationId: operation.turnClientOperationId,
    };
  }
  if (
    phase === "draft-ready" ||
    phase === "completed" ||
    phase === "failed" ||
    phase === "cancelled"
  ) {
    return { kind: "start-thread-mode", ...start };
  }
  if (phase === "attention-required") return null;
  return {
    kind: "stop-mode",
    modeSessionId: operation.modeSessionId,
    policy: "pause-after-turn",
  };
}

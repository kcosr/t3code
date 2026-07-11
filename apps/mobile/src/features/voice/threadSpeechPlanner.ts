import {
  appendSpeechText,
  initialSpeechChunkerState,
  type SpeechChunkerState,
  type SpeechTextSegment,
} from "./speechChunker";

export interface AssistantSpeechSnapshot {
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}

interface ActiveSpeechPlan {
  readonly messageId: string;
  readonly playbackId: string;
  readonly observedText: string;
  readonly chunker: SpeechChunkerState;
}

export interface ThreadSpeechPlannerState {
  readonly enabled: boolean;
  readonly baselineMessageId: string | null;
  readonly active: ActiveSpeechPlan | null;
}

export type ThreadSpeechAction =
  | { readonly type: "start"; readonly playbackId: string }
  | {
      readonly type: "segment";
      readonly playbackId: string;
      readonly segment: SpeechTextSegment;
    }
  | { readonly type: "finish"; readonly playbackId: string }
  | { readonly type: "cancel"; readonly playbackId: string };

export const initialThreadSpeechPlannerState = (): ThreadSpeechPlannerState => ({
  enabled: false,
  baselineMessageId: null,
  active: null,
});

export const setThreadSpeechEnabled = (
  state: ThreadSpeechPlannerState,
  enabled: boolean,
  latest: AssistantSpeechSnapshot | null,
): {
  readonly state: ThreadSpeechPlannerState;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
} => {
  if (state.enabled === enabled) return { state, actions: [] };
  if (!enabled) {
    return {
      state: { enabled: false, baselineMessageId: latest?.id ?? null, active: null },
      actions: state.active ? [{ type: "cancel", playbackId: state.active.playbackId }] : [],
    };
  }
  return {
    state: {
      enabled: true,
      baselineMessageId: latest?.streaming ? null : (latest?.id ?? null),
      active: null,
    },
    actions: [],
  };
};

export const planThreadSpeechToggle = (
  state: ThreadSpeechPlannerState,
  latest: AssistantSpeechSnapshot | null,
  createPlaybackId: () => string,
): {
  readonly state: ThreadSpeechPlannerState;
  readonly enabled: boolean;
  readonly cancelPlaybackId: string | null;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
} => {
  const enabled = !state.enabled;
  const toggled = setThreadSpeechEnabled(state, enabled, latest);
  if (!enabled) {
    return {
      state: toggled.state,
      enabled,
      cancelPlaybackId: state.active?.playbackId ?? null,
      actions: [],
    };
  }
  const immediate = latest?.streaming
    ? updateThreadSpeech(toggled.state, latest, createPlaybackId)
    : { state: toggled.state, actions: [] };
  return {
    state: immediate.state,
    enabled,
    cancelPlaybackId: null,
    actions: [...toggled.actions, ...immediate.actions],
  };
};

const appendSnapshot = (
  state: ThreadSpeechPlannerState,
  active: ActiveSpeechPlan,
  snapshot: AssistantSpeechSnapshot,
): {
  readonly state: ThreadSpeechPlannerState;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
} => {
  const textStillExtendsActive = snapshot.text.startsWith(active.observedText);
  if (!textStillExtendsActive) {
    return {
      state: { ...state, baselineMessageId: snapshot.id, active: null },
      actions: [{ type: "cancel", playbackId: active.playbackId }],
    };
  }
  const result = appendSpeechText(
    active.chunker,
    snapshot.text.slice(active.observedText.length),
    !snapshot.streaming,
  );
  const segmentActions = result.segments.map(
    (segment): ThreadSpeechAction => ({
      type: "segment",
      playbackId: active.playbackId,
      segment,
    }),
  );
  if (snapshot.streaming) {
    return {
      state: {
        ...state,
        active: {
          ...active,
          observedText: snapshot.text,
          chunker: result.state,
        },
      },
      actions: segmentActions,
    };
  }
  const hasSegments = result.state.nextIndex > 0;
  return {
    state: { ...state, baselineMessageId: snapshot.id, active: null },
    actions: [
      ...segmentActions,
      ...(hasSegments
        ? [{ type: "finish" as const, playbackId: active.playbackId }]
        : [{ type: "cancel" as const, playbackId: active.playbackId }]),
    ],
  };
};

export const updateThreadSpeech = (
  state: ThreadSpeechPlannerState,
  latest: AssistantSpeechSnapshot | null,
  createPlaybackId: () => string,
): {
  readonly state: ThreadSpeechPlannerState;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
} => {
  if (!state.enabled) return { state, actions: [] };
  if (state.active !== null) {
    if (latest === null || latest.id !== state.active.messageId) {
      const cancelled = { type: "cancel" as const, playbackId: state.active.playbackId };
      if (latest === null) {
        return {
          state: { ...state, baselineMessageId: null, active: null },
          actions: [cancelled],
        };
      }
      const replacement = updateThreadSpeech(
        { ...state, baselineMessageId: state.active.messageId, active: null },
        latest,
        createPlaybackId,
      );
      return {
        state: replacement.state,
        actions: [cancelled, ...replacement.actions],
      };
    }
    return appendSnapshot(state, state.active, latest);
  }
  if (latest === null || latest.id === state.baselineMessageId) {
    return { state, actions: [] };
  }
  const playbackId = createPlaybackId();
  const active: ActiveSpeechPlan = {
    messageId: latest.id,
    playbackId,
    observedText: "",
    chunker: initialSpeechChunkerState(),
  };
  const updated = appendSnapshot({ ...state, active }, active, latest);
  return {
    state: updated.state,
    actions: [{ type: "start", playbackId }, ...updated.actions],
  };
};

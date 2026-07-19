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

export interface ThreadSpeechHydrationState {
  readonly preferenceHydrated: boolean;
  readonly toggledBeforePreferenceHydration: boolean;
  readonly earlyToggleNeedsBaseline: boolean;
  readonly lastObservedPreference: boolean | null;
}

export interface ThreadSpeechPlannerState {
  readonly enabled: boolean;
  readonly baselineMessageId: string | null;
  readonly active: ActiveSpeechPlan | null;
  readonly hydration: ThreadSpeechHydrationState;
}

export type ThreadSpeechAction =
  | { readonly type: "start"; readonly playbackId: string; readonly messageId: string }
  | {
      readonly type: "segment";
      readonly playbackId: string;
      readonly segment: SpeechTextSegment;
    }
  | { readonly type: "finish"; readonly playbackId: string }
  | { readonly type: "cancel"; readonly playbackId: string };

const initialHydrationState = (): ThreadSpeechHydrationState => ({
  preferenceHydrated: false,
  toggledBeforePreferenceHydration: false,
  earlyToggleNeedsBaseline: false,
  lastObservedPreference: null,
});

export const initialThreadSpeechPlannerState = (): ThreadSpeechPlannerState => ({
  enabled: false,
  baselineMessageId: null,
  active: null,
  hydration: initialHydrationState(),
});

export const isThreadSpeechSuspended = (dictation: boolean, realtime: boolean): boolean =>
  dictation || realtime;

const withHydration = (
  state: ThreadSpeechPlannerState,
  hydration: ThreadSpeechHydrationState = state.hydration,
): Pick<ThreadSpeechPlannerState, "hydration"> => ({ hydration });

export const restoreThreadSpeechPreference = (
  state: ThreadSpeechPlannerState,
  enabled: boolean,
  latest: AssistantSpeechSnapshot | null,
): {
  readonly state: ThreadSpeechPlannerState;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
} => ({
  state: {
    enabled,
    baselineMessageId: latest?.id ?? null,
    active: null,
    ...withHydration(state),
  },
  actions: state.active ? [{ type: "cancel", playbackId: state.active.playbackId }] : [],
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
      state: {
        enabled: false,
        baselineMessageId: latest?.id ?? null,
        active: null,
        ...withHydration(state),
      },
      actions: state.active ? [{ type: "cancel", playbackId: state.active.playbackId }] : [],
    };
  }
  return {
    state: {
      enabled: true,
      baselineMessageId: latest?.streaming ? null : (latest?.id ?? null),
      active: null,
      ...withHydration(state),
    },
    actions: [],
  };
};

export const interruptThreadSpeech = (
  state: ThreadSpeechPlannerState,
  latest: AssistantSpeechSnapshot | null,
): ThreadSpeechPlannerState => ({
  enabled: state.enabled,
  baselineMessageId: latest?.id ?? state.baselineMessageId,
  active: null,
  ...withHydration(state),
});

export const noteThreadSpeechEarlyToggle = (
  state: ThreadSpeechPlannerState,
  historyReady: boolean,
): ThreadSpeechPlannerState => {
  if (state.hydration.preferenceHydrated) return state;
  return {
    ...state,
    hydration: {
      ...state.hydration,
      toggledBeforePreferenceHydration: true,
      earlyToggleNeedsBaseline: state.hydration.earlyToggleNeedsBaseline || !historyReady,
    },
  };
};

export const hydrateThreadSpeechPreference = (
  state: ThreadSpeechPlannerState,
  input: {
    readonly historyReady: boolean;
    readonly preferencesReady: boolean;
    readonly persistedEnabled: boolean;
    readonly latest: AssistantSpeechSnapshot | null;
  },
): {
  readonly state: ThreadSpeechPlannerState;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
  readonly didHydrate: boolean;
} => {
  if (state.hydration.preferenceHydrated || !input.historyReady || !input.preferencesReady) {
    return { state, actions: [], didHydrate: false };
  }

  const nextHydration: ThreadSpeechHydrationState = {
    ...state.hydration,
    preferenceHydrated: true,
  };

  // User toggled after history was ready: keep planner as-is (including baseline from toggle).
  // Preserve prior behavior of not seeding lastObservedPreference on this path.
  if (
    state.hydration.toggledBeforePreferenceHydration &&
    !state.hydration.earlyToggleNeedsBaseline
  ) {
    return {
      state: { ...state, hydration: nextHydration },
      actions: [],
      didHydrate: true,
    };
  }

  const enabled = state.hydration.toggledBeforePreferenceHydration
    ? state.enabled
    : input.persistedEnabled;
  const restored = restoreThreadSpeechPreference(state, enabled, input.latest);
  return {
    state: {
      ...restored.state,
      hydration: {
        ...nextHydration,
        lastObservedPreference: input.persistedEnabled,
      },
    },
    actions: restored.actions,
    didHydrate: true,
  };
};

export const syncExternalThreadSpeechPreference = (
  state: ThreadSpeechPlannerState,
  input: {
    readonly preferencesReady: boolean;
    readonly persistedEnabled: boolean;
    readonly latest: AssistantSpeechSnapshot | null;
  },
): {
  readonly state: ThreadSpeechPlannerState;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
  readonly kind: "none" | "enable" | "disable_no_persist";
} => {
  if (!state.hydration.preferenceHydrated || !input.preferencesReady) {
    return { state, actions: [], kind: "none" };
  }

  const previouslyRequested = state.hydration.lastObservedPreference;
  const nextState: ThreadSpeechPlannerState = {
    ...state,
    hydration: {
      ...state.hydration,
      lastObservedPreference: input.persistedEnabled,
    },
  };

  if (previouslyRequested === null || previouslyRequested === input.persistedEnabled) {
    return { state: nextState, actions: [], kind: "none" };
  }
  if (input.persistedEnabled === nextState.enabled) {
    return { state: nextState, actions: [], kind: "none" };
  }
  if (!input.persistedEnabled) {
    return { state: nextState, actions: [], kind: "disable_no_persist" };
  }

  const enabled = setThreadSpeechEnabled(nextState, true, input.latest);
  return { state: enabled.state, actions: enabled.actions, kind: "enable" };
};

export const planThreadSpeechToggle = (
  state: ThreadSpeechPlannerState,
  latest: AssistantSpeechSnapshot | null,
  createPlaybackId: () => string,
  suspended = false,
): {
  readonly state: ThreadSpeechPlannerState;
  readonly enabled: boolean;
  readonly cancelPlaybackId: string | null;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
} => {
  const enabled = !state.enabled;
  const toggled = setThreadSpeechEnabled(state, enabled, latest);
  if (suspended) {
    return {
      state: toggled.state,
      enabled,
      cancelPlaybackId: null,
      actions: [],
    };
  }
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
  suspended = false,
): {
  readonly state: ThreadSpeechPlannerState;
  readonly actions: ReadonlyArray<ThreadSpeechAction>;
} => {
  if (suspended) return { state, actions: [] };
  if (!state.enabled) return { state, actions: [] };
  if (state.active !== null) {
    if (latest === null || latest.id !== state.active.messageId) {
      const cancelled = {
        type: "cancel" as const,
        playbackId: state.active.playbackId,
      };
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
    actions: [{ type: "start", playbackId, messageId: latest.id }, ...updated.actions],
  };
};

import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { AssistantSpeechSnapshot } from "./threadSpeechPlanner";

export const LOCAL_THREAD_SPEECH_ANCHOR_MILLIS = 5 * 60 * 1_000;
const MAX_HISTORICAL_MESSAGE_IDS = 512;

export interface ThreadSpeechObservation extends AssistantSpeechSnapshot {
  readonly turnId: string | null;
}

interface LocalCommandAnchor {
  readonly messageId: string;
  readonly recordedAtMonotonicMillis: number;
}

interface ThreadSpeechObservationState {
  readonly scopeKey: string | null;
  readonly localAnchor: LocalCommandAnchor | null;
  readonly activeResponseMessageId: string | null;
  readonly historicalMessageIds: ReadonlySet<string>;
  readonly liveBaselineRequired: boolean;
  readonly lastMonotonicMillis: number;
}

export interface ThreadSpeechObservationInput {
  readonly scopeKey: string;
  readonly syncStatus: EnvironmentThreadStatus | undefined;
  readonly latestAssistant: ThreadSpeechObservation | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly nativeAssistantMessageIds: ReadonlySet<string>;
  readonly monotonicMillis: number;
}

export interface ThreadSpeechObservationDecision {
  readonly automaticPlaybackEligible: boolean;
  /**
   * Advances the observation only if this preview still describes the last
   * committed state. It is safe to invoke twice under React Strict Mode.
   */
  readonly commit: () => void;
}

const initialState = (): ThreadSpeechObservationState => ({
  scopeKey: null,
  localAnchor: null,
  activeResponseMessageId: null,
  historicalMessageIds: new Set(),
  liveBaselineRequired: true,
  lastMonotonicMillis: 0,
});

const selectScope = (
  state: ThreadSpeechObservationState,
  scopeKey: string,
): ThreadSpeechObservationState =>
  state.scopeKey === scopeKey
    ? state
    : {
        ...initialState(),
        scopeKey,
        lastMonotonicMillis: state.lastMonotonicMillis,
      };

const advanceMonotonicClock = (
  state: ThreadSpeechObservationState,
  candidate: number,
): ThreadSpeechObservationState => ({
  ...state,
  lastMonotonicMillis: Math.max(state.lastMonotonicMillis, candidate),
});

const markHistorical = (
  state: ThreadSpeechObservationState,
  messageId: string,
): ThreadSpeechObservationState => {
  const historicalMessageIds = new Set(state.historicalMessageIds);
  historicalMessageIds.delete(messageId);
  historicalMessageIds.add(messageId);
  while (historicalMessageIds.size > MAX_HISTORICAL_MESSAGE_IDS) {
    const oldest = historicalMessageIds.values().next().value as string | undefined;
    if (oldest === undefined) break;
    historicalMessageIds.delete(oldest);
  }
  return { ...state, historicalMessageIds };
};

const classifyObservation = (
  committedState: ThreadSpeechObservationState,
  input: ThreadSpeechObservationInput,
): {
  readonly state: ThreadSpeechObservationState;
  readonly automaticPlaybackEligible: boolean;
} => {
  let state = advanceMonotonicClock(
    selectScope(committedState, input.scopeKey),
    input.monotonicMillis,
  );
  const latest = input.latestAssistant;
  const live = input.syncStatus === undefined || input.syncStatus === "live";

  if (!live) {
    state = { ...state, liveBaselineRequired: true, activeResponseMessageId: null };
    if (latest !== null) state = markHistorical(state, latest.id);
    return { state, automaticPlaybackEligible: false };
  }
  if (state.liveBaselineRequired) {
    state = { ...state, liveBaselineRequired: false };
    if (latest !== null) state = markHistorical(state, latest.id);
    return { state, automaticPlaybackEligible: false };
  }
  if (latest === null) return { state, automaticPlaybackEligible: false };
  if (input.nativeAssistantMessageIds.has(latest.id)) {
    state = markHistorical(state, latest.id);
    if (state.activeResponseMessageId === latest.id) {
      state = { ...state, activeResponseMessageId: null };
    }
    return { state, automaticPlaybackEligible: false };
  }
  if (state.historicalMessageIds.has(latest.id)) {
    return { state, automaticPlaybackEligible: false };
  }
  if (state.activeResponseMessageId === latest.id) {
    return { state, automaticPlaybackEligible: true };
  }
  state = { ...state, activeResponseMessageId: null };

  const anchor = state.localAnchor;
  if (
    anchor === null ||
    state.lastMonotonicMillis - anchor.recordedAtMonotonicMillis > LOCAL_THREAD_SPEECH_ANCHOR_MILLIS
  ) {
    state = markHistorical({ ...state, localAnchor: null }, latest.id);
    return { state, automaticPlaybackEligible: false };
  }

  const userIndex = input.feed.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      String(entry.message.id) === anchor.messageId,
  );
  const assistantIndex = input.feed.findIndex(
    (entry) => entry.type === "message" && String(entry.message.id) === latest.id,
  );
  const userEntry = userIndex < 0 ? null : input.feed[userIndex];
  const userTurnId =
    userEntry?.type === "message" && userEntry.message.role === "user"
      ? userEntry.message.turnId
      : null;
  if (
    userIndex < 0 ||
    assistantIndex <= userIndex ||
    userTurnId === null ||
    latest.turnId === null ||
    userTurnId !== latest.turnId
  ) {
    state = markHistorical(state, latest.id);
    return { state, automaticPlaybackEligible: false };
  }

  return {
    state: { ...state, localAnchor: null, activeResponseMessageId: latest.id },
    automaticPlaybackEligible: true,
  };
};

/**
 * Classifies projected assistant messages before they reach the playback
 * planner. Previewing is render-pure; only a committed React tree advances the
 * one-way historical baseline. This prevents interrupted renders from
 * consuming local anchors or reviving messages after a receipt/rebase.
 */
export class ThreadSpeechObservationGate {
  private state = initialState();

  recordLocalCommand(scopeKey: string, messageId: string, monotonicMillis: number): void {
    const state = advanceMonotonicClock(selectScope(this.state, scopeKey), monotonicMillis);
    this.state = {
      ...state,
      localAnchor: {
        messageId,
        recordedAtMonotonicMillis: state.lastMonotonicMillis,
      },
      activeResponseMessageId: null,
    };
  }

  previewAutomaticPlayback(input: ThreadSpeechObservationInput): ThreadSpeechObservationDecision {
    const baseState = this.state;
    const result = classifyObservation(baseState, input);
    let committed = false;
    return {
      automaticPlaybackEligible: result.automaticPlaybackEligible,
      commit: () => {
        if (committed) return;
        committed = true;
        if (this.state === baseState) this.state = result.state;
      },
    };
  }
}

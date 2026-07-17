// This presentation helper intentionally uses the host's local clock and cancellable timers.
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import type {
  VoiceAudioRoute,
  VoiceRealtimeContext,
  VoiceRealtimeTarget,
  VoiceRuntimeAdapter,
  VoiceRuntimeSnapshot,
  VoiceRuntimeSnapshotListener,
  VoiceThreadStartInput,
} from "./runtime.ts";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  VoiceClientActionId,
  VoiceConversationSelection,
  VoiceConversationSummary,
} from "@t3tools/contracts";

export interface VoiceRuntimeFocus {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly interactionRequired: boolean;
  readonly activeThreadBusy: boolean;
}

export interface ActiveVoiceRuntimeAttachment {
  readonly environmentId: EnvironmentId;
  readonly focus: VoiceRuntimeFocus | null;
}

export type RealtimeVoiceBarPhase = "idle" | "starting" | "active" | "stopping" | "error";

export interface VoiceAudioRoutePickerState {
  readonly selectingRouteId: VoiceAudioRoute["id"] | null;
  readonly error: string | null;
}

export function settleVoiceAudioRoutePickerSelection(
  current: VoiceAudioRoutePickerState | null,
  routeId: VoiceAudioRoute["id"],
  error?: string,
): VoiceAudioRoutePickerState | null {
  if (current?.selectingRouteId !== routeId) return current;
  return {
    ...current,
    selectingRouteId: null,
    ...(error === undefined ? {} : { error }),
  };
}

export function reconcileVoiceAudioRoutePickerState(
  current: VoiceAudioRoutePickerState | null,
  input: {
    readonly controlsAvailable: boolean;
    readonly routes: ReadonlyArray<VoiceAudioRoute> | null;
  },
): VoiceAudioRoutePickerState | null {
  if (current === null) return null;
  if (!input.controlsAvailable || input.routes === null) return null;
  const selectingRouteId = current.selectingRouteId;
  if (selectingRouteId === null) return current;
  const selected = input.routes.find((route) => route.id === selectingRouteId);
  if (selected?.selected === true) return { ...current, selectingRouteId: null };
  if (selected === undefined) {
    return {
      selectingRouteId: null,
      error: "The selected audio route is no longer available.",
    };
  }
  return current;
}

export interface AdmittedClientActionFocus {
  readonly actionId: VoiceClientActionId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

/** Portable preference fields needed to configure a native Thread voice session. */
export interface ThreadVoiceStartPreferences {
  readonly autoListenEnabled: boolean;
  readonly autoSubmitEnabled: boolean;
  readonly endSilenceMs: number;
  readonly noSpeechTimeoutMs: number | null;
  readonly maximumUtteranceMs: number;
  readonly postPlaybackGuardMs: number;
  readonly transcriptionTimeoutMs: number;
  readonly submissionTimeoutMs: number;
  readonly responseTimeoutMs: number;
}

export function threadVoiceStartForFocus(
  focus: VoiceRuntimeFocus | null,
  preferences: ThreadVoiceStartPreferences,
  playResponses: boolean,
): VoiceThreadStartInput | null {
  if (focus === null) return null;
  return {
    target: {
      environmentId: focus.environmentId,
      projectId: focus.projectId,
      threadId: focus.threadId,
      modelSelection: focus.modelSelection,
      runtimeMode: focus.runtimeMode,
      interactionMode: focus.interactionMode,
    },
    settings: {
      submission: preferences.autoSubmitEnabled ? "auto-submit" : "review",
      playResponses,
      autoRearm: preferences.autoListenEnabled,
      endpointDetection: {
        endSilenceMs: preferences.endSilenceMs,
        noSpeechTimeoutMs: preferences.noSpeechTimeoutMs,
        maximumUtteranceMs: preferences.maximumUtteranceMs,
      },
      rearmDelayMs: preferences.postPlaybackGuardMs,
      transcriptionTimeoutMs: preferences.transcriptionTimeoutMs,
      submissionTimeoutMs: preferences.submissionTimeoutMs,
      responseTimeoutMs: preferences.responseTimeoutMs,
    },
  };
}

export function canOfferThreadVoiceSwitch(input: {
  readonly preferencesReady: boolean;
  readonly composerDraftsReady: boolean;
  readonly composerContentEmpty: boolean;
  readonly interactionRequired: boolean;
  readonly activeThreadBusy: boolean;
}): boolean {
  return (
    input.preferencesReady &&
    input.composerDraftsReady &&
    input.composerContentEmpty &&
    !input.interactionRequired &&
    !input.activeThreadBusy
  );
}

export function isThreadVoiceStartAvailable(
  snapshot: VoiceRuntimeSnapshot,
  hasPreparedConnection: boolean,
): boolean {
  if (snapshot.mode === "realtime") return snapshot.phase === "connected";
  return snapshot.mode === "idle" && hasPreparedConnection;
}

export function voiceRuntimeCommandEnvironmentMatches(
  expectedEnvironmentId: EnvironmentId,
  readyEnvironmentId: EnvironmentId | null,
  controllerEnvironmentId: EnvironmentId | null,
): boolean {
  return (
    readyEnvironmentId === expectedEnvironmentId &&
    controllerEnvironmentId === expectedEnvironmentId
  );
}

export interface PendingVoiceRuntimeAttachment<Runtime> {
  readonly runtime: Runtime;
  readonly detach: () => void;
}

export interface VoiceRuntimeRetryCoordinator {
  readonly isCancelled: () => boolean;
  readonly run: <Value>(operation: () => Promise<Value>) => Promise<Value | null>;
  readonly cancel: () => void;
}

const VOICE_RUNTIME_RETRY_DELAYS_MS = [250, 1_000, 4_000, 10_000] as const;

/** Runs one native attachment operation with cancellable backoff capped at the final delay. */
export function createVoiceRuntimeRetryCoordinator(
  retryDelaysMs: ReadonlyArray<number> = VOICE_RUNTIME_RETRY_DELAYS_MS,
  onPersistentFailure?: (cause: unknown) => void,
): VoiceRuntimeRetryCoordinator {
  let cancelled = false;
  let persistentFailureReported = false;
  let pendingDelay: {
    readonly timer: ReturnType<typeof setTimeout>;
    readonly resolve: () => void;
  } | null = null;

  const wait = (delayMs: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        pendingDelay = null;
        resolve();
      };
      pendingDelay = { timer: setTimeout(finish, delayMs), resolve: finish };
    });

  return {
    isCancelled: () => cancelled,
    run: async <Value>(operation: () => Promise<Value>): Promise<Value | null> => {
      for (let attempt = 0; ; attempt += 1) {
        if (cancelled) return null;
        try {
          const value = await operation();
          return cancelled ? null : value;
        } catch (cause) {
          if (cancelled) return null;
          if (retryDelaysMs.length === 0) throw cause;
          if (!persistentFailureReported && attempt >= retryDelaysMs.length) {
            persistentFailureReported = true;
            onPersistentFailure?.(cause);
          }
          const retryDelayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
          if (retryDelayMs === undefined) throw cause;
          await wait(retryDelayMs);
        }
      }
    },
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      const delay = pendingDelay;
      if (delay === null) return;
      clearTimeout(delay.timer);
      delay.resolve();
    },
  };
}

export interface VoiceConversationBrowserBinding {
  /** Forces React to discard rows loaded for a previous environment. */
  readonly mountKey: EnvironmentId;
  readonly targetFor: (conversation: VoiceConversationSelection) => VoiceRealtimeTarget;
}

export function bindVoiceConversationBrowser(
  environmentId: EnvironmentId,
  context: VoiceRealtimeContext,
): VoiceConversationBrowserBinding {
  return {
    mountKey: environmentId,
    targetFor: (conversation) => ({
      environmentId,
      conversation,
      focus: context.focus,
      threadSwitch: context.threadSwitch,
    }),
  };
}

/** Subscribes and hydrates before exposing a runtime as command-capable. */
export async function prepareVoiceRuntimeAttachment<
  Runtime extends { readonly adapter: Pick<VoiceRuntimeAdapter, "subscribe"> },
>(input: {
  readonly runtime: Runtime;
  readonly listener: VoiceRuntimeSnapshotListener;
  readonly isDisposed: () => boolean;
}): Promise<PendingVoiceRuntimeAttachment<Runtime> | null> {
  const detach = await input.runtime.adapter.subscribe(input.listener);
  if (input.isDisposed()) {
    detach();
    return null;
  }
  return { runtime: input.runtime, detach };
}

export function voiceRuntimeSnapshotEnvironmentId(
  snapshot: VoiceRuntimeSnapshot,
): EnvironmentId | null {
  switch (snapshot.mode) {
    case "realtime":
    case "switching-to-thread":
    case "switching-to-realtime":
    case "thread":
      return snapshot.target.environmentId;
    case "failed":
      return snapshot.environmentId;
    case "idle":
      return null;
  }
}

export async function stopVoiceRuntimeStrict(
  runtime: { readonly adapter: Pick<VoiceRuntimeAdapter, "stop"> } | null,
): Promise<void> {
  if (runtime === null) throw new Error("Native voice controls are unavailable");
  await runtime.adapter.stop();
}

/** Presentation ownership for the dedicated Realtime call bar. */
export function realtimeVoiceBarPhase(snapshot: VoiceRuntimeSnapshot): RealtimeVoiceBarPhase {
  switch (snapshot.mode) {
    case "idle":
    case "thread":
      return "idle";
    case "failed":
      return snapshot.operation === "thread" ? "idle" : "error";
    case "switching-to-thread":
      return "stopping";
    case "switching-to-realtime":
      return "starting";
    case "realtime":
      if (snapshot.phase === "starting") return "starting";
      if (snapshot.phase === "stopping") return "stopping";
      return "active";
  }
}

export function admittedClientActionFocusState(
  admitted: AdmittedClientActionFocus | null,
  visible: VoiceRuntimeFocus | null,
): "none" | "waiting" | "admitted" {
  if (admitted === null) return "none";
  return visible?.environmentId === admitted.environmentId &&
    visible.projectId === admitted.projectId &&
    visible.threadId === admitted.threadId
    ? "admitted"
    : "waiting";
}

export function durableVoiceConversations(
  conversations: ReadonlyArray<VoiceConversationSummary>,
): ReadonlyArray<VoiceConversationSummary> {
  return conversations
    .filter((conversation) => conversation.retention === "durable")
    .sort(
      (left, right) =>
        (right.lastCallAt ?? right.createdAt).localeCompare(left.lastCallAt ?? left.createdAt) ||
        left.conversationId.localeCompare(right.conversationId),
    );
}

const padDatePart = (value: number): string => String(value).padStart(2, "0");

export function newVoiceConversationTitle(now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())}`;
  const time = `${padDatePart(now.getHours())}:${padDatePart(now.getMinutes())}`;
  return `Voice · ${date} ${time}`;
}

export function resumeVoiceConversationSelection(
  conversations: ReadonlyArray<VoiceConversationSummary>,
  now: Date = new Date(),
): VoiceConversationSelection {
  const latest = durableVoiceConversations(conversations)[0];
  return latest === undefined
    ? {
        type: "new",
        retention: "durable",
        title: newVoiceConversationTitle(now),
      }
    : {
        type: "continue",
        conversationId: latest.conversationId,
        takeover: false,
      };
}

export function newVoiceConversationSelection(now: Date = new Date()): VoiceConversationSelection {
  return {
    type: "new",
    retention: "durable",
    title: newVoiceConversationTitle(now),
  };
}

export function continueVoiceConversationSelection(
  conversationId: VoiceConversationSummary["conversationId"],
): VoiceConversationSelection {
  return { type: "continue", conversationId, takeover: false };
}

export function voiceRuntimeEnvironmentId(
  activeEnvironmentId: EnvironmentId | null,
  focus: VoiceRuntimeFocus | null,
  fallbackEnvironmentId: EnvironmentId | null = null,
): EnvironmentId | null {
  return activeEnvironmentId ?? focus?.environmentId ?? fallbackEnvironmentId;
}

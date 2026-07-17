import type {
  VoiceRealtimeContext,
  VoiceRealtimeTarget,
  VoiceRuntimeAdapter,
  VoiceRuntimeSnapshot,
  VoiceRuntimeSnapshotListener,
  VoiceThreadStartInput,
} from "@t3tools/client-runtime/voice";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  VoiceClientActionId,
  VoiceConversationSelection,
  VoiceConversationSummary,
} from "@t3tools/contracts";

import type { ResolvedVoicePreferences } from "./voicePreferences";

export interface MasterVoiceFocus {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly interactionRequired: boolean;
}

export interface ActiveMasterVoiceAttachment {
  readonly environmentId: EnvironmentId;
  readonly focus: MasterVoiceFocus | null;
}

export type MasterVoicePhase = "idle" | "starting" | "active" | "stopping" | "error";

export interface AdmittedClientActionFocus {
  readonly actionId: VoiceClientActionId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

export function threadVoiceStartForFocus(
  focus: MasterVoiceFocus | null,
  preferences: ResolvedVoicePreferences,
  playResponses: boolean,
): VoiceThreadStartInput | null {
  if (focus === null) return null;
  return {
    target: {
      environmentId: focus.environmentId,
      projectId: focus.projectId,
      threadId: focus.threadId,
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
  readonly composerDraftsReady: boolean;
  readonly draftText: string;
  readonly attachmentCount: number;
  readonly interactionRequired: boolean;
}): boolean {
  return (
    input.composerDraftsReady &&
    input.draftText.trim().length === 0 &&
    input.attachmentCount === 0 &&
    !input.interactionRequired
  );
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

export class VoiceStartAdmission {
  private running = false;

  get active(): boolean {
    return this.running;
  }

  async run(operation: () => Promise<void>): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await operation();
      return true;
    } finally {
      this.running = false;
    }
  }
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
    case "thread":
      return snapshot.target.environmentId;
    case "idle":
    case "failed":
      return null;
  }
}

export function voiceRuntimePresentationPhase(snapshot: VoiceRuntimeSnapshot): MasterVoicePhase {
  switch (snapshot.mode) {
    case "idle":
      return "idle";
    case "failed":
      return "error";
    case "switching-to-thread":
      return "starting";
    case "realtime":
      if (snapshot.phase === "starting") return "starting";
      if (snapshot.phase === "stopping") return "stopping";
      return "active";
    case "thread":
      if (snapshot.phase === "starting" || snapshot.phase === "rearming") return "starting";
      if (snapshot.phase === "stopping") return "stopping";
      return "active";
  }
}

export function admittedClientActionFocusState(
  admitted: AdmittedClientActionFocus | null,
  visible: MasterVoiceFocus | null,
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

export function masterVoiceEnvironmentId(
  activeEnvironmentId: EnvironmentId | null,
  focus: MasterVoiceFocus | null,
  fallbackEnvironmentId: EnvironmentId | null = null,
): EnvironmentId | null {
  return activeEnvironmentId ?? focus?.environmentId ?? fallbackEnvironmentId;
}

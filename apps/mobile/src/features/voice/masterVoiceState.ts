import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationSelection,
  VoiceConversationSummary,
} from "@t3tools/contracts";

export interface MasterVoiceFocus {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
}

export interface ActiveMasterVoiceAttachment {
  readonly environmentId: EnvironmentId;
  readonly focus: MasterVoiceFocus;
}

export type MasterVoiceFocusReconciliation =
  | { readonly type: "preserve" }
  | { readonly type: "update"; readonly attachment: ActiveMasterVoiceAttachment }
  | { readonly type: "stop" };

export function durableVoiceConversations(
  conversations: ReadonlyArray<VoiceConversationSummary>,
): ReadonlyArray<VoiceConversationSummary> {
  return conversations
    .filter((conversation) => conversation.retention === "durable")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function resumeVoiceConversationSelection(
  conversations: ReadonlyArray<VoiceConversationSummary>,
): VoiceConversationSelection {
  const latest = durableVoiceConversations(conversations)[0];
  return latest === undefined
    ? { type: "new", retention: "durable", title: "T3 Voice" }
    : { type: "continue", conversationId: latest.conversationId, takeover: false };
}

export function masterVoiceEnvironmentId(
  activeEnvironmentId: EnvironmentId | null,
  focus: MasterVoiceFocus | null,
): EnvironmentId | null {
  return activeEnvironmentId ?? focus?.environmentId ?? null;
}

export function isSameMasterVoiceFocus(
  left: MasterVoiceFocus | null,
  right: MasterVoiceFocus | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.environmentId === right.environmentId &&
      left.projectId === right.projectId &&
      left.threadId === right.threadId)
  );
}

/** Keeps a call alive while navigating locally, but never carries it across environments. */
export function reconcileMasterVoiceFocus(
  attachment: ActiveMasterVoiceAttachment | null,
  focus: MasterVoiceFocus | null,
): MasterVoiceFocusReconciliation {
  if (attachment === null || focus === null) return { type: "preserve" };
  if (attachment.environmentId !== focus.environmentId) return { type: "stop" };
  if (isSameMasterVoiceFocus(attachment.focus, focus)) return { type: "preserve" };
  return { type: "update", attachment: { ...attachment, focus } };
}

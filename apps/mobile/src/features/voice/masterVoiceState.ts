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

export interface PersistedVoiceThreadTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly generation: number;
}

export interface ActiveMasterVoiceAttachment {
  readonly environmentId: EnvironmentId;
  readonly focus: MasterVoiceFocus | null;
}

export type MasterVoiceFocusReconciliation =
  | { readonly type: "preserve" }
  | {
      readonly type: "refresh";
      readonly attachment: ActiveMasterVoiceAttachment;
    }
  | {
      readonly type: "update";
      readonly attachment: ActiveMasterVoiceAttachment;
    }
  | { readonly type: "stop" };

export class VoiceFocusUpdateQueue {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  invalidate(): void {
    this.generation += 1;
  }

  enqueue(run: () => Promise<void>, commit: () => void): Promise<boolean> {
    const generation = ++this.generation;
    const update = this.tail.then(async () => {
      if (generation !== this.generation) return false;
      await run();
      if (generation !== this.generation) return false;
      commit();
      return true;
    });
    this.tail = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }
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

export function masterVoiceControllerEnvironmentId(input: {
  readonly nativeOwnerChecked: boolean;
  readonly nativeSessionId: string | null;
  readonly nativeOwnerEnvironmentId: EnvironmentId | null;
  readonly nativeOwnerFallbackEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly focus: MasterVoiceFocus | null;
  readonly fallbackEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  if (!input.nativeOwnerChecked) return null;
  if (input.nativeSessionId !== null)
    return input.nativeOwnerEnvironmentId ?? input.nativeOwnerFallbackEnvironmentId;
  return masterVoiceEnvironmentId(
    input.activeEnvironmentId,
    input.focus,
    input.fallbackEnvironmentId,
  );
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

export function nextVoiceThreadTarget(
  current: PersistedVoiceThreadTarget | null | undefined,
  focus: MasterVoiceFocus | null,
): PersistedVoiceThreadTarget | null {
  if (focus === null) return null;
  if (current?.environmentId === focus.environmentId && current.threadId === focus.threadId) {
    return null;
  }
  return {
    environmentId: focus.environmentId,
    threadId: focus.threadId,
    generation: Math.max(1, (current?.generation ?? 0) + 1),
  };
}

/** Keeps a call alive while navigating locally, but never carries it across environments. */
export function reconcileMasterVoiceFocus(
  attachment: ActiveMasterVoiceAttachment | null,
  focus: MasterVoiceFocus | null,
): MasterVoiceFocusReconciliation {
  if (attachment === null || focus === null) return { type: "preserve" };
  if (attachment.environmentId !== focus.environmentId) return { type: "stop" };
  if (isSameMasterVoiceFocus(attachment.focus, focus))
    return attachment.focus?.threadTitle === focus.threadTitle
      ? { type: "preserve" }
      : { type: "refresh", attachment: { ...attachment, focus } };
  return { type: "update", attachment: { ...attachment, focus } };
}

export function shouldRevokeUnavailableVoiceEnvironment(input: {
  readonly nativeOwnerChecked: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly catalogLoading: boolean;
  readonly environmentAvailable: boolean;
}): boolean {
  return (
    input.nativeOwnerChecked &&
    !input.catalogLoading &&
    (input.environmentId === null || !input.environmentAvailable)
  );
}

export function shouldRetireUnresolvableNativeVoiceOwner(input: {
  readonly nativeOwnerChecked: boolean;
  readonly catalogLoading: boolean;
  readonly environmentOrigin: string | null;
  readonly environmentId: EnvironmentId | null;
}): boolean {
  return (
    input.nativeOwnerChecked &&
    !input.catalogLoading &&
    input.environmentOrigin !== null &&
    input.environmentId === null
  );
}

export async function refreshMasterVoiceForeground(input: {
  readonly refreshPermissions: () => Promise<void>;
  readonly refreshOwnership: () => Promise<unknown>;
  readonly reconcileRuntime: () => Promise<void>;
  readonly onPermissionsUnavailable: () => void;
}): Promise<void> {
  const [permissions] = await Promise.allSettled([
    input.refreshPermissions(),
    input.refreshOwnership(),
    input.reconcileRuntime(),
  ]);
  if (permissions.status === "rejected") input.onPermissionsUnavailable();
}

export interface NativeRealtimeOwnerState {
  readonly checked: boolean;
  readonly sequence: number;
  readonly sessionId: string | null;
  readonly environmentOrigin: string | null;
}

export function acceptNativeRealtimeOwnerState(
  current: NativeRealtimeOwnerState,
  next: Omit<NativeRealtimeOwnerState, "checked">,
): NativeRealtimeOwnerState {
  return next.sequence < current.sequence ? current : { checked: true, ...next };
}

export function restoreMasterVoiceAttachment(input: {
  readonly environmentId: EnvironmentId;
  readonly persistedFocus: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  } | null;
  readonly visibleFocus: MasterVoiceFocus | null;
  readonly threadTitle: (threadId: ThreadId) => string;
}): ActiveMasterVoiceAttachment {
  if (input.persistedFocus !== null) {
    return {
      environmentId: input.environmentId,
      focus: {
        environmentId: input.environmentId,
        projectId: input.persistedFocus.projectId,
        threadId: input.persistedFocus.threadId,
        threadTitle: input.threadTitle(input.persistedFocus.threadId),
      },
    };
  }
  return {
    environmentId: input.environmentId,
    focus: input.visibleFocus?.environmentId === input.environmentId ? input.visibleFocus : null,
  };
}

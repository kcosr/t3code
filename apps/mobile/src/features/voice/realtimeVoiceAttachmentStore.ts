import type { ProjectId, ThreadId, VoiceSessionEvent, VoiceSessionId } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";

export type RealtimeVoicePendingEvent = Extract<
  VoiceSessionEvent,
  | { readonly type: "confirmation-required" }
  | { readonly type: "client-action"; readonly action: "activate-thread" }
>;

export interface RealtimeVoiceAttachmentRecord {
  readonly ownerId: string;
  readonly environmentOrigin: string;
  readonly sessionId: VoiceSessionId;
  readonly afterSequence: number;
  readonly focus: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  } | null;
  readonly pendingEvents: ReadonlyArray<RealtimeVoicePendingEvent>;
}

export interface RealtimeVoiceAttachmentStore {
  readonly load: () => Promise<RealtimeVoiceAttachmentRecord | null>;
  readonly replace: (record: RealtimeVoiceAttachmentRecord) => Promise<void>;
  readonly update: (record: RealtimeVoiceAttachmentRecord) => Promise<boolean>;
  readonly clear: (sessionId: VoiceSessionId, ownerId: string) => Promise<boolean>;
}

interface AttachmentStorage {
  readonly getItemAsync: (key: string) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string) => Promise<void>;
  readonly deleteItemAsync: (key: string) => Promise<void>;
}

const STORAGE_KEY = "t3.voice.realtime-attachment.v1";

const normalizedOrigin = (origin: string): string => new URL(origin).origin;
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const decodePendingEvent = (value: unknown): RealtimeVoicePendingEvent | null => {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (
    !isNonEmptyString(event.sessionId) ||
    !Number.isSafeInteger(event.leaseGeneration) ||
    (event.leaseGeneration as number) <= 0 ||
    !Number.isSafeInteger(event.sequence) ||
    (event.sequence as number) < 0 ||
    !isNonEmptyString(event.occurredAt) ||
    !isNonEmptyString(event.expiresAt)
  ) {
    return null;
  }
  if (event.type === "confirmation-required") {
    if (
      !isNonEmptyString(event.confirmationId) ||
      !isNonEmptyString(event.toolCallId) ||
      !isNonEmptyString(event.tool) ||
      !isNonEmptyString(event.summary)
    ) {
      return null;
    }
    return value as RealtimeVoicePendingEvent;
  }
  if (event.type === "client-action" && event.action === "activate-thread") {
    if (
      !isNonEmptyString(event.actionId) ||
      !isNonEmptyString(event.projectId) ||
      !isNonEmptyString(event.threadId)
    ) {
      return null;
    }
    return value as RealtimeVoicePendingEvent;
  }
  return null;
};

const decodeRecord = (value: string | null): RealtimeVoiceAttachmentRecord | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const focus = record.focus;
    if (
      !isNonEmptyString(record.ownerId) ||
      typeof record.environmentOrigin !== "string" ||
      !isNonEmptyString(record.sessionId) ||
      !Number.isSafeInteger(record.afterSequence) ||
      (record.afterSequence as number) < 0 ||
      !Array.isArray(record.pendingEvents) ||
      !(
        focus === null ||
        (typeof focus === "object" &&
          focus !== null &&
          isNonEmptyString((focus as Record<string, unknown>).projectId) &&
          isNonEmptyString((focus as Record<string, unknown>).threadId))
      )
    ) {
      return null;
    }
    const pendingEvents = record.pendingEvents.map(decodePendingEvent);
    if (
      pendingEvents.some(
        (event) => event === null || event.sessionId !== (record.sessionId as VoiceSessionId),
      )
    )
      return null;
    return {
      ownerId: record.ownerId,
      environmentOrigin: normalizedOrigin(record.environmentOrigin),
      sessionId: record.sessionId as VoiceSessionId,
      afterSequence: record.afterSequence as number,
      focus:
        focus === null
          ? null
          : {
              projectId: (focus as Record<string, unknown>).projectId as ProjectId,
              threadId: (focus as Record<string, unknown>).threadId as ThreadId,
            },
      pendingEvents: pendingEvents as ReadonlyArray<RealtimeVoicePendingEvent>,
    };
  } catch {
    return null;
  }
};

const encodeRecord = (record: RealtimeVoiceAttachmentRecord): string =>
  JSON.stringify({ ...record, environmentOrigin: normalizedOrigin(record.environmentOrigin) });

export function makeRealtimeVoiceAttachmentStore(
  storage: AttachmentStorage,
): RealtimeVoiceAttachmentStore {
  let queue = Promise.resolve();
  const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    load: () => serialize(async () => decodeRecord(await storage.getItemAsync(STORAGE_KEY))),
    replace: (record) => serialize(() => storage.setItemAsync(STORAGE_KEY, encodeRecord(record))),
    update: (record) =>
      serialize(async () => {
        const current = decodeRecord(await storage.getItemAsync(STORAGE_KEY));
        if (current !== null) {
          if (current.sessionId !== record.sessionId || current.ownerId !== record.ownerId)
            return false;
        }
        await storage.setItemAsync(STORAGE_KEY, encodeRecord(record));
        return true;
      }),
    clear: (sessionId, ownerId) =>
      serialize(async () => {
        const current = decodeRecord(await storage.getItemAsync(STORAGE_KEY));
        if (current?.sessionId !== sessionId || current.ownerId !== ownerId) return false;
        await storage.deleteItemAsync(STORAGE_KEY);
        return true;
      }),
  };
}

/** A single record is sufficient because Android permits one native Realtime owner. */
export const realtimeVoiceAttachmentStore = makeRealtimeVoiceAttachmentStore(SecureStore);

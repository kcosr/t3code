/**
 * Origin-wide single leader election for voice media ownership.
 *
 * Environment is a property of the owner, not the lock key — one physical mic
 * cannot safely be shared across two leaders on the same origin.
 */

export type VoiceMultiTabRole = "leader" | "follower";

export interface VoiceMultiTabLockSnapshot {
  readonly role: VoiceMultiTabRole;
  readonly leaderTabId: string | null;
  readonly ownerEnvironmentId: string | null;
}

export interface VoiceMultiTabLock {
  readonly tabId: string;
  readonly getSnapshot: () => VoiceMultiTabLockSnapshot;
  readonly subscribe: (listener: (snapshot: VoiceMultiTabLockSnapshot) => void) => () => void;
  /** Attempt to become the origin-wide voice leader. */
  readonly acquire: (ownerEnvironmentId: string | null) => Promise<boolean>;
  /** Update the environment property of the current leader without re-electing. */
  readonly setOwnerEnvironment: (ownerEnvironmentId: string | null) => void;
  /** Release leadership if this tab holds it. */
  readonly release: () => void;
  /** Ask the current leader to stop so this tab can take over. */
  readonly requestTakeover: () => Promise<boolean>;
  readonly dispose: () => void;
}

type LockMessage =
  | {
      readonly type: "announce";
      readonly tabId: string;
      readonly ownerEnvironmentId: string | null;
      readonly generation: number;
    }
  | {
      readonly type: "release";
      readonly tabId: string;
      readonly generation: number;
    }
  | {
      readonly type: "takeover-request";
      readonly fromTabId: string;
      readonly requestId: string;
    }
  | {
      readonly type: "takeover-ack";
      readonly requestId: string;
      readonly fromTabId: string;
      readonly accepted: boolean;
    }
  | {
      readonly type: "probe";
      readonly fromTabId: string;
    };

const CHANNEL_NAME = "t3code:voice-origin-lock";
const STORAGE_KEY = "t3code:voice-origin-lock-leader";
const TAKEOVER_TIMEOUT_MS = 4_000;

interface StoredLeader {
  readonly tabId: string;
  readonly ownerEnvironmentId: string | null;
  readonly generation: number;
  readonly updatedAt: number;
}

const createTabId = (): string => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const readStoredLeader = (): StoredLeader | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredLeader;
    if (
      typeof parsed.tabId !== "string" ||
      typeof parsed.generation !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeStoredLeader = (leader: StoredLeader | null): void => {
  try {
    if (leader === null) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(leader));
  } catch {
    // Private mode / blocked storage — fall back to BroadcastChannel only.
  }
};

export interface MakeVoiceMultiTabLockInput {
  readonly channelName?: string;
  readonly tabId?: string;
  readonly onTakeoverRequest?: () => Promise<void> | void;
  readonly now?: () => number;
}

export function makeVoiceMultiTabLock(input: MakeVoiceMultiTabLockInput = {}): VoiceMultiTabLock {
  const tabId = input.tabId ?? createTabId();
  const channelName = input.channelName ?? CHANNEL_NAME;
  const now = input.now ?? (() => Date.now());
  const listeners = new Set<(snapshot: VoiceMultiTabLockSnapshot) => void>();
  let disposed = false;
  let generation = 0;
  let leaderTabId: string | null = null;
  let ownerEnvironmentId: string | null = null;
  const pendingTakeovers = new Map<
    string,
    {
      readonly resolve: (accepted: boolean) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;

  const roleOf = (): VoiceMultiTabRole => {
    // No elected leader → this tab is free to acquire (not a follower of anyone).
    if (leaderTabId === null || leaderTabId === tabId) return "leader";
    return "follower";
  };

  const publish = () => {
    const snapshot: VoiceMultiTabLockSnapshot = {
      role: roleOf(),
      leaderTabId,
      ownerEnvironmentId,
    };
    for (const listener of listeners) listener(snapshot);
  };

  const becomeLeader = (environmentId: string | null) => {
    generation += 1;
    leaderTabId = tabId;
    ownerEnvironmentId = environmentId;
    writeStoredLeader({
      tabId,
      ownerEnvironmentId: environmentId,
      generation,
      updatedAt: now(),
    });
    channel?.postMessage({
      type: "announce",
      tabId,
      ownerEnvironmentId: environmentId,
      generation,
    } satisfies LockMessage);
    publish();
  };

  const clearLeadership = () => {
    if (leaderTabId === tabId) {
      writeStoredLeader(null);
      channel?.postMessage({
        type: "release",
        tabId,
        generation,
      } satisfies LockMessage);
    }
    leaderTabId = null;
    ownerEnvironmentId = null;
    publish();
  };

  const handleMessage = (message: LockMessage) => {
    if (disposed) return;
    switch (message.type) {
      case "announce": {
        if (message.tabId === tabId) return;
        if (leaderTabId === tabId && message.generation <= generation) {
          // Another tab claimed leadership while we thought we owned it — yield if
          // their generation is higher (takeover completed elsewhere).
          if (message.generation > generation) {
            leaderTabId = message.tabId;
            ownerEnvironmentId = message.ownerEnvironmentId;
            generation = message.generation;
            publish();
          }
          return;
        }
        leaderTabId = message.tabId;
        ownerEnvironmentId = message.ownerEnvironmentId;
        generation = Math.max(generation, message.generation);
        publish();
        return;
      }
      case "release": {
        if (leaderTabId === message.tabId) {
          leaderTabId = null;
          ownerEnvironmentId = null;
          publish();
        }
        return;
      }
      case "probe": {
        if (leaderTabId === tabId) {
          channel?.postMessage({
            type: "announce",
            tabId,
            ownerEnvironmentId,
            generation,
          } satisfies LockMessage);
        }
        return;
      }
      case "takeover-request": {
        if (leaderTabId !== tabId) return;
        void (async () => {
          let accepted = false;
          try {
            await input.onTakeoverRequest?.();
            accepted = true;
            clearLeadership();
          } catch {
            accepted = false;
          }
          channel?.postMessage({
            type: "takeover-ack",
            requestId: message.requestId,
            fromTabId: tabId,
            accepted,
          } satisfies LockMessage);
        })();
        return;
      }
      case "takeover-ack": {
        const pending = pendingTakeovers.get(message.requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pendingTakeovers.delete(message.requestId);
        pending.resolve(message.accepted);
        return;
      }
    }
  };

  if (channel !== null) {
    channel.onmessage = (event: MessageEvent<LockMessage>) => {
      if (event.data && typeof event.data === "object" && "type" in event.data) {
        handleMessage(event.data);
      }
    };
  }

  // Seed from storage + probe for a live leader.
  const stored = readStoredLeader();
  if (stored !== null) {
    leaderTabId = stored.tabId;
    ownerEnvironmentId = stored.ownerEnvironmentId;
    generation = stored.generation;
  }
  channel?.postMessage({ type: "probe", fromTabId: tabId } satisfies LockMessage);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    if (event.newValue === null) {
      if (leaderTabId !== tabId) {
        leaderTabId = null;
        ownerEnvironmentId = null;
        publish();
      }
      return;
    }
    try {
      const next = JSON.parse(event.newValue) as StoredLeader;
      if (next.tabId !== tabId) {
        leaderTabId = next.tabId;
        ownerEnvironmentId = next.ownerEnvironmentId;
        generation = next.generation;
        publish();
      }
    } catch {
      // ignore
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return {
    tabId,
    getSnapshot: () => ({
      role: roleOf(),
      leaderTabId,
      ownerEnvironmentId,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      listener({
        role: roleOf(),
        leaderTabId,
        ownerEnvironmentId,
      });
      return () => {
        listeners.delete(listener);
      };
    },
    acquire: async (environmentId) => {
      if (disposed) return false;
      if (leaderTabId === tabId) {
        ownerEnvironmentId = environmentId;
        writeStoredLeader({
          tabId,
          ownerEnvironmentId: environmentId,
          generation,
          updatedAt: now(),
        });
        channel?.postMessage({
          type: "announce",
          tabId,
          ownerEnvironmentId: environmentId,
          generation,
        } satisfies LockMessage);
        publish();
        return true;
      }
      if (leaderTabId !== null && leaderTabId !== tabId) {
        // Probe for a live leader; reclaim if they do not answer (crashed tab).
        if (channel === null) {
          becomeLeader(environmentId);
          return true;
        }
        let heardLiveLeader = false;
        const previousOnMessage = channel.onmessage;
        channel.onmessage = (event: MessageEvent<LockMessage>) => {
          previousOnMessage?.call(channel, event);
          const data = event.data;
          if (
            data &&
            typeof data === "object" &&
            data.type === "announce" &&
            data.tabId !== tabId
          ) {
            heardLiveLeader = true;
          }
        };
        channel.postMessage({ type: "probe", fromTabId: tabId } satisfies LockMessage);
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        channel.onmessage = previousOnMessage;
        if (disposed) return false;
        if (leaderTabId === tabId) {
          ownerEnvironmentId = environmentId;
          publish();
          return true;
        }
        if (heardLiveLeader) {
          return false;
        }
        // Silence → reclaim stale lock left by a crashed leader.
        becomeLeader(environmentId);
        return true;
      }
      becomeLeader(environmentId);
      return true;
    },
    setOwnerEnvironment: (environmentId) => {
      if (leaderTabId !== tabId) return;
      ownerEnvironmentId = environmentId;
      writeStoredLeader({
        tabId,
        ownerEnvironmentId: environmentId,
        generation,
        updatedAt: now(),
      });
      channel?.postMessage({
        type: "announce",
        tabId,
        ownerEnvironmentId: environmentId,
        generation,
      } satisfies LockMessage);
      publish();
    },
    release: () => {
      if (leaderTabId === tabId) clearLeadership();
    },
    requestTakeover: () =>
      new Promise<boolean>((resolve) => {
        if (disposed || leaderTabId === null || leaderTabId === tabId) {
          resolve(leaderTabId === tabId || leaderTabId === null);
          return;
        }
        if (channel === null) {
          // No channel: force-claim (best effort single-tab environments).
          becomeLeader(null);
          resolve(true);
          return;
        }
        const requestId = createTabId();
        const timer = setTimeout(() => {
          pendingTakeovers.delete(requestId);
          // Leader unresponsive — force claim so the user can recover.
          becomeLeader(null);
          resolve(true);
        }, TAKEOVER_TIMEOUT_MS);
        pendingTakeovers.set(requestId, {
          resolve: (accepted) => {
            if (accepted) {
              becomeLeader(null);
            }
            resolve(accepted);
          },
          timer,
        });
        channel.postMessage({
          type: "takeover-request",
          fromTabId: tabId,
          requestId,
        } satisfies LockMessage);
      }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const pending of pendingTakeovers.values()) {
        clearTimeout(pending.timer);
        pending.resolve(false);
      }
      pendingTakeovers.clear();
      if (leaderTabId === tabId) clearLeadership();
      channel?.close();
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
      listeners.clear();
    },
  };
}

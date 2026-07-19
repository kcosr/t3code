import { afterEach, describe, expect, it, vi } from "vitest";

import { makeVoiceMultiTabLock } from "./multiTabLock";

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe("makeVoiceMultiTabLock", () => {
  const originalBroadcast = globalThis.BroadcastChannel;
  const originalLocalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.BroadcastChannel = originalBroadcast;
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it("elects a leader and rejects a second tab until takeover", async () => {
    const channels: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      postMessage: (data: unknown) => void;
    }> = [];
    // @ts-expect-error test double
    globalThis.BroadcastChannel = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(_name: string) {
        channels.push(this);
      }
      postMessage(data: unknown) {
        for (const channel of channels) {
          if (channel === this) continue;
          channel.onmessage?.({ data } as MessageEvent);
        }
      }
      close() {
        // no-op
      }
    };
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      configurable: true,
    });

    const first = makeVoiceMultiTabLock({ tabId: "tab-a", channelName: "test-voice-lock" });
    const second = makeVoiceMultiTabLock({ tabId: "tab-b", channelName: "test-voice-lock" });

    await expect(first.acquire("env-1")).resolves.toBe(true);
    expect(first.getSnapshot().role).toBe("leader");

    // Let the announce propagate.
    await expect(second.acquire("env-2")).resolves.toBe(false);
    expect(second.getSnapshot().role).toBe("follower");

    first.release();
    await expect(second.acquire("env-2")).resolves.toBe(true);
    expect(second.getSnapshot().role).toBe("leader");

    first.dispose();
    second.dispose();
  });

  it("breaks simultaneous equal-generation announces by tabId", async () => {
    type Channel = {
      onmessage: ((event: MessageEvent) => void) | null;
      postMessage: (data: unknown) => void;
      pending: unknown[];
    };
    const channels: Channel[] = [];
    let deliver = false;
    // @ts-expect-error test double
    globalThis.BroadcastChannel = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      pending: unknown[] = [];
      constructor(_name: string) {
        channels.push(this as unknown as Channel);
      }
      postMessage(data: unknown) {
        for (const channel of channels) {
          if (channel === (this as unknown as Channel)) continue;
          if (!deliver) {
            channel.pending.push(data);
            continue;
          }
          channel.onmessage?.({ data } as MessageEvent);
        }
      }
      close() {
        // no-op
      }
    };
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      configurable: true,
    });

    // Higher tabId first so a naive "last writer wins" would keep tab-z.
    const higher = makeVoiceMultiTabLock({ tabId: "tab-z", channelName: "test-voice-lock-tie" });
    const lower = makeVoiceMultiTabLock({ tabId: "tab-a", channelName: "test-voice-lock-tie" });

    // Hold announces until both have becomeLeader (equal generation race).
    await expect(higher.acquire("env-1")).resolves.toBe(true);
    await expect(lower.acquire("env-2")).resolves.toBe(true);
    expect(higher.getSnapshot().role).toBe("leader");
    expect(lower.getSnapshot().role).toBe("leader");

    deliver = true;
    for (const channel of channels) {
      const queued = channel.pending.splice(0, channel.pending.length);
      for (const data of queued) {
        channel.onmessage?.({ data } as MessageEvent);
      }
    }

    // Lower tabId wins the equal-generation race on both sides.
    expect(higher.getSnapshot().leaderTabId).toBe("tab-a");
    expect(lower.getSnapshot().leaderTabId).toBe("tab-a");
    expect(higher.getSnapshot().role).toBe("follower");
    expect(lower.getSnapshot().role).toBe("leader");

    higher.dispose();
    lower.dispose();
  });
});

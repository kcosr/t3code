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
});

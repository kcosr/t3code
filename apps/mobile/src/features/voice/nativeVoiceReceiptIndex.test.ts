import { describe, expect, it, vi } from "vitest";

import { NativeVoiceReceiptIndex } from "./nativeVoiceReceiptIndex";

describe("NativeVoiceReceiptIndex", () => {
  const receipt = (assistantMessageIds: ReadonlyArray<string>, expiresAt: string) => ({
    assistantMessageIds: [...assistantMessageIds] as never,
    expiresAt: expiresAt as never,
  });

  it("tracks exact native assistant messages and notifies presentations", () => {
    let now = 1_000;
    const index = new NativeVoiceReceiptIndex(512, () => now);
    const listener = vi.fn();
    const unsubscribe = index.subscribe(listener);
    index.recordReceipts([receipt(["message-1", "message-2"], new Date(2_000).toISOString())]);
    expect([...index.getSnapshot()]).toEqual(["message-1", "message-2"]);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    now = 1_100;
    index.recordReceipts([receipt(["message-3"], new Date(2_000).toISOString())]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("refreshes duplicate recency and bounds retained receipt identities", () => {
    const index = new NativeVoiceReceiptIndex(2, () => 1_000);
    const expiresAt = new Date(2_000).toISOString();
    index.recordReceipts([receipt(["message-1", "message-2"], expiresAt)]);
    index.recordReceipts([receipt(["message-1", "message-3"], expiresAt)]);
    expect([...index.getSnapshot()]).toEqual(["message-1", "message-3"]);
  });

  it("seeds retained thread receipts idempotently across presentation rebases", () => {
    const index = new NativeVoiceReceiptIndex(512, () => 1_000);
    const listener = vi.fn();
    index.subscribe(listener);
    const receipts = [
      receipt(["message-1", "message-2"], new Date(2_000).toISOString()),
      receipt(["message-2", "message-3"], new Date(3_000).toISOString()),
    ];

    index.recordReceipts(receipts);
    index.recordReceipts(receipts);

    expect([...index.getSnapshot()]).toEqual(["message-1", "message-2", "message-3"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("expires receipts at their durable deadline and publishes the removal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const index = new NativeVoiceReceiptIndex();
    const listener = vi.fn();
    index.subscribe(listener);

    index.recordReceipts([receipt(["message-1"], new Date(2_000).toISOString())]);
    expect(index.getSnapshot().has("message-1")).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(index.getSnapshot().has("message-1")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not shorten a refreshed receipt when an older rebase arrives", () => {
    let now = 1_000;
    const index = new NativeVoiceReceiptIndex(512, () => now);
    index.recordReceipts([receipt(["message-1"], new Date(4_000).toISOString())]);
    index.recordReceipts([receipt(["message-1"], new Date(2_000).toISOString())]);

    now = 2_500;
    index.recordReceipts([]);
    expect(index.getSnapshot().has("message-1")).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";

import { NativeVoiceReceiptIndex } from "./nativeVoiceReceiptIndex";

describe("NativeVoiceReceiptIndex", () => {
  it("tracks exact native assistant messages and notifies presentations", () => {
    const index = new NativeVoiceReceiptIndex();
    const listener = vi.fn();
    const unsubscribe = index.subscribe(listener);
    index.record(["message-1", "message-2"]);
    expect([...index.getSnapshot()]).toEqual(["message-1", "message-2"]);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    index.record(["message-3"]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("deduplicates and bounds retained receipt identities", () => {
    const index = new NativeVoiceReceiptIndex(2);
    index.record(["message-1", "message-2"]);
    index.record(["message-2", "message-3"]);
    expect([...index.getSnapshot()]).toEqual(["message-2", "message-3"]);
  });

  it("seeds retained thread receipts idempotently across presentation rebases", () => {
    const index = new NativeVoiceReceiptIndex();
    const listener = vi.fn();
    index.subscribe(listener);
    const receipts = [
      { assistantMessageIds: ["message-1", "message-2"] },
      { assistantMessageIds: ["message-2", "message-3"] },
    ];

    index.recordReceipts(receipts);
    index.recordReceipts(receipts);

    expect([...index.getSnapshot()]).toEqual(["message-1", "message-2", "message-3"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

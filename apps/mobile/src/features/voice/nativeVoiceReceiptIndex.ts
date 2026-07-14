import type { VoiceThreadTurnReceipt } from "@t3tools/contracts";

export class NativeVoiceReceiptIndex {
  private snapshot = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly capacity = 512) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ReadonlySet<string> => this.snapshot;

  recordReceipts(
    receipts: ReadonlyArray<Pick<VoiceThreadTurnReceipt, "assistantMessageIds">>,
  ): void {
    this.record(receipts.flatMap((receipt) => receipt.assistantMessageIds));
  }

  record(messageIds: ReadonlyArray<string>): void {
    if (messageIds.length === 0) return;
    const next = new Set(this.snapshot);
    for (const messageId of messageIds) next.add(messageId);
    while (next.size > this.capacity) {
      const oldest = next.values().next().value as string | undefined;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

import type { VoiceThreadTurnReceipt } from "@t3tools/contracts";

const MAX_TIMER_DELAY_MILLIS = 2_147_483_647;

interface RetainedReceipt {
  readonly expiresAtEpochMillis: number;
}

/**
 * Exact assistant-message receipts owned by the native runtime.
 *
 * Map insertion order is the retention LRU. Receipt expiry is authoritative:
 * an expired native turn must not suppress unrelated future presentation work
 * if the server ever reuses an identifier.
 */
export class NativeVoiceReceiptIndex {
  private readonly receipts = new Map<string, RetainedReceipt>();
  private snapshot: ReadonlySet<string> = new Set();
  private readonly listeners = new Set<() => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly capacity = 512,
    private readonly now: () => number = Date.now,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ReadonlySet<string> => this.snapshot;

  recordReceipts(
    receipts: ReadonlyArray<Pick<VoiceThreadTurnReceipt, "assistantMessageIds" | "expiresAt">>,
  ): void {
    const now = this.now();
    let changed = this.pruneExpired(now);
    for (const receipt of receipts) {
      const expiresAtEpochMillis = Date.parse(receipt.expiresAt);
      if (!Number.isFinite(expiresAtEpochMillis) || expiresAtEpochMillis <= now) continue;
      for (const messageId of receipt.assistantMessageIds) {
        const existing = this.receipts.get(messageId);
        // A repeated durable receipt refreshes recency. Never shorten a newer
        // observation when an older rebase page arrives out of order.
        this.receipts.delete(messageId);
        this.receipts.set(messageId, {
          expiresAtEpochMillis: Math.max(
            expiresAtEpochMillis,
            existing?.expiresAtEpochMillis ?? expiresAtEpochMillis,
          ),
        });
        changed = true;
      }
    }
    while (this.receipts.size > this.capacity) {
      const oldest = this.receipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
      changed = true;
    }
    if (changed) this.publish();
    this.scheduleExpiry();
  }

  private pruneExpired(now: number): boolean {
    let changed = false;
    for (const [messageId, receipt] of this.receipts) {
      if (receipt.expiresAtEpochMillis > now) continue;
      this.receipts.delete(messageId);
      changed = true;
    }
    return changed;
  }

  private publish(): void {
    this.snapshot = new Set(this.receipts.keys());
    for (const listener of this.listeners) listener();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const receipt of this.receipts.values()) {
      earliest = Math.min(earliest, receipt.expiresAtEpochMillis);
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(MAX_TIMER_DELAY_MILLIS, Math.max(0, earliest - this.now()));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (this.pruneExpired(this.now())) this.publish();
      this.scheduleExpiry();
    }, delay);
  }
}

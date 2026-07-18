export interface RuntimeTerminalFailurePresentation {
  readonly shouldPresent: boolean;
  readonly complete: () => void;
}

interface RuntimeTerminalFailurePresentationEntry {
  completed: boolean;
  acknowledged: boolean;
  acknowledgementInFlight: boolean;
  acknowledge: () => Promise<void>;
}

const DUPLICATE_PRESENTATION: RuntimeTerminalFailurePresentation = {
  shouldPresent: false,
  complete: () => undefined,
};

export class RuntimeTerminalFailurePresentationRegistry {
  private readonly entries = new Map<number, RuntimeTerminalFailurePresentationEntry>();

  constructor(private readonly maximumRetainedCompleted = 64) {
    if (!Number.isSafeInteger(maximumRetainedCompleted) || maximumRetainedCompleted < 0) {
      throw new Error("maximumRetainedCompleted must be a non-negative safe integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  register(
    failureId: number,
    acknowledge: () => Promise<void>,
  ): RuntimeTerminalFailurePresentation {
    const existing = this.entries.get(failureId);
    if (existing !== undefined) {
      existing.acknowledge = acknowledge;
      this.acknowledgeIfReady(existing);
      return DUPLICATE_PRESENTATION;
    }

    const entry: RuntimeTerminalFailurePresentationEntry = {
      completed: false,
      acknowledged: false,
      acknowledgementInFlight: false,
      acknowledge,
    };
    this.entries.set(failureId, entry);
    return {
      shouldPresent: true,
      complete: () => {
        if (entry.completed) return;
        entry.completed = true;
        this.acknowledgeIfReady(entry);
      },
    };
  }

  private acknowledgeIfReady(entry: RuntimeTerminalFailurePresentationEntry): void {
    if (!entry.completed || entry.acknowledged || entry.acknowledgementInFlight) return;
    entry.acknowledgementInFlight = true;
    void entry
      .acknowledge()
      .then(() => {
        entry.acknowledged = true;
        this.pruneCompletedHistory();
      })
      .catch(() => undefined)
      .finally(() => {
        entry.acknowledgementInFlight = false;
      });
  }

  private pruneCompletedHistory(): void {
    let retainedCompleted = 0;
    for (const entry of this.entries.values()) {
      if (entry.completed && entry.acknowledged) retainedCompleted += 1;
    }
    if (retainedCompleted <= this.maximumRetainedCompleted) return;

    for (const [failureId, entry] of this.entries) {
      if (!entry.completed || !entry.acknowledged) continue;
      this.entries.delete(failureId);
      retainedCompleted -= 1;
      if (retainedCompleted <= this.maximumRetainedCompleted) return;
    }
  }
}

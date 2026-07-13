interface BackoffScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const defaultScheduler: BackoffScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class NativeVoiceReconciliationBackoff {
  private key: string | null = null;
  private attempts = 0;
  private timer: unknown | null = null;
  private scheduledDelayMs: number | null = null;

  constructor(
    private readonly scheduler: BackoffScheduler = defaultScheduler,
    private readonly baseDelayMs = 2_000,
    private readonly maximumDelayMs = 32_000,
  ) {}

  setKey(key: string): void {
    if (this.key === key) return;
    this.reset(key);
  }

  schedule(key: string, retry: () => void): number {
    this.setKey(key);
    if (this.timer !== null && this.scheduledDelayMs !== null) return this.scheduledDelayMs;
    const delay = Math.min(
      this.maximumDelayMs,
      this.baseDelayMs * 2 ** Math.min(this.attempts, 30),
    );
    this.attempts += 1;
    this.scheduledDelayMs = delay;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.scheduledDelayMs = null;
      retry();
    }, delay);
    return delay;
  }

  reset(key: string | null = null): void {
    this.cancel();
    this.key = key;
    this.attempts = 0;
  }

  cancel(): void {
    if (this.timer === null) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.scheduledDelayMs = null;
  }
}

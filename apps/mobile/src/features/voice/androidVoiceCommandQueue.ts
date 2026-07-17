interface CommandEntry {
  readonly kind: "command";
  readonly execute: () => Promise<void>;
}

interface ReviewUpdateWaiter {
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
}

interface ReviewUpdateEntry<Token> {
  readonly kind: "review-update";
  token: Token;
  transcript: string;
  readonly waiters: Array<ReviewUpdateWaiter>;
  readonly execute: () => Promise<void>;
}

type QueueEntry<Token> = CommandEntry | ReviewUpdateEntry<Token>;

/** Serializes native ownership commands and coalesces consecutive review edits. */
export class AndroidVoiceCommandQueue<Token> {
  private readonly entries: Array<QueueEntry<Token>> = [];
  private draining = false;

  enqueue<Result>(command: () => Promise<Result>): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      this.entries.push({
        kind: "command",
        execute: async () => {
          try {
            resolve(await command());
          } catch (cause) {
            reject(cause);
          }
        },
      });
      this.startDrain();
    });
  }

  enqueueReviewUpdate(
    token: Token,
    transcript: string,
    command: (token: Token, transcript: string) => Promise<void>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const last = this.entries.at(-1);
      if (last?.kind === "review-update") {
        last.token = token;
        last.transcript = transcript;
        last.waiters.push({ resolve, reject });
        return;
      }

      const entry: ReviewUpdateEntry<Token> = {
        kind: "review-update",
        token,
        transcript,
        waiters: [{ resolve, reject }],
        execute: async () => {
          try {
            await command(entry.token, entry.transcript);
            for (const waiter of entry.waiters) waiter.resolve();
          } catch (cause) {
            for (const waiter of entry.waiters) waiter.reject(cause);
          }
        },
      };
      this.entries.push(entry);
      this.startDrain();
    });
  }

  private startDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.entries.length > 0) {
        const entry = this.entries.shift();
        if (entry !== undefined) await entry.execute();
      }
    } finally {
      this.draining = false;
      if (this.entries.length > 0) this.startDrain();
    }
  }
}

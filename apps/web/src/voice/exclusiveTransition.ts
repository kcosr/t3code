/** Admits at most one asynchronous ownership transition at a time. */
export class ExclusiveTransition {
  private running = false;

  get active(): boolean {
    return this.running;
  }

  async run(operation: () => Promise<void>): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await operation();
      return true;
    } finally {
      this.running = false;
    }
  }
}

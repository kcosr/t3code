import type { VoiceRuntimeSnapshot } from "@t3tools/contracts";
import type {
  VoiceRuntimePresentationBinding,
  VoiceRuntimePresentationBindingSnapshot,
} from "@t3tools/client-runtime/voice";

type PresentationGenerationStore = Pick<
  VoiceRuntimePresentationBinding,
  "getSnapshot" | "subscribe"
>;

export class VoicePresentationGenerationWaitCancelledError extends Error {
  readonly name = "VoicePresentationGenerationWaitCancelledError";

  constructor() {
    super("Voice presentation reconciliation was cancelled.");
  }
}

export class VoicePresentationGenerationWaitScope {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.controller.signal.aborted;
  }

  dispose(): void {
    if (!this.disposed) this.controller.abort();
  }

  throwIfDisposed(): void {
    if (this.disposed) throw new VoicePresentationGenerationWaitCancelledError();
  }
}

export interface VoicePresentationGenerationWaitOptions {
  readonly signal?: AbortSignal;
}

const generationReached = (
  state: VoiceRuntimePresentationBindingSnapshot,
  target: VoiceRuntimeSnapshot,
): boolean => {
  const current = state.controller?.snapshot;
  return (
    state.phase === "attached" &&
    current?.runtimeId === target.runtimeId &&
    current.runtimeInstanceId === target.runtimeInstanceId &&
    current.generation === target.generation
  );
};

/** Waits for the presentation controller itself, not merely a native snapshot cache. */
export function waitForVoicePresentationGeneration(
  store: PresentationGenerationStore,
  target: VoiceRuntimeSnapshot,
  options: VoicePresentationGenerationWaitOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const cancellationError = () => new VoicePresentationGenerationWaitCancelledError();
    const onAbort = () => settle({ error: cancellationError() });
    const settle = (result: { readonly error?: unknown } = {}) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      options.signal?.removeEventListener("abort", onAbort);
      if ("error" in result) reject(result.error);
      else resolve();
    };
    const inspect = () => {
      try {
        const state = store.getSnapshot();
        if (generationReached(state, target)) {
          settle();
          return;
        }
        if (state.phase === "error") {
          settle({ error: state.error ?? new Error("Voice presentation reconciliation failed.") });
          return;
        }
        if (state.phase === "detached" || state.phase === "detaching") {
          settle({ error: new Error("Voice presentation detached while reconciling.") });
          return;
        }
        const current = state.controller?.snapshot ?? state.snapshot;
        if (
          current !== null &&
          (current.runtimeId !== target.runtimeId ||
            current.runtimeInstanceId !== target.runtimeInstanceId ||
            current.generation > target.generation)
        ) {
          settle({ error: new Error("Voice runtime authority changed while reconciling.") });
        }
      } catch (error) {
        settle({ error });
      }
    };

    if (options.signal?.aborted === true) {
      settle({ error: cancellationError() });
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const release = store.subscribe(inspect);
      unsubscribe = release;
      if (settled) release();
    } catch (error) {
      settle({ error });
      return;
    }
    inspect();
  });
}

/**
 * Worker-backed timers for Realtime heartbeat and long-poll re-arm.
 *
 * Main-thread timers throttle hard in hidden tabs; a dedicated Worker keeps
 * scheduling less throttled so leases do not silently expire solely due to
 * setTimeout clamping. Still best-effort — not Android FGS reliability.
 */

export interface VoiceLeaseTimerHandle {
  readonly cancel: () => void;
}

export interface VoiceLeaseTimers {
  readonly interval: (periodMs: number, onTick: () => void) => VoiceLeaseTimerHandle;
  readonly dispose: () => void;
}

const workerSource = `
  const intervals = new Map();
  self.onmessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "start") {
      const existing = intervals.get(data.id);
      if (existing !== undefined) clearInterval(existing);
      const handle = setInterval(() => {
        self.postMessage({ type: "tick", id: data.id });
      }, data.periodMs);
      intervals.set(data.id, handle);
      return;
    }
    if (data.type === "stop") {
      const existing = intervals.get(data.id);
      if (existing !== undefined) clearInterval(existing);
      intervals.delete(data.id);
      return;
    }
    if (data.type === "dispose") {
      for (const handle of intervals.values()) clearInterval(handle);
      intervals.clear();
    }
  };
`;

export function makeVoiceLeaseTimers(): VoiceLeaseTimers {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  let worker: Worker | null = null;
  let disposed = false;

  try {
    const blob = new Blob([workerSource], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (event: MessageEvent<{ type: string; id: number }>) => {
      if (event.data?.type !== "tick") return;
      callbacks.get(event.data.id)?.();
    };
  } catch {
    worker = null;
  }

  return {
    interval: (periodMs, onTick) => {
      if (disposed) {
        return { cancel: () => undefined };
      }
      const id = nextId++;
      callbacks.set(id, onTick);
      if (worker !== null) {
        worker.postMessage({ type: "start", id, periodMs });
        return {
          cancel: () => {
            callbacks.delete(id);
            worker?.postMessage({ type: "stop", id });
          },
        };
      }
      // Fallback: main-thread interval (best effort).
      const handle = setInterval(onTick, periodMs);
      return {
        cancel: () => {
          callbacks.delete(id);
          clearInterval(handle);
        },
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      callbacks.clear();
      if (worker !== null) {
        worker.postMessage({ type: "dispose" });
        worker.terminate();
        worker = null;
      }
    },
  };
}

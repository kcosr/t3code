import { describe, expect, it, vi } from "vitest";

import type { VoiceRuntimePresentationBindingSnapshot } from "@t3tools/client-runtime/voice";
import type { VoiceRuntimeSnapshot } from "@t3tools/contracts";

import {
  VoicePresentationGenerationWaitCancelledError,
  VoicePresentationGenerationWaitScope,
  waitForVoicePresentationGeneration,
} from "./voicePresentationGeneration";

const target = {
  runtimeId: "runtime",
  runtimeInstanceId: "instance",
  generation: 2,
} as VoiceRuntimeSnapshot;

const attaching = {
  phase: "attaching",
  descriptor: null,
  controller: null,
  snapshot: target,
  presentationAction: null,
  draftArtifact: null,
  error: null,
} satisfies VoiceRuntimePresentationBindingSnapshot;

describe("waitForVoicePresentationGeneration", () => {
  it("remains pending until an attachment event reaches the requested generation", async () => {
    let state: VoiceRuntimePresentationBindingSnapshot = attaching;
    const listeners = new Set<() => void>();
    const store = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    let resolved = false;
    const pending = waitForVoicePresentationGeneration(store, target).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(listeners.size).toBe(1);

    state = {
      ...state,
      phase: "attached",
      controller: {
        snapshot: target,
        lease: {} as never,
        cursor: {} as never,
      },
    };
    for (const listener of listeners) listener();
    await pending;
    expect(resolved).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it("rejects from presentation error state instead of timing out", async () => {
    const failure = new Error("attach failed");
    const store = {
      getSnapshot: () => ({ ...attaching, phase: "error" as const, error: failure }),
      subscribe: vi.fn(() => () => undefined),
    };
    await expect(waitForVoicePresentationGeneration(store, target)).rejects.toBe(failure);
  });

  it("rejects a superseding runtime instance", async () => {
    const store = {
      getSnapshot: () => ({
        ...attaching,
        phase: "attached" as const,
        controller: {
          snapshot: { ...target, runtimeInstanceId: "new-instance" as never },
          lease: {} as never,
          cursor: {} as never,
        },
      }),
      subscribe: () => () => undefined,
    };
    await expect(waitForVoicePresentationGeneration(store, target)).rejects.toThrow(
      "authority changed",
    );
  });

  it("rejects a superseding authority generation instead of retrying stale intent", async () => {
    const store = {
      getSnapshot: () => ({
        ...attaching,
        phase: "attached" as const,
        controller: {
          snapshot: { ...target, generation: target.generation + 1 },
          lease: {} as never,
          cursor: {} as never,
        },
      }),
      subscribe: () => () => undefined,
    };
    await expect(waitForVoicePresentationGeneration(store, target)).rejects.toThrow(
      "authority changed",
    );
  });

  it.each(["detached", "detaching"] as const)(
    "rejects and releases its subscription when presentation becomes %s",
    async (phase) => {
      let state: VoiceRuntimePresentationBindingSnapshot = attaching;
      const listeners = new Set<() => void>();
      const store = {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const pending = waitForVoicePresentationGeneration(store, target);
      expect(listeners.size).toBe(1);

      state = { ...attaching, phase };
      for (const listener of listeners) listener();

      await expect(pending).rejects.toThrow("detached while reconciling");
      expect(listeners.size).toBe(0);
    },
  );

  it("rejects a different runtime even while a new presentation is attaching", async () => {
    const store = {
      getSnapshot: () => ({
        ...attaching,
        snapshot: { ...target, runtimeId: "replacement-runtime" as never },
      }),
      subscribe: () => () => undefined,
    };

    await expect(waitForVoicePresentationGeneration(store, target)).rejects.toThrow(
      "authority changed",
    );
  });

  it("allows the same runtime instance to advance from an older generation", async () => {
    let state: VoiceRuntimePresentationBindingSnapshot = {
      ...attaching,
      phase: "attached",
      controller: {
        snapshot: { ...target, generation: target.generation - 1 },
        lease: {} as never,
        cursor: {} as never,
      },
    };
    const listeners = new Set<() => void>();
    const store = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const pending = waitForVoicePresentationGeneration(store, target);
    expect(listeners.size).toBe(1);

    state = {
      ...state,
      controller: { ...state.controller!, snapshot: target },
    };
    for (const listener of listeners) listener();

    await expect(pending).resolves.toBeUndefined();
    expect(listeners.size).toBe(0);
  });

  it("cancels all lifecycle-bound work and releases subscriptions when its scope is disposed", async () => {
    const listeners = new Set<() => void>();
    const store = {
      getSnapshot: () => attaching,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const scope = new VoicePresentationGenerationWaitScope();
    const first = waitForVoicePresentationGeneration(store, target, { signal: scope.signal });
    const second = waitForVoicePresentationGeneration(store, target, { signal: scope.signal });
    expect(listeners.size).toBe(2);

    scope.dispose();

    await expect(first).rejects.toBeInstanceOf(VoicePresentationGenerationWaitCancelledError);
    await expect(second).rejects.toBeInstanceOf(VoicePresentationGenerationWaitCancelledError);
    expect(listeners.size).toBe(0);
    expect(() => scope.throwIfDisposed()).toThrow(VoicePresentationGenerationWaitCancelledError);
  });

  it("does not subscribe when the provider lifecycle is already disposed", async () => {
    const scope = new VoicePresentationGenerationWaitScope();
    scope.dispose();
    const subscribe = vi.fn(() => () => undefined);

    await expect(
      waitForVoicePresentationGeneration({ getSnapshot: () => attaching, subscribe }, target, {
        signal: scope.signal,
      }),
    ).rejects.toBeInstanceOf(VoicePresentationGenerationWaitCancelledError);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("releases a subscription that synchronously publishes the target during subscribe", async () => {
    let state: VoiceRuntimePresentationBindingSnapshot = attaching;
    const release = vi.fn();
    const store = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        state = {
          ...attaching,
          phase: "attached",
          controller: { snapshot: target, lease: {} as never, cursor: {} as never },
        };
        listener();
        return release;
      },
    };

    await expect(waitForVoicePresentationGeneration(store, target)).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });
});

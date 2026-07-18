import { describe, expect, it, vi } from "vite-plus/test";

import { RuntimeTerminalFailurePresentationRegistry } from "./runtimeTerminalFailurePresentations";

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("RuntimeTerminalFailurePresentationRegistry", () => {
  it("presents a duplicate failure once and acknowledges it once", async () => {
    const registry = new RuntimeTerminalFailurePresentationRegistry();
    const acknowledge = vi.fn(async () => undefined);

    const first = registry.register(1, acknowledge);
    const duplicate = registry.register(1, acknowledge);
    first.complete();
    duplicate.complete();
    await flushPromises();

    expect(first.shouldPresent).toBe(true);
    expect(duplicate.shouldPresent).toBe(false);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("does not acknowledge until the presentation action completes", async () => {
    const registry = new RuntimeTerminalFailurePresentationRegistry();
    const acknowledge = vi.fn(async () => undefined);

    const presentation = registry.register(2, acknowledge);
    await flushPromises();
    expect(acknowledge).not.toHaveBeenCalled();

    presentation.complete();
    await flushPromises();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("retries a rejected acknowledgement on replay without concurrent attempts", async () => {
    const registry = new RuntimeTerminalFailurePresentationRegistry();
    let rejectFirst!: (cause: Error) => void;
    const firstAcknowledgement = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const retryAcknowledgement = vi.fn(async () => undefined);
    const presentation = registry.register(3, firstAcknowledgement);
    presentation.complete();

    expect(registry.register(3, retryAcknowledgement).shouldPresent).toBe(false);
    expect(firstAcknowledgement).toHaveBeenCalledOnce();
    expect(retryAcknowledgement).not.toHaveBeenCalled();

    rejectFirst(new Error("binder unavailable"));
    await flushPromises();
    expect(registry.register(3, retryAcknowledgement).shouldPresent).toBe(false);
    await flushPromises();

    expect(firstAcknowledgement).toHaveBeenCalledOnce();
    expect(retryAcknowledgement).toHaveBeenCalledOnce();
  });

  it("bounds acknowledged presentation history", async () => {
    const registry = new RuntimeTerminalFailurePresentationRegistry(2);

    for (const failureId of [1, 2, 3]) {
      registry.register(failureId, async () => undefined).complete();
      await flushPromises();
    }

    expect(registry.size).toBe(2);
    expect(registry.register(1, async () => undefined).shouldPresent).toBe(true);
    expect(registry.register(2, async () => undefined).shouldPresent).toBe(false);
    expect(registry.register(3, async () => undefined).shouldPresent).toBe(false);
  });

  it("never evicts incomplete or unacknowledged presentations", async () => {
    const registry = new RuntimeTerminalFailurePresentationRegistry(0);
    const incomplete = registry.register(10, async () => undefined);
    const rejected = registry.register(11, async () => Promise.reject(new Error("offline")));
    rejected.complete();
    registry.register(12, async () => undefined).complete();
    await flushPromises();

    expect(registry.size).toBe(2);
    expect(registry.register(10, async () => undefined).shouldPresent).toBe(false);
    expect(registry.register(11, async () => undefined).shouldPresent).toBe(false);

    incomplete.complete();
  });
});

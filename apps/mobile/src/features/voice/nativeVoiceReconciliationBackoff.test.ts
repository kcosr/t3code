import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeVoiceReconciliationBackoff } from "./nativeVoiceReconciliationBackoff";

describe("NativeVoiceReconciliationBackoff", () => {
  afterEach(() => vi.useRealTimers());

  it("grows exponentially and caps repeated reconciliation retries", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const backoff = new NativeVoiceReconciliationBackoff();
    const delays: number[] = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      delays.push(backoff.schedule("https://environment-a.example", retry));
      vi.runOnlyPendingTimers();
    }

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000]);
    expect(retry).toHaveBeenCalledTimes(7);
  });

  it("coalesces a pending retry and resets when ownership changes", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const backoff = new NativeVoiceReconciliationBackoff();

    expect(backoff.schedule("environment-a", first)).toBe(2_000);
    expect(backoff.schedule("environment-a", second)).toBe(2_000);
    vi.advanceTimersByTime(2_000);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(backoff.schedule("environment-a", first)).toBe(4_000);
    backoff.setKey("environment-b");
    expect(backoff.schedule("environment-b", second)).toBe(2_000);
    vi.runOnlyPendingTimers();
    expect(second).toHaveBeenCalledOnce();
  });

  it("resets after successful reconciliation", () => {
    vi.useFakeTimers();
    const backoff = new NativeVoiceReconciliationBackoff();
    backoff.schedule("environment-a", vi.fn());
    vi.runOnlyPendingTimers();
    expect(backoff.schedule("environment-a", vi.fn())).toBe(4_000);

    backoff.reset();

    expect(backoff.schedule("environment-a", vi.fn())).toBe(2_000);
  });
});

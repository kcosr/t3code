import { describe, expect, it, vi } from "vite-plus/test";

import {
  acknowledgeClientActionWithRetry,
  clientActionAcknowledgementInput,
} from "./clientActionAcknowledgement";

describe("client action acknowledgement", () => {
  it("attempts once when the server deadline is already past on the client clock", async () => {
    const acknowledge = vi.fn(async () => undefined);

    await expect(
      acknowledgeClientActionWithRetry({
        expiresAtMillis: 900,
        acknowledge,
        input: { outcome: "succeeded" },
        shouldContinue: () => true,
        now: () => 1_000,
      }),
    ).resolves.toBe(true);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("retries within the deadline and stops after acknowledgement", async () => {
    const acknowledge = vi
      .fn<(input: { readonly outcome: "succeeded" | "failed" }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn(async () => undefined);

    await expect(
      acknowledgeClientActionWithRetry({
        expiresAtMillis: 2_000,
        acknowledge,
        input: { outcome: "failed" },
        shouldContinue: () => true,
        now: () => 1_000,
        sleep,
      }),
    ).resolves.toBe(true);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("does not send blank failure messages", () => {
    expect(clientActionAcknowledgementInput("failed", "  ")).toEqual({ outcome: "failed" });
    expect(clientActionAcknowledgementInput("failed", "  navigation failed  ")).toEqual({
      outcome: "failed",
      message: "navigation failed",
    });
  });
});

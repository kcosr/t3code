import { describe, expect, it, vi } from "vite-plus/test";

import {
  acknowledgeClientActionWithRetry,
  clientActionAcknowledgementInput,
  executeThreadActivation,
  type ClientActionAcknowledgementInput,
} from "./clientActionAcknowledgement";

describe("client action acknowledgement", () => {
  it("reserves focus ordering before acknowledging navigation", async () => {
    const order: Array<string> = [];

    await executeThreadActivation({
      navigate: () => order.push("navigate"),
      updateFocus: async () => {
        order.push("focus");
      },
      acknowledge: async (outcome) => {
        order.push(`ack:${outcome}`);
      },
      errorMessage: String,
    });

    expect(order).toEqual(["navigate", "focus", "ack:succeeded"]);
  });

  it("acknowledges a failed activation when navigation fails", async () => {
    const acknowledgements: Array<ClientActionAcknowledgementInput> = [];

    await executeThreadActivation({
      navigate: () => {
        throw new Error("navigation unavailable");
      },
      updateFocus: async () => undefined,
      acknowledge: async (outcome, message) => {
        acknowledgements.push(clientActionAcknowledgementInput(outcome, message));
      },
      errorMessage: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    });

    expect(acknowledgements).toEqual([{ outcome: "failed", message: "navigation unavailable" }]);
  });

  it("does not reverse a navigation acknowledgement when later focus sync fails", async () => {
    const acknowledgements: Array<ClientActionAcknowledgementInput> = [];

    await expect(
      executeThreadActivation({
        navigate: () => undefined,
        updateFocus: async () => {
          throw new Error("focus unavailable");
        },
        acknowledge: async (outcome, message) => {
          acknowledgements.push(clientActionAcknowledgementInput(outcome, message));
        },
        errorMessage: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }),
    ).rejects.toThrow("focus unavailable");

    expect(acknowledgements).toEqual([{ outcome: "succeeded" }]);
  });

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

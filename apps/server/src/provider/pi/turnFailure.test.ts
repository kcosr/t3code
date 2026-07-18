import { describe, expect, it } from "vitest";

import { classifyPiTurnFailure, isPiInterruptedMessage } from "./turnFailure.ts";

describe("classifyPiTurnFailure", () => {
  it("treats abort-ish messages as interrupted", () => {
    expect(classifyPiTurnFailure("Request was aborted")).toEqual({
      state: "interrupted",
      stopReason: "aborted",
    });
    expect(classifyPiTurnFailure("AbortError: The operation was aborted")).toEqual({
      state: "interrupted",
      stopReason: "aborted",
    });
    expect(isPiInterruptedMessage("Interrupted by user.")).toBe(true);
  });

  it("keeps real failures failed", () => {
    expect(classifyPiTurnFailure("model overloaded")).toEqual({
      state: "failed",
      stopReason: "error",
    });
    expect(classifyPiTurnFailure("rate limit exceeded")).toEqual({
      state: "failed",
      stopReason: "error",
    });
  });
});

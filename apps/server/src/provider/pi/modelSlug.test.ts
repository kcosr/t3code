import { describe, expect, it } from "vitest";

import {
  clampPiThinkingLevel,
  encodePiModelSlug,
  getSupportedPiThinkingLevels,
  isPiThinkingLevel,
  isValidPiSessionId,
  parsePiModelSlug,
  preferPiSessionIdFromThreadId,
} from "./modelSlug.ts";

describe("Pi model slug helpers", () => {
  it("round-trips provider/modelId", () => {
    expect(encodePiModelSlug("anthropic", "claude-sonnet-4")).toBe("anthropic/claude-sonnet-4");
    expect(parsePiModelSlug("openai/gpt-5")).toEqual({ provider: "openai", modelId: "gpt-5" });
  });

  it("rejects invalid slugs", () => {
    expect(parsePiModelSlug("noshift")).toBeUndefined();
    expect(parsePiModelSlug("/only")).toBeUndefined();
    expect(parsePiModelSlug("only/")).toBeUndefined();
  });

  it("validates thinking levels", () => {
    expect(isPiThinkingLevel("high")).toBe(true);
    expect(isPiThinkingLevel("extreme")).toBe(false);
  });

  it("validates Pi session ids", () => {
    expect(isValidPiSessionId("abc")).toBe(true);
    expect(isValidPiSessionId("thread-1.id_2")).toBe(true);
    expect(isValidPiSessionId("-bad")).toBe(false);
    expect(isValidPiSessionId("bad.")).toBe(false);
    expect(preferPiSessionIdFromThreadId("good-id")).toBe("good-id");
    expect(preferPiSessionIdFromThreadId("has space")).toBeUndefined();
  });

  it("hides thinking controls for non-reasoning models", () => {
    expect(getSupportedPiThinkingLevels({ reasoning: false })).toEqual([]);
    expect(getSupportedPiThinkingLevels({})).toEqual([]);
  });

  it("advertises xhigh only when the model map includes it", () => {
    expect(getSupportedPiThinkingLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(
      getSupportedPiThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh" },
      }),
    ).toContain("xhigh");
    expect(
      getSupportedPiThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { medium: null, high: "high" },
      }),
    ).toEqual(["off", "minimal", "low", "high"]);
  });

  it("clamps requested thinking to a supported level", () => {
    expect(
      clampPiThinkingLevel(
        { reasoning: true, thinkingLevelMap: { medium: null, high: "high" } },
        "medium",
      ),
    ).toBe("off");
    expect(clampPiThinkingLevel({ reasoning: false }, "high")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { isNativeVoiceErrorCode } from "./nativeVoiceError";

describe("native voice errors", () => {
  it("matches structured native error codes only", () => {
    expect(isNativeVoiceErrorCode({ code: "recording-not-started" }, "recording-not-started")).toBe(
      true,
    );
    expect(
      isNativeVoiceErrorCode(new Error("recording-not-started"), "recording-not-started"),
    ).toBe(false);
    expect(isNativeVoiceErrorCode(null, "recording-not-started")).toBe(false);
  });
});

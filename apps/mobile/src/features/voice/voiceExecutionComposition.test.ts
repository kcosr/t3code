import { describe, expect, it } from "vitest";

import { mobileVoiceExecutionModel } from "./voiceExecutionComposition";

describe("mobileVoiceExecutionModel", () => {
  it("selects autonomous ownership only for Android", () => {
    expect(mobileVoiceExecutionModel("android")).toBe("autonomous");
    expect(mobileVoiceExecutionModel("ios")).toBe("ui-attached");
    expect(mobileVoiceExecutionModel("web")).toBe("ui-attached");
  });
});

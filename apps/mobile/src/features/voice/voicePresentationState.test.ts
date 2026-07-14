import { describe, expect, it } from "vitest";

import { resolveVoiceRuntimePresentationState } from "./voicePresentationState";

describe("resolveVoiceRuntimePresentationState", () => {
  it.each([
    ["active", "active", "foreground-active"],
    ["active", "visible-inactive", "visible-inactive"],
    ["inactive", "active", "visible-inactive"],
    ["inactive", "visible-inactive", "visible-inactive"],
    ["active", "hidden", "background"],
    ["inactive", "hidden", "background"],
    ["background", "active", "background"],
    ["background", "visible-inactive", "background"],
    ["unknown", "active", "background"],
  ] as const)("maps %s/%s to %s", (applicationState, navigationVisibility, expected) => {
    expect(resolveVoiceRuntimePresentationState({ applicationState, navigationVisibility })).toBe(
      expected,
    );
  });

  it("keeps the root presentation active when a navigation overlay is visible", () => {
    expect(
      resolveVoiceRuntimePresentationState({
        applicationState: "active",
        navigationVisibility: "active",
      }),
    ).toBe("foreground-active");
  });
});

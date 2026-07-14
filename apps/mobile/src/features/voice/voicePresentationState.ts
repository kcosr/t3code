import type { VoiceRuntimePresentationState } from "@t3tools/contracts";

export type VoiceApplicationState = "active" | "inactive" | "background" | "unknown";
export type VoiceNavigationVisibility = "active" | "visible-inactive" | "hidden";

/** Maps platform UI visibility to presentation election eligibility. */
export function resolveVoiceRuntimePresentationState(input: {
  readonly applicationState: VoiceApplicationState;
  readonly navigationVisibility: VoiceNavigationVisibility;
}): VoiceRuntimePresentationState {
  if (input.applicationState === "background" || input.applicationState === "unknown") {
    return "background";
  }
  if (input.navigationVisibility === "hidden") return "background";
  if (input.applicationState === "active" && input.navigationVisibility === "active") {
    return "foreground-active";
  }
  return "visible-inactive";
}

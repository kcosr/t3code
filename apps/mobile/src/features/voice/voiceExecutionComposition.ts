export type MobileVoiceExecutionModel = "autonomous" | "ui-attached";

export function mobileVoiceExecutionModel(platform: string): MobileVoiceExecutionModel {
  return platform === "android" ? "autonomous" : "ui-attached";
}

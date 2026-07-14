import type { T3VoiceRuntimeAuthoritySnapshot } from "@t3tools/mobile-voice-native";

import type { ResolvedNativeVoiceRuntimeTarget } from "./nativeVoiceRuntimeTarget";

export type AutonomousNativeVoiceReadinessAction = "disable" | "none" | "provision";

export function autonomousNativeVoiceReadinessAction(input: {
  readonly authority: T3VoiceRuntimeAuthoritySnapshot | null;
  readonly operationActive: boolean;
  readonly revocationPending?: boolean;
  readonly resolvedTarget: ResolvedNativeVoiceRuntimeTarget | null;
}): AutonomousNativeVoiceReadinessAction {
  if (input.operationActive) return "none";

  const authority = input.authority;
  const target = input.resolvedTarget;
  if (target !== null) return "provision";
  return authority?.readinessEnabled === true || input.revocationPending === true
    ? "disable"
    : "none";
}

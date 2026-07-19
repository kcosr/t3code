import type { VoiceRealtimeTarget } from "@t3tools/client-runtime/voice";
import type { T3VoiceTerminalRuntimeFailureEvent } from "@t3tools/mobile-voice-native";

export type RuntimeFailurePresentationDecision =
  | {
      readonly kind: "takeover";
      readonly target: VoiceRealtimeTarget;
    }
  | {
      readonly kind: "conversation-not-found";
    }
  | {
      readonly kind: "generic";
      readonly message: string;
    };

/**
 * Pure presentation routing for terminal runtime failures. Side effects and
 * once-per-id registration remain in the presentation hook.
 */
export function resolveRuntimeFailurePresentation(
  failed: T3VoiceTerminalRuntimeFailureEvent,
  lastRealtimeTarget: VoiceRealtimeTarget | null,
): RuntimeFailurePresentationDecision {
  if (
    failed.operation === "realtime" &&
    failed.failure.code === "takeover-required" &&
    lastRealtimeTarget?.conversation.type === "continue" &&
    !lastRealtimeTarget.conversation.takeover
  ) {
    return {
      kind: "takeover",
      target: {
        ...lastRealtimeTarget,
        conversation: {
          ...lastRealtimeTarget.conversation,
          takeover: true,
        },
      },
    };
  }
  if (failed.operation === "realtime" && failed.failure.code === "voice_conversation_not_found") {
    return { kind: "conversation-not-found" };
  }
  return { kind: "generic", message: failed.failure.message };
}

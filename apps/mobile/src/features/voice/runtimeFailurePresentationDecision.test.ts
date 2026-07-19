import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, VoiceConversationId } from "@t3tools/contracts";
import type { VoiceRealtimeTarget } from "@t3tools/client-runtime/voice";
import type { T3VoiceTerminalRuntimeFailureEvent } from "@t3tools/mobile-voice-native";

import { resolveRuntimeFailurePresentation } from "./runtimeFailurePresentationDecision";

const environmentId = "env-1" as EnvironmentId;

const continueTarget: VoiceRealtimeTarget = {
  environmentId,
  conversation: {
    type: "continue",
    conversationId: "conv-1" as VoiceConversationId,
    takeover: false,
  },
  focus: null,
  threadSettings: null,
};

const failure = (
  partial: Partial<T3VoiceTerminalRuntimeFailureEvent> & {
    readonly failure: T3VoiceTerminalRuntimeFailureEvent["failure"];
  },
): T3VoiceTerminalRuntimeFailureEvent => ({
  failureId: 1,
  generation: 1,
  sequence: 1,
  environmentId: String(environmentId),
  operation: "realtime",
  ...partial,
});

describe("resolveRuntimeFailurePresentation", () => {
  it("routes takeover-required continue sessions to takeover presentation", () => {
    expect(
      resolveRuntimeFailurePresentation(
        failure({
          failure: { code: "takeover-required", message: "taken", retryable: false },
        }),
        continueTarget,
      ),
    ).toEqual({
      kind: "takeover",
      target: {
        ...continueTarget,
        conversation: {
          ...continueTarget.conversation,
          takeover: true,
        },
      },
    });
  });

  it("does not offer takeover when the target already requested takeover", () => {
    const alreadyTakeoverTarget: VoiceRealtimeTarget = {
      ...continueTarget,
      conversation: {
        type: "continue",
        conversationId: "conv-1" as VoiceConversationId,
        takeover: true,
      },
    };
    expect(
      resolveRuntimeFailurePresentation(
        failure({
          failure: { code: "takeover-required", message: "taken", retryable: false },
        }),
        alreadyTakeoverTarget,
      ),
    ).toEqual({ kind: "generic", message: "taken" });
  });

  it("does not offer takeover without a continue target", () => {
    expect(
      resolveRuntimeFailurePresentation(
        failure({
          failure: { code: "takeover-required", message: "taken", retryable: false },
        }),
        null,
      ),
    ).toEqual({ kind: "generic", message: "taken" });
  });

  it("routes missing conversation failures to conversation-not-found", () => {
    expect(
      resolveRuntimeFailurePresentation(
        failure({
          failure: { code: "voice_conversation_not_found", message: "gone", retryable: false },
        }),
        continueTarget,
      ),
    ).toEqual({ kind: "conversation-not-found" });
  });

  it("routes other failures to generic presentation", () => {
    expect(
      resolveRuntimeFailurePresentation(
        failure({
          operation: "thread",
          failure: { code: "unknown", message: "boom", retryable: false },
        }),
        continueTarget,
      ),
    ).toEqual({ kind: "generic", message: "boom" });
  });
});

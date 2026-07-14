import {
  EnvironmentId,
  VoiceConversationId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceRuntimeTargetDigest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { autonomousNativeVoiceReadinessAction } from "./autonomousNativeVoiceReadiness";
import {
  canonicalNativeVoiceRuntimeTargetIdentity,
  type ResolvedNativeVoiceRuntimeTarget,
} from "./nativeVoiceRuntimeTarget";

const resolvedTarget: ResolvedNativeVoiceRuntimeTarget = (() => {
  const target = {
    mode: "realtime" as const,
    environmentId: EnvironmentId.make("environment-1"),
    conversationId: VoiceConversationId.make("conversation-1"),
  };
  return { target, targetIdentity: canonicalNativeVoiceRuntimeTargetIdentity(target) };
})();

const authority = {
  state: "active" as const,
  runtimeId: "runtime-1",
  runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-instance-1"),
  provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provisioning-1"),
  expectedCurrentGeneration: 0,
  generation: 1,
  targetDigest: VoiceRuntimeTargetDigest.make("a".repeat(64)),
  target: resolvedTarget.target,
  operation: "realtime-start" as const,
  environmentOrigin: "https://environment.example.test",
  readinessEnabled: true,
  readiness: {
    enabled: true,
    mode: "realtime" as const,
    targetId: "conversation-1",
    audioRouteId: "system",
    autoRearm: false,
    microphonePermissionGranted: true,
    notificationPermissionGranted: true,
    generation: 1,
  },
  issuedAt: "2026-07-14T12:00:00.000Z",
  expiresAt: "2026-07-15T12:00:00.000Z",
  refreshRotationCounter: 0,
  refreshCredentialHash: null,
};

describe("autonomous native voice readiness", () => {
  it("provisions opted-in readiness without representing a voice start", () => {
    expect(
      autonomousNativeVoiceReadinessAction({
        authority: null,
        operationActive: false,
        resolvedTarget,
      }),
    ).toBe("provision");
  });

  it("delegates exact readiness matching to the provisioning coordinator", () => {
    expect(
      autonomousNativeVoiceReadinessAction({
        authority,
        operationActive: false,
        resolvedTarget,
      }),
    ).toBe("provision");
  });

  it("replaces a command-only authority when persistent controls are enabled", () => {
    expect(
      autonomousNativeVoiceReadinessAction({
        authority: { ...authority, readinessEnabled: false },
        operationActive: false,
        resolvedTarget,
      }),
    ).toBe("provision");
  });

  it("disables only persistent readiness when controls are turned off", () => {
    expect(
      autonomousNativeVoiceReadinessAction({
        authority,
        operationActive: false,
        resolvedTarget: null,
      }),
    ).toBe("disable");
    expect(
      autonomousNativeVoiceReadinessAction({
        authority: { ...authority, readinessEnabled: false },
        operationActive: false,
        resolvedTarget: null,
      }),
    ).toBe("none");
  });

  it("can disable persistent readiness without a selected environment", () => {
    expect(
      autonomousNativeVoiceReadinessAction({
        authority,
        operationActive: false,
        resolvedTarget: null,
      }),
    ).toBe("disable");
  });

  it("drains a pending revocation even when native authority is already cleared", () => {
    expect(
      autonomousNativeVoiceReadinessAction({
        authority: null,
        operationActive: false,
        revocationPending: true,
        resolvedTarget: null,
      }),
    ).toBe("disable");
  });

  it("does not replace authority while native voice work is active", () => {
    expect(
      autonomousNativeVoiceReadinessAction({
        authority: { ...authority, environmentOrigin: "https://old.example.test" },
        operationActive: true,
        resolvedTarget,
      }),
    ).toBe("none");
  });
});

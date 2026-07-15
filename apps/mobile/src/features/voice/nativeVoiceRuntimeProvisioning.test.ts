import {
  EnvironmentId,
  VoiceConversationId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  type VoiceRuntimeAuthorityReservation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import {
  InvalidNativeVoiceRuntimeProvisioningResultError,
  NativeVoiceRuntimeReplacementDeferredError,
  NativeVoiceRuntimeProvisioningCoordinator,
  type NativeRuntimeAuthClient,
  type NativeVoiceRuntimeProvisioningAdapter,
} from "./nativeVoiceRuntimeProvisioning";

const runtimeId = VoiceRuntimeId.make("android-main");
const target = {
  mode: "realtime" as const,
  environmentId: EnvironmentId.make("environment-1"),
  conversationId: VoiceConversationId.make("conversation-1"),
};
const reservation: VoiceRuntimeAuthorityReservation = {
  runtimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId.make("instance-1"),
  expectedCurrentGeneration: 2,
  generation: 3,
  target,
  environmentOrigin: "https://environment.example.test",
  readinessEnabled: true,
};

function harness(credential: string | null = "session-credential") {
  const reserve = vi.fn(async () => reservation);
  const setSessionCredential = vi.fn(async () => undefined);
  const activate = vi.fn(async () => undefined);
  const disable = vi.fn(async () => ({ runtimeId }));
  const disableIfIdle = vi.fn(async () => true);
  const adapter: NativeVoiceRuntimeProvisioningAdapter = {
    reserve,
    setSessionCredential,
    activate,
    disable,
    disableIfIdle,
    ownership: async () => null,
  };
  const configureVoiceRuntimeAuthority = vi.fn(() =>
    Effect.succeed({ runtimeId, generation: 3, target }),
  );
  const clearVoiceRuntimeAuthority = vi.fn(() => Effect.succeed({ runtimeId, cleared: true }));
  const client: NativeRuntimeAuthClient = {
    bearerSessionCredential: credential,
    configureVoiceRuntimeAuthority,
    clearVoiceRuntimeAuthority,
  };
  return {
    adapter,
    client,
    reserve,
    setSessionCredential,
    activate,
    disable,
    disableIfIdle,
    configureVoiceRuntimeAuthority,
    clearVoiceRuntimeAuthority,
  };
}

const input = {
  epoch: 1,
  readiness: {
    enabled: true,
    mode: "realtime" as const,
    targetId: "conversation-1",
    audioRouteId: "system",
    autoRearm: true,
    microphonePermissionGranted: true,
    notificationPermissionGranted: true,
  },
  environmentOrigin: "https://environment.example.test/path",
  resolvedTarget: { target, targetIdentity: "realtime-target" },
};

describe("NativeVoiceRuntimeProvisioningCoordinator", () => {
  it("configures tokenless server authority and copies the session credential into native storage", async () => {
    const test = harness();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(test.adapter);

    await expect(coordinator.provision(test.client, input)).resolves.toEqual({
      runtimeId,
      generation: 3,
    });
    expect(test.configureVoiceRuntimeAuthority).toHaveBeenCalledWith(runtimeId, {
      expectedCurrentGeneration: 2,
      generation: 3,
      target,
    });
    expect(test.setSessionCredential).toHaveBeenCalledWith({
      environmentOrigin: "https://environment.example.test",
      credential: "session-credential",
    });
    expect(test.activate).toHaveBeenCalledWith(reservation);

    await coordinator.disable(2);
    expect(test.clearVoiceRuntimeAuthority).toHaveBeenCalledWith(runtimeId);
  });

  it("rejects provisioning when the prepared connection has no bearer session credential", async () => {
    const test = harness(null);
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(test.adapter);

    await expect(coordinator.provision(test.client, input)).rejects.toBeInstanceOf(
      InvalidNativeVoiceRuntimeProvisioningResultError,
    );
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("defers cross-environment replacement until the prior authority can be cleared", async () => {
    const test = harness();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator({
      ...test.adapter,
      ownership: async () => ({
        sequence: 1,
        active: false,
        phase: "idle",
        runtimeId,
        generation: 2,
        environmentOrigin: "https://prior.example.test",
        mode: "realtime",
        targetId: "prior-conversation",
        nativeSessionId: null,
      }),
    });

    await expect(coordinator.provision(test.client, input)).rejects.toBeInstanceOf(
      NativeVoiceRuntimeReplacementDeferredError,
    );
    expect(test.disableIfIdle).not.toHaveBeenCalled();
    expect(test.reserve).not.toHaveBeenCalled();
  });
});

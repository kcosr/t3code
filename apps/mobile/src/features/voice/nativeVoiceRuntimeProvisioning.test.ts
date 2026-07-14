import {
  computeVoiceRuntimeTargetDigest,
  type VoiceHttpClient,
} from "@t3tools/client-runtime/voice";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceRuntimeCredentialHash,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceRuntimeTargetDigest,
  type VoiceRuntimeGrant,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeNativeVoiceRuntimeProvisioningAdapter,
  NativeVoiceRuntimeProvisioningCoordinator,
  type NativeRuntimeGrantClient,
  type NativeVoiceRuntimeProvisioningAdapter,
  type NativeVoiceRuntimeReservation,
} from "./nativeVoiceRuntimeProvisioning";
import {
  canonicalNativeVoiceRuntimeTargetIdentity,
  type ResolvedNativeVoiceRuntimeTarget,
} from "./nativeVoiceRuntimeTarget";

const RUNTIME_ID = VoiceRuntimeId.make("runtime-1");
const RUNTIME_INSTANCE_ID = VoiceRuntimeInstanceId.make("runtime-instance-1");
const OPERATION_ID = VoiceRuntimeProvisioningOperationId.make("provision-1");
const REFRESH_HASH = VoiceRuntimeCredentialHash.make(
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
const ENVIRONMENT_ORIGIN = "https://environment.example.test";
const target = {
  mode: "thread" as const,
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  speechPreset: "default" as const,
  autoRearm: true,
  endpointPolicy: {
    endSilenceMs: 2_200,
    noSpeechTimeoutMs: null,
    maximumUtteranceMs: 600_000,
  },
  speechEnabled: true,
  rearmGuardMs: 500,
};
const resolvedTarget: ResolvedNativeVoiceRuntimeTarget = {
  target,
  targetIdentity: canonicalNativeVoiceRuntimeTargetIdentity(target),
};
const readiness = {
  enabled: true,
  mode: "thread" as const,
  targetId: "project-1/thread-1",
  audioRouteId: "system-default",
  autoRearm: true,
  microphonePermissionGranted: true,
  notificationPermissionGranted: true,
};

async function reservation(): Promise<NativeVoiceRuntimeReservation> {
  return {
    runtimeId: RUNTIME_ID,
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    provisioningOperationId: OPERATION_ID,
    expectedCurrentGeneration: 0,
    generation: 1,
    targetDigest: VoiceRuntimeTargetDigest.make(await computeVoiceRuntimeTargetDigest(target)),
    refreshCredentialHash: REFRESH_HASH,
  };
}

type ThreadVoiceRuntimeGrant = Extract<
  VoiceRuntimeGrant,
  { readonly operation: "thread-turn-start" }
>;

function grant(prepared: NativeVoiceRuntimeReservation): ThreadVoiceRuntimeGrant {
  return {
    token: "runtime-token",
    runtimeId: prepared.runtimeId,
    generation: prepared.generation,
    provisioningOperationId: prepared.provisioningOperationId,
    targetDigest: prepared.targetDigest,
    target,
    operation: "thread-turn-start",
    readinessEnabled: true,
    refreshRotationCounter: 0,
    issuedAt: "2026-07-14T12:00:00.000Z",
    expiresAt: "2026-08-14T12:00:00.000Z",
  };
}

function provisioningInput(epoch: number) {
  return {
    epoch,
    readiness,
    environmentOrigin: ENVIRONMENT_ORIGIN,
    resolvedTarget,
  };
}

function makeNative(prepared: NativeVoiceRuntimeReservation) {
  let authority: "none" | "prepared" | "active" = "none";
  let activeGrant: {
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly refreshRotationCounter: number;
  } | null = null;
  let pendingRevocation: { readonly runtimeId: string; readonly environmentOrigin: string } | null =
    null;
  const inspect = vi.fn<NativeVoiceRuntimeProvisioningAdapter["inspect"]>(async () => {
    if (authority === "none") return null;
    const base = {
      runtimeId: prepared.runtimeId,
      runtimeInstanceId: prepared.runtimeInstanceId,
      provisioningOperationId: prepared.provisioningOperationId,
      expectedCurrentGeneration: prepared.expectedCurrentGeneration,
      generation: prepared.generation,
      targetDigest: prepared.targetDigest,
      target,
      operation: "thread-turn-start" as const,
      environmentOrigin: ENVIRONMENT_ORIGIN,
      readinessEnabled: true,
    };
    if (authority === "prepared") {
      return { ...base, state: "prepared" as const, refreshCredentialHash: REFRESH_HASH };
    }
    const installed = activeGrant!;
    return {
      ...base,
      state: "active" as const,
      refreshCredentialHash: null,
      issuedAt: installed.issuedAt,
      expiresAt: installed.expiresAt,
      refreshRotationCounter: installed.refreshRotationCounter,
    };
  });
  const prepare = vi.fn<NativeVoiceRuntimeProvisioningAdapter["prepare"]>(async () => {
    authority = "prepared";
    return prepared;
  });
  const activate = vi.fn<NativeVoiceRuntimeProvisioningAdapter["activate"]>(async (input) => {
    activeGrant = {
      refreshRotationCounter: input.refreshRotationCounter,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
    authority = "active";
  });
  const native: NativeVoiceRuntimeProvisioningAdapter = {
    inspect,
    prepare,
    activate,
    disable: async () => {
      pendingRevocation = { runtimeId: RUNTIME_ID, environmentOrigin: ENVIRONMENT_ORIGIN };
      authority = "none";
      return { runtimeId: RUNTIME_ID };
    },
    disableIfIdle: async () => {
      if (authority === "active") {
        pendingRevocation = { runtimeId: RUNTIME_ID, environmentOrigin: ENVIRONMENT_ORIGIN };
      }
      authority = "none";
      return true;
    },
    ownership: async () => null,
    pendingRevocation: async () => pendingRevocation,
    acknowledgeRevocation: async () => {
      pendingRevocation = null;
    },
  };
  return { native, inspect, prepare, activate, setPrepared: () => (authority = "prepared") };
}

function makeClient(input?: {
  readonly provision?: (prepared: NativeVoiceRuntimeReservation) => Promise<VoiceRuntimeGrant>;
}) {
  let attempt = 0;
  const provision = vi.fn<NativeRuntimeGrantClient["provisionVoiceRuntimeGrant"]>(
    (runtimeId, payload) =>
      Effect.promise(async () => {
        attempt += 1;
        const prepared = {
          runtimeId,
          runtimeInstanceId: RUNTIME_INSTANCE_ID,
          provisioningOperationId: payload.provisioningOperationId,
          expectedCurrentGeneration: payload.expectedCurrentGeneration,
          generation: payload.generation,
          targetDigest: payload.targetDigest,
          refreshCredentialHash: payload.refreshCredentialHash,
        } satisfies NativeVoiceRuntimeReservation;
        return input?.provision === undefined ? grant(prepared) : input.provision(prepared);
      }),
  );
  const revoke = vi.fn<NativeRuntimeGrantClient["revokeVoiceRuntimeGrant"]>((runtimeId) =>
    Effect.succeed({ runtimeId, revoked: true }),
  );
  return {
    client: {
      provisionVoiceRuntimeGrant: provision,
      revokeVoiceRuntimeGrant: revoke,
    } satisfies Pick<VoiceHttpClient, "provisionVoiceRuntimeGrant" | "revokeVoiceRuntimeGrant">,
    provision,
    revoke,
    attempts: () => attempt,
  };
}

describe("NativeVoiceRuntimeProvisioningCoordinator", () => {
  it("delegates activation to the presentation-aware authority owner", async () => {
    const prepared = await reservation();
    const issued = grant(prepared);
    const activateAuthority = vi.fn(async () => undefined);
    const adapter = makeNativeVoiceRuntimeProvisioningAdapter(
      {} as never,
      () => "unused",
      activateAuthority,
    );
    const authority = {
      runtimeId: issued.runtimeId,
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      expectedCurrentGeneration: prepared.expectedCurrentGeneration,
      generation: issued.generation,
      environmentOrigin: ENVIRONMENT_ORIGIN,
      targetDigest: issued.targetDigest,
      target: issued.target,
      operation: issued.operation,
      readinessEnabled: issued.readinessEnabled,
      provisioningOperationId: issued.provisioningOperationId,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      refreshRotationCounter: issued.refreshRotationCounter,
      token: issued.token,
    } as const;

    await adapter.activate(authority);

    expect(activateAuthority).toHaveBeenCalledWith(authority);
  });

  it("provisions the exact native-prepared CAS authority and installs the server counter", async () => {
    const prepared = await reservation();
    const { native, prepare, activate } = makeNative(prepared);
    const { client, provision } = makeClient();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    const result = await coordinator.provision(client, provisioningInput(1));

    expect(result).toEqual({
      runtimeId: RUNTIME_ID,
      generation: 1,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledWith(RUNTIME_ID, {
      expectedCurrentGeneration: 0,
      generation: 1,
      provisioningOperationId: OPERATION_ID,
      targetDigest: prepared.targetDigest,
      target,
      operation: "thread-turn-start",
      readinessEnabled: true,
      refreshCredentialHash: REFRESH_HASH,
    });
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: RUNTIME_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        refreshRotationCounter: 0,
        token: "runtime-token",
      }),
    );
  });

  it("recovers an exact prepared hash after a failed authenticated PUT", async () => {
    const prepared = await reservation();
    const { native, prepare } = makeNative(prepared);
    const { client, attempts } = makeClient({
      provision: async (candidate) => {
        if (attempts() === 1) throw new Error("connection lost");
        return grant(candidate);
      },
    });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await expect(coordinator.provision(client, provisioningInput(1))).rejects.toThrow(
      "connection lost",
    );
    await expect(coordinator.provision(client, provisioningInput(1))).resolves.toMatchObject({
      runtimeId: RUNTIME_ID,
      generation: 1,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(attempts()).toBe(2);
  });

  it("adopts active authority without React requesting or installing a refresh", async () => {
    const prepared = await reservation();
    const { native } = makeNative(prepared);
    const first = makeClient();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);
    await coordinator.provision(first.client, provisioningInput(1));

    const second = makeClient();
    const restored = new NativeVoiceRuntimeProvisioningCoordinator(native);
    await expect(restored.provision(second.client, provisioningInput(2))).resolves.toMatchObject({
      runtimeId: RUNTIME_ID,
      generation: 1,
    });
    expect(second.provision).not.toHaveBeenCalled();
  });

  it("revokes disabled authority through the canonical runtime API", async () => {
    const prepared = await reservation();
    const { native } = makeNative(prepared);
    const { client, revoke } = makeClient();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);
    await coordinator.provision(client, provisioningInput(1));

    await coordinator.disable(2);

    expect(revoke).toHaveBeenCalledWith(RUNTIME_ID);
  });
});

import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import { RemoteEnvironmentAuthFetchError } from "@t3tools/client-runtime/rpc";
import {
  ProjectId,
  ThreadId,
  VoiceNativeRuntimeId,
  type VoiceNativeRuntimeGrant,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import {
  ConflictingNativeVoiceRuntimeProvisioningEpochError,
  InvalidNativeVoiceRuntimeProvisioningResultError,
  NativeVoiceRuntimeProvisioningCoordinator,
  type NativeVoiceRuntimeProvisioningAdapter,
  StaleNativeVoiceRuntimeProvisioningEpochError,
} from "./nativeVoiceRuntimeProvisioning";
import {
  canonicalNativeVoiceRuntimeTargetIdentity,
  type ResolvedNativeVoiceRuntimeTarget,
} from "./nativeVoiceRuntimeTarget";

const RUNTIME_ID = VoiceNativeRuntimeId.make("runtime-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const EXPIRES_AT = "2026-08-12T10:00:00.000Z";
const target = {
  mode: "thread" as const,
  projectId: PROJECT_ID,
  threadId: THREAD_ID,
  speechPreset: "default" as const,
  autoRearm: true,
};
const resolvedTarget: ResolvedNativeVoiceRuntimeTarget = {
  target,
  targetIdentity: canonicalNativeVoiceRuntimeTargetIdentity(target),
};
const readiness = {
  enabled: true,
  mode: "thread" as const,
  targetId: "project-1/thread-1",
  audioRouteId: "system",
  autoRearm: true,
  microphonePermissionGranted: true,
  notificationPermissionGranted: true,
};

function grant(token = "runtime-secret"): VoiceNativeRuntimeGrant {
  return {
    token,
    runtimeId: RUNTIME_ID,
    generation: 7,
    target,
    expiresAt: EXPIRES_AT,
  };
}

function provisioningInput(epoch = 1) {
  return {
    epoch,
    readiness,
    environmentOrigin: "https://termstation",
    operation: "thread-turn-start" as const,
    resolvedTarget,
  };
}

type GrantClient = Pick<
  VoiceHttpClient,
  "provisionNativeRuntimeGrant" | "revokeNativeRuntimeGrant"
>;

function makeClient(input?: {
  readonly provision?: (attempt: number) => Promise<VoiceNativeRuntimeGrant>;
  readonly revoke?: (attempt: number) => Promise<void>;
  readonly order?: string[];
}): {
  readonly client: GrantClient;
  readonly provision: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
} {
  let provisionAttempt = 0;
  let revokeAttempt = 0;
  const provision = vi.fn<GrantClient["provisionNativeRuntimeGrant"]>(() => {
    input?.order?.push("server-provision");
    provisionAttempt += 1;
    return Effect.tryPromise({
      try: () => input?.provision?.(provisionAttempt) ?? Promise.resolve(grant()),
      catch: (cause) =>
        new RemoteEnvironmentAuthFetchError({ message: "Provisioning failed.", cause }),
    });
  });
  const revoke = vi.fn<GrantClient["revokeNativeRuntimeGrant"]>(() => {
    input?.order?.push("server-revoke");
    revokeAttempt += 1;
    return Effect.tryPromise({
      try: async () => {
        await input?.revoke?.(revokeAttempt);
        return { runtimeId: RUNTIME_ID, revoked: true as const };
      },
      catch: (cause) =>
        new RemoteEnvironmentAuthFetchError({ message: "Revocation failed.", cause }),
    });
  });
  return {
    client: {
      provisionNativeRuntimeGrant: provision,
      revokeNativeRuntimeGrant: revoke,
    },
    provision,
    revoke,
  };
}

function makeNative(input?: {
  readonly activate?: (attempt: number) => Promise<void>;
  readonly disable?: (attempt: number) => Promise<void>;
  readonly prepare?: () => Promise<{
    readonly runtimeId: VoiceNativeRuntimeId;
    readonly readinessGeneration: number;
  }>;
  readonly disabledRuntimeId?: VoiceNativeRuntimeId | null;
  readonly order?: string[];
}) {
  let activateAttempt = 0;
  let disableAttempt = 0;
  const prepare = vi.fn<NativeVoiceRuntimeProvisioningAdapter["prepare"]>(async () => {
    input?.order?.push("native-prepare");
    return (
      (await input?.prepare?.()) ?? {
        runtimeId: RUNTIME_ID,
        readinessGeneration: 7,
      }
    );
  });
  const activate = vi.fn<NativeVoiceRuntimeProvisioningAdapter["activate"]>(async () => {
    input?.order?.push("native-activate");
    activateAttempt += 1;
    await input?.activate?.(activateAttempt);
  });
  const disable = vi.fn<NativeVoiceRuntimeProvisioningAdapter["disable"]>(async () => {
    input?.order?.push("native-disable");
    disableAttempt += 1;
    await input?.disable?.(disableAttempt);
    return { runtimeId: input?.disabledRuntimeId ?? RUNTIME_ID };
  });
  return {
    native: { prepare, activate, disable } satisfies NativeVoiceRuntimeProvisioningAdapter,
    prepare,
    activate,
    disable,
  };
}

describe("NativeVoiceRuntimeProvisioningCoordinator", () => {
  it("prepares, provisions, and atomically activates without returning the token", async () => {
    const order: string[] = [];
    const { client, provision } = makeClient({ order });
    const { native, prepare, activate } = makeNative({ order });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);

    const result = await coordinator.provision(provisioningInput());

    expect(order).toEqual(["native-prepare", "server-provision", "native-activate"]);
    expect(prepare).toHaveBeenCalledWith({
      epoch: 1,
      readiness,
      environmentOrigin: "https://termstation",
      operation: "thread-turn-start",
      targetIdentity: resolvedTarget.targetIdentity,
    });
    expect(provision).toHaveBeenCalledWith(RUNTIME_ID, { generation: 7, target });
    expect(activate).toHaveBeenCalledWith({
      runtimeId: RUNTIME_ID,
      readinessGeneration: 7,
      environmentOrigin: "https://termstation",
      operation: "thread-turn-start",
      targetIdentity: resolvedTarget.targetIdentity,
      expiresAtEpochMillis: Date.parse(EXPIRES_AT),
      token: "runtime-secret",
    });
    expect(result).toEqual({
      runtimeId: RUNTIME_ID,
      readinessGeneration: 7,
      expiresAt: EXPIRES_AT,
    });
    expect(result).not.toHaveProperty("token");
  });

  it("retries PUT with the same native generation after an ambiguous request failure", async () => {
    const { client, provision } = makeClient({
      provision: (attempt) =>
        attempt === 1 ? Promise.reject(new Error("response lost")) : Promise.resolve(grant()),
    });
    const { native, prepare, activate, disable } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);

    await expect(coordinator.provision(provisioningInput())).rejects.toBeInstanceOf(Error);
    await expect(coordinator.provision(provisioningInput())).resolves.toMatchObject({
      readinessGeneration: 7,
    });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision.mock.calls.map((call) => call[1].generation)).toEqual([7, 7]);
    expect(activate).toHaveBeenCalledOnce();
    expect(disable).not.toHaveBeenCalled();
  });

  it("retries native activation at the same generation with a freshly rotated token", async () => {
    const issuedTokens = ["first-token", "rotated-token"];
    const { client, provision } = makeClient({
      provision: (attempt) => Promise.resolve(grant(issuedTokens[attempt - 1])),
    });
    const { native, activate, disable } = makeNative({
      activate: (attempt) =>
        attempt === 1 ? Promise.reject(new Error("keystore busy")) : Promise.resolve(),
    });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);

    await expect(coordinator.provision(provisioningInput())).rejects.toThrow("keystore busy");
    await expect(coordinator.provision(provisioningInput())).resolves.toMatchObject({
      readinessGeneration: 7,
    });

    expect(provision).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls.map((call) => call[0].token)).toEqual(issuedTokens);
    expect(disable).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical target identity before native or server mutation", async () => {
    const { client, provision } = makeClient();
    const { native, prepare } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);

    await expect(
      coordinator.provision({
        ...provisioningInput(),
        resolvedTarget: { target, targetIdentity: '{"mode":"thread"}' },
      }),
    ).rejects.toBeInstanceOf(InvalidNativeVoiceRuntimeProvisioningResultError);
    expect(prepare).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("fences an in-flight older epoch and cleans it up before the newer epoch runs", async () => {
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const order: string[] = [];
    const { client, provision, revoke } = makeClient({ order });
    const { native, disable } = makeNative({
      order,
      prepare: async () => {
        await prepareGate;
        return { runtimeId: RUNTIME_ID, readinessGeneration: 7 };
      },
    });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);

    const stale = coordinator.provision(provisioningInput(1));
    await vi.waitFor(() => expect(order).toEqual(["native-prepare"]));
    const disabled = coordinator.disable(2);
    releasePrepare();

    await expect(stale).rejects.toBeInstanceOf(StaleNativeVoiceRuntimeProvisioningEpochError);
    await expect(disabled).resolves.toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
    expect(disable).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "native-prepare",
      "native-disable",
      "server-revoke",
      "native-disable",
      "server-revoke",
    ]);
  });

  it("rejects older and conflicting same-epoch intents synchronously", () => {
    const { client } = makeClient();
    const { native } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);
    const current = coordinator.provision(provisioningInput(2));

    expect(() => coordinator.provision(provisioningInput(1))).toThrow(
      StaleNativeVoiceRuntimeProvisioningEpochError,
    );
    expect(() => coordinator.disable(2)).toThrow(
      ConflictingNativeVoiceRuntimeProvisioningEpochError,
    );
    return current;
  });

  it("disables native execution before revocation and retries a failed revoke", async () => {
    const order: string[] = [];
    const { client, revoke } = makeClient({
      order,
      revoke: (attempt) =>
        attempt === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(),
    });
    const { native, disable } = makeNative({ order });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);

    await expect(coordinator.disable(1)).rejects.toBeInstanceOf(Error);
    await expect(coordinator.disable(1)).resolves.toBeUndefined();

    expect(disable).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["native-disable", "server-revoke", "native-disable", "server-revoke"]);
  });

  it("finishes a failed native cleanup before provisioning a newer epoch", async () => {
    const order: string[] = [];
    const { client, provision, revoke } = makeClient({ order });
    const { native, disable } = makeNative({
      order,
      disable: (attempt) =>
        attempt === 1 ? Promise.reject(new Error("native busy")) : Promise.resolve(),
    });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(client, native);

    await coordinator.provision(provisioningInput(1));
    await expect(coordinator.disable(2)).rejects.toThrow("native busy");
    await expect(coordinator.provision(provisioningInput(3))).resolves.toMatchObject({
      readinessGeneration: 7,
    });

    expect(disable).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "native-prepare",
      "server-provision",
      "native-activate",
      "native-disable",
      "native-disable",
      "server-revoke",
      "native-prepare",
      "server-provision",
      "native-activate",
    ]);
  });
});

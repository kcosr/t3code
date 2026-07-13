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
  nativeVoiceRuntimeRefreshAt,
  PendingNativeVoiceRuntimeRevocationOriginError,
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

function requireValue<A>(value: A | null): A {
  if (value === null) throw new Error("Expected a value.");
  return value;
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
  readonly inspect?: NativeVoiceRuntimeProvisioningAdapter["inspect"];
  readonly activate?: (attempt: number) => Promise<void>;
  readonly disable?: (attempt: number) => Promise<void>;
  readonly prepare?: () => Promise<{
    readonly runtimeId: VoiceNativeRuntimeId;
    readonly readinessGeneration: number;
  }>;
  readonly disabledRuntimeId?: VoiceNativeRuntimeId | null;
  readonly pendingRevocation?: { readonly runtimeId: string; readonly environmentOrigin: string };
  readonly order?: string[];
}) {
  let activateAttempt = 0;
  let disableAttempt = 0;
  let authority: "none" | "prepared" | "active" = "none";
  let authorityTargetIdentity: string | null = null;
  let authorityEnvironmentOrigin = "https://termstation";
  let refreshPending = false;
  let expiresAtEpochMillis = Date.parse(EXPIRES_AT);
  let pendingRevocation: { runtimeId: string; environmentOrigin: string } | null =
    input?.pendingRevocation ?? null;
  const inspect = vi.fn<NativeVoiceRuntimeProvisioningAdapter["inspect"]>(async (request) => {
    if (input?.inspect !== undefined) return input.inspect(request);
    if (authority === "none" || authorityTargetIdentity !== request.targetIdentity) return null;
    return {
      state: authority,
      runtimeId: RUNTIME_ID,
      readiness: { ...readiness, generation: 7 },
      environmentOrigin: authorityEnvironmentOrigin,
      operation: "thread-turn-start",
      expiresAtEpochMillis: authority === "active" ? expiresAtEpochMillis : null,
      refreshPending,
    };
  });
  const prepare = vi.fn<NativeVoiceRuntimeProvisioningAdapter["prepare"]>(async (request) => {
    input?.order?.push("native-prepare");
    authority = "prepared";
    authorityTargetIdentity = request.targetIdentity;
    authorityEnvironmentOrigin = new URL(request.environmentOrigin).origin;
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
    authority = "active";
  });
  const disable = vi.fn<NativeVoiceRuntimeProvisioningAdapter["disable"]>(async () => {
    input?.order?.push("native-disable");
    disableAttempt += 1;
    await input?.disable?.(disableAttempt);
    const runtimeId = authority === "none" ? null : (input?.disabledRuntimeId ?? RUNTIME_ID);
    if (runtimeId !== null) {
      pendingRevocation = {
        runtimeId,
        environmentOrigin: authorityEnvironmentOrigin,
      };
    }
    authority = "none";
    authorityTargetIdentity = null;
    refreshPending = false;
    return { runtimeId };
  });
  const pending = vi.fn(async () => pendingRevocation);
  const acknowledge = vi.fn(async () => {
    pendingRevocation = null;
  });
  const beginRefresh = vi.fn<NativeVoiceRuntimeProvisioningAdapter["beginRefresh"]>(async () => {
    if (authority !== "active") throw new Error("authority is not active");
    refreshPending = true;
    return requireValue(
      await inspect({
        readiness,
        environmentOrigin: "https://termstation",
        operation: "thread-turn-start",
        targetIdentity: requireValue(authorityTargetIdentity),
      }),
    );
  });
  const installRefresh = vi.fn<NativeVoiceRuntimeProvisioningAdapter["installRefresh"]>(
    async (grantInput) => {
      if (!refreshPending) throw new Error("refresh was not begun");
      expiresAtEpochMillis = grantInput.expiresAtEpochMillis;
      refreshPending = false;
      return requireValue(
        await inspect({
          readiness,
          environmentOrigin: grantInput.environmentOrigin,
          operation: grantInput.operation,
          targetIdentity: grantInput.targetIdentity,
        }),
      );
    },
  );
  return {
    native: {
      inspect,
      prepare,
      activate,
      beginRefresh,
      installRefresh,
      disable,
      pendingRevocation: pending,
      acknowledgeRevocation: acknowledge,
    } satisfies NativeVoiceRuntimeProvisioningAdapter,
    inspect,
    beginRefresh,
    installRefresh,
    acknowledge,
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
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    const result = await coordinator.provision(client, provisioningInput());

    expect(order).toEqual([
      "native-disable",
      "native-prepare",
      "server-provision",
      "native-activate",
    ]);
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
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await expect(coordinator.provision(client, provisioningInput())).rejects.toBeInstanceOf(Error);
    await expect(coordinator.provision(client, provisioningInput())).resolves.toMatchObject({
      readinessGeneration: 7,
    });

    expect(prepare).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision.mock.calls.map((call) => call[1].generation)).toEqual([7, 7]);
    expect(activate).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledOnce();
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
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await expect(coordinator.provision(client, provisioningInput())).rejects.toThrow(
      "keystore busy",
    );
    await expect(coordinator.provision(client, provisioningInput())).resolves.toMatchObject({
      readinessGeneration: 7,
    });

    expect(provision).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls.map((call) => call[0].token)).toEqual(issuedTokens);
    expect(disable).toHaveBeenCalledOnce();
  });

  it("keeps an equivalent active reservation across a newer React epoch", async () => {
    const { client, provision } = makeClient();
    const { native, prepare, activate, disable } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    const first = await coordinator.provision(client, provisioningInput(1));
    const second = await coordinator.provision(client, provisioningInput(2));

    expect(second).toEqual(first);
    expect(prepare).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledOnce();
  });

  it("refreshes an exact active authority without disabling or preparing it", async () => {
    const { client, provision } = makeClient();
    const { native, prepare, activate, disable, beginRefresh, installRefresh } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await coordinator.provision(client, provisioningInput(1));
    const refreshed = await coordinator.provision(client, {
      ...provisioningInput(2),
      refreshRequested: true,
    });

    expect(refreshed.expiresAt).toBe(EXPIRES_AT);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(beginRefresh).toHaveBeenCalledOnce();
    expect(installRefresh).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledOnce();
  });

  it("recovers a refresh whose server response was lost", async () => {
    const { client, provision } = makeClient({
      provision: (attempt) =>
        attempt === 2 ? Promise.reject(new Error("response lost")) : Promise.resolve(grant()),
    });
    const { native, beginRefresh, installRefresh } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await coordinator.provision(client, provisioningInput(1));
    await expect(
      coordinator.provision(client, { ...provisioningInput(2), refreshRequested: true }),
    ).rejects.toBeInstanceOf(Error);
    await expect(coordinator.provision(client, provisioningInput(2))).resolves.toMatchObject({
      readinessGeneration: 7,
    });

    expect(provision).toHaveBeenCalledTimes(3);
    expect(beginRefresh).toHaveBeenCalledOnce();
    expect(installRefresh).toHaveBeenCalledOnce();
  });

  it("reprovisions when a newer React epoch changes the target", async () => {
    const nextTarget = {
      ...target,
      threadId: ThreadId.make("thread-2"),
    };
    const nextResolvedTarget: ResolvedNativeVoiceRuntimeTarget = {
      target: nextTarget,
      targetIdentity: canonicalNativeVoiceRuntimeTargetIdentity(nextTarget),
    };
    const { client, provision } = makeClient({
      provision: (attempt) =>
        Promise.resolve(
          attempt === 1
            ? grant()
            : {
                ...grant("next-secret"),
                target: nextTarget,
              },
        ),
    });
    const { native, prepare, activate } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await coordinator.provision(client, provisioningInput(1));
    await coordinator.provision(client, {
      ...provisioningInput(2),
      readiness: { ...readiness, targetId: "project-1/thread-2" },
      resolvedTarget: nextResolvedTarget,
    });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("revokes an old environment with its original client before switching", async () => {
    const nextTarget = { ...target, threadId: ThreadId.make("thread-other-environment") };
    const first = makeClient();
    const second = makeClient({
      provision: () => Promise.resolve({ ...grant("other-secret"), target: nextTarget }),
    });
    const { native } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await coordinator.provision(first.client, provisioningInput(1));
    await coordinator.provision(second.client, {
      ...provisioningInput(2),
      environmentOrigin: "https://other.example.test/path",
      readiness: { ...readiness, targetId: "project-1/thread-other-environment" },
      resolvedTarget: {
        target: nextTarget,
        targetIdentity: canonicalNativeVoiceRuntimeTargetIdentity(nextTarget),
      },
    });

    expect(first.revoke).toHaveBeenCalledOnce();
    expect(second.revoke).not.toHaveBeenCalled();
    expect(second.provision).toHaveBeenCalledOnce();
  });

  it("drains a durable revocation before provisioning after process restart", async () => {
    const { client, provision, revoke } = makeClient();
    const { native, acknowledge } = makeNative({
      pendingRevocation: {
        runtimeId: RUNTIME_ID,
        environmentOrigin: "https://termstation",
      },
    });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await coordinator.provision(client, provisioningInput());

    expect(revoke).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
  });

  it("blocks replacement when a durable revocation belongs to another environment", async () => {
    const { client, provision, revoke } = makeClient();
    const { native, acknowledge, disable } = makeNative({
      pendingRevocation: {
        runtimeId: RUNTIME_ID,
        environmentOrigin: "https://other.example.test",
      },
    });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await expect(coordinator.provision(client, provisioningInput())).rejects.toBeInstanceOf(
      PendingNativeVoiceRuntimeRevocationOriginError,
    );

    expect(revoke).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical target identity before native or server mutation", async () => {
    const { client, provision } = makeClient();
    const { native, prepare } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await expect(
      coordinator.provision(client, {
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
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    const stale = coordinator.provision(client, provisioningInput(1));
    await vi.waitFor(() => expect(order).toEqual(["native-disable", "native-prepare"]));
    const disabled = coordinator.disable(2, {
      client,
      environmentOrigin: "https://termstation",
    });
    releasePrepare();

    await expect(stale).rejects.toBeInstanceOf(StaleNativeVoiceRuntimeProvisioningEpochError);
    await expect(disabled).resolves.toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
    expect(disable).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "native-disable",
      "native-prepare",
      "native-disable",
      "server-revoke",
      "native-disable",
    ]);
  });

  it("rejects older and conflicting same-epoch intents synchronously", () => {
    const { client } = makeClient();
    const { native } = makeNative();
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);
    const current = coordinator.provision(client, provisioningInput(2));

    expect(() => coordinator.provision(client, provisioningInput(1))).toThrow(
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
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await coordinator.provision(client, provisioningInput());
    order.length = 0;
    const fallback = { client, environmentOrigin: "https://termstation" };
    await expect(coordinator.disable(2, fallback)).rejects.toBeInstanceOf(Error);
    await expect(coordinator.disable(2, fallback)).resolves.toBeUndefined();

    expect(disable).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["native-disable", "server-revoke", "native-disable", "server-revoke"]);
  });

  it("finishes a failed native cleanup before provisioning a newer epoch", async () => {
    const order: string[] = [];
    const replacementTarget = { ...target, threadId: ThreadId.make("thread-replacement") };
    const { client, provision, revoke } = makeClient({
      order,
      provision: (attempt) =>
        Promise.resolve(
          attempt === 1 ? grant() : { ...grant("replacement"), target: replacementTarget },
        ),
    });
    const { native, disable } = makeNative({
      order,
      disable: (attempt) =>
        attempt === 2 ? Promise.reject(new Error("native busy")) : Promise.resolve(),
    });
    const coordinator = new NativeVoiceRuntimeProvisioningCoordinator(native);

    await coordinator.provision(client, provisioningInput(1));
    await expect(
      coordinator.disable(2, { client, environmentOrigin: "https://termstation" }),
    ).rejects.toThrow("native busy");
    await expect(
      coordinator.provision(client, {
        ...provisioningInput(3),
        readiness: { ...readiness, targetId: "project-1/thread-replacement" },
        resolvedTarget: {
          target: replacementTarget,
          targetIdentity: canonicalNativeVoiceRuntimeTargetIdentity(replacementTarget),
        },
      }),
    ).resolves.toMatchObject({
      readinessGeneration: 7,
    });

    expect(disable).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "native-disable",
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

describe("nativeVoiceRuntimeRefreshAt", () => {
  it("refreshes long grants one day before expiry", () => {
    const now = 1_800_000_000_000;
    const expiresAt = now + 30 * 24 * 60 * 60 * 1_000;
    expect(nativeVoiceRuntimeRefreshAt(expiresAt, now)).toBe(expiresAt - 24 * 60 * 60 * 1_000);
  });

  it("uses the final fifth of a short grant and refreshes expired grants immediately", () => {
    const now = 1_800_000_000_000;
    const expiresAt = now + 60 * 60 * 1_000;
    expect(nativeVoiceRuntimeRefreshAt(expiresAt, now)).toBe(now + 48 * 60 * 1_000);
    expect(nativeVoiceRuntimeRefreshAt(now - 1, now)).toBe(now);
  });
});

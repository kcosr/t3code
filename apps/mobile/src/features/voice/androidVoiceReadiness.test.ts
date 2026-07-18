import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  VoiceHttpClient,
  VoiceRealtimeTarget,
  VoiceThreadStartInput,
} from "@t3tools/client-runtime/voice";
import {
  EnvironmentId,
  VoiceConversationId,
  type VoiceConversationSummary,
} from "@t3tools/contracts";
import type { T3VoiceNativeModule, T3VoiceReadinessSnapshot } from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-notifications", () => ({
  AndroidImportance: { LOW: 4 },
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

import {
  acceptEnabledAndroidVoiceReadiness,
  androidVoiceReadinessIdentity,
  AndroidVoiceReadinessCoordinator,
  concreteRealtimeReadinessTarget,
  persistAndroidVoiceReadinessSetting,
  provisionAndroidVoiceReadiness,
  reconcileAndroidVoiceReadinessDisable,
} from "./androidVoiceReadiness";

const baseTarget: Omit<VoiceRealtimeTarget, "conversation"> = {
  environmentId: EnvironmentId.make("environment-ready"),
  focus: null,
  threadSettings: null,
};

const durableConversation = (conversationId: string): VoiceConversationSummary => ({
  conversationId: VoiceConversationId.make(conversationId),
  retention: "durable",
  title: "Realtime",
  activeEpoch: 0,
  lastCallAt: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
});

describe("concreteRealtimeReadinessTarget", () => {
  it("creates a durable conversation once and reuses it on later provisioning", async () => {
    let saved: VoiceConversationSummary | null = null;
    const listConversations = vi.fn<VoiceHttpClient["listConversations"]>(() =>
      Effect.succeed({ conversations: saved === null ? [] : [saved], nextCursor: null }),
    );
    const createConversation = vi.fn<VoiceHttpClient["createConversation"]>(() =>
      Effect.sync(() => {
        saved = durableConversation("prepared-realtime");
        return saved;
      }),
    );
    const client = { listConversations, createConversation };
    const signal = new AbortController().signal;

    const first = await concreteRealtimeReadinessTarget(client, baseTarget, signal);
    const second = await concreteRealtimeReadinessTarget(client, baseTarget, signal);

    expect(first?.conversation).toEqual({
      type: "continue",
      conversationId: VoiceConversationId.make("prepared-realtime"),
      takeover: false,
    });
    expect(second).toEqual(first);
    expect(createConversation).toHaveBeenCalledOnce();
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ retention: "durable" }),
    );
  });

  it("does not create a conversation after cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const listConversations = vi.fn<VoiceHttpClient["listConversations"]>(() =>
      Effect.die("must not list"),
    );
    const createConversation = vi.fn<VoiceHttpClient["createConversation"]>(() =>
      Effect.die("must not create"),
    );

    await expect(
      concreteRealtimeReadinessTarget(
        { listConversations, createConversation },
        baseTarget,
        abort.signal,
      ),
    ).resolves.toBeNull();
    expect(listConversations).not.toHaveBeenCalled();
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("atomically configures the next generation with an independent Thread switch", async () => {
    const saved = durableConversation("prepared-realtime");
    const configureReadinessAsync = vi.fn<T3VoiceNativeModule["configureReadinessAsync"]>(
      async (configuration) => ({
        posture: "ready" as const,
        generation: configuration.generation,
        mode: configuration.mode,
        label: configuration.label,
        expiresAt: configuration.start?.session.expiresAt ?? "",
      }),
    );
    const native = {
      getMicrophonePermissionAsync: vi.fn(async () => ({ granted: true })),
      getBluetoothPermissionAsync: vi.fn(async () => ({ granted: true })),
      requestBluetoothPermissionAsync: vi.fn(async () => ({ granted: true })),
      getReadinessSnapshotAsync: vi.fn(async () => ({ posture: "disabled", generation: 7 })),
      configureReadinessAsync,
    } as unknown as T3VoiceNativeModule;
    const client = {
      listConversations: () => Effect.succeed({ conversations: [saved], nextCursor: null }),
      createConversation: () => Effect.die("must not create"),
      createNativeSession: () =>
        Effect.succeed({
          accessToken: "bounded-child-token",
          expiresAt: "2026-07-17T23:00:00.000Z" as never,
        }),
    } as Pick<
      VoiceHttpClient,
      "listConversations" | "createConversation" | "createNativeSession"
    > as VoiceHttpClient;
    const threadSwitch = {
      target: { environmentId: baseTarget.environmentId, threadId: "remembered" },
    } as unknown as VoiceThreadStartInput;

    await provisionAndroidVoiceReadiness({
      native,
      prepared: {
        environmentId: baseTarget.environmentId,
        httpBaseUrl: "https://environment.example.test/base-path",
      } as PreparedConnection,
      client,
      target: { mode: "realtime", label: "Realtime", target: baseTarget },
      threadSwitch,
      signal: new AbortController().signal,
      requestNotificationPermission: async () => "granted",
    });

    expect(configureReadinessAsync).toHaveBeenCalledWith({
      generation: 8,
      mode: "realtime",
      label: "Realtime",
      start: {
        type: "realtime",
        input: {
          ...baseTarget,
          conversation: {
            type: "continue",
            conversationId: VoiceConversationId.make("prepared-realtime"),
            takeover: false,
          },
        },
        session: {
          baseUrl: "https://environment.example.test/",
          accessToken: "bounded-child-token",
          expiresAt: "2026-07-17T23:00:00.000Z",
        },
      },
      threadSwitch,
    });
  });

  it("truncates the native label without changing the UI target", async () => {
    const configureReadinessAsync = vi.fn<T3VoiceNativeModule["configureReadinessAsync"]>(
      async (configuration) => ({
        posture: "unavailable" as const,
        generation: configuration.generation,
        mode: configuration.mode,
        label: configuration.label,
      }),
    );
    const native = {
      getMicrophonePermissionAsync: async () => ({ granted: true }),
      getBluetoothPermissionAsync: async () => ({ granted: true }),
      getReadinessSnapshotAsync: async () => ({ posture: "disabled" as const, generation: 0 }),
      configureReadinessAsync,
    } as unknown as T3VoiceNativeModule;
    const label = `  ${"x".repeat(300)}  `;

    await provisionAndroidVoiceReadiness({
      native,
      prepared: null,
      client: null,
      target: { mode: "thread", label, target: null },
      threadSwitch: null,
      signal: new AbortController().signal,
      requestNotificationPermission: async () => "granted",
    });

    expect(configureReadinessAsync.mock.calls[0]?.[0].label).toHaveLength(256);
    expect(label).toHaveLength(304);
  });

  it("truncates astral characters without splitting a surrogate pair", async () => {
    const configureReadinessAsync = vi.fn<T3VoiceNativeModule["configureReadinessAsync"]>(
      async (configuration) => ({
        posture: "unavailable" as const,
        generation: configuration.generation,
        mode: configuration.mode,
        label: configuration.label,
      }),
    );
    const native = {
      getMicrophonePermissionAsync: async () => ({ granted: true }),
      getBluetoothPermissionAsync: async () => ({ granted: true }),
      getReadinessSnapshotAsync: async () => ({ posture: "disabled" as const, generation: 0 }),
      configureReadinessAsync,
    } as unknown as T3VoiceNativeModule;

    await provisionAndroidVoiceReadiness({
      native,
      prepared: null,
      client: null,
      target: { mode: "thread", label: `${"x".repeat(255)}🎤`, target: null },
      threadSwitch: null,
      signal: new AbortController().signal,
      requestNotificationPermission: async () => "granted",
    });

    expect(configureReadinessAsync.mock.calls[0]?.[0].label).toBe("x".repeat(255));
  });

  it("rejects a prepared connection from a different environment before permissions", async () => {
    const getMicrophonePermissionAsync = vi.fn(async () => ({ granted: true }));
    const native = { getMicrophonePermissionAsync } as unknown as T3VoiceNativeModule;

    await expect(
      provisionAndroidVoiceReadiness({
        native,
        prepared: {
          environmentId: EnvironmentId.make("environment-other"),
        } as PreparedConnection,
        client: {} as VoiceHttpClient,
        target: { mode: "realtime", label: "Realtime", target: baseTarget },
        threadSwitch: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("wrong environment");
    expect(getMicrophonePermissionAsync).not.toHaveBeenCalled();
  });
});

describe("acceptEnabledAndroidVoiceReadiness", () => {
  it("disables an unavailable Active Thread before rejecting enable", async () => {
    const disable = vi.fn(async () => undefined);

    await expect(
      acceptEnabledAndroidVoiceReadiness(
        {
          posture: "unavailable",
          generation: 4,
          mode: "thread",
          label: "Active Thread",
        },
        "thread",
        disable,
      ),
    ).rejects.toThrow("selected Active Thread is unavailable");
    expect(disable).toHaveBeenCalledOnce();
  });

  it("disables an already-expired readiness response before rejecting enable", async () => {
    const disable = vi.fn(async () => undefined);

    await expect(
      acceptEnabledAndroidVoiceReadiness(
        {
          posture: "needs-refresh",
          generation: 5,
          mode: "realtime",
          label: "Realtime",
          expiresAt: "2026-07-16T00:00:00.000Z",
        },
        "realtime",
        disable,
      ),
    ).rejects.toThrow("need to be refreshed");
    expect(disable).toHaveBeenCalledOnce();
  });
});

const coordinatorNative = () => {
  let snapshot: T3VoiceReadinessSnapshot = { posture: "disabled", generation: 0 };
  const configureReadinessAsync = vi.fn<T3VoiceNativeModule["configureReadinessAsync"]>(
    async (configuration) => {
      snapshot = {
        posture: "unavailable" as const,
        generation: configuration.generation,
        mode: configuration.mode,
        label: configuration.label,
      };
      return snapshot;
    },
  );
  const disableReadinessAsync = vi.fn<T3VoiceNativeModule["disableReadinessAsync"]>(
    async ({ generation }) => {
      snapshot = { posture: "disabled", generation };
      return snapshot;
    },
  );
  const getMicrophonePermissionAsync = vi.fn(async () => ({ granted: true }));
  return {
    configureReadinessAsync,
    disableReadinessAsync,
    getMicrophonePermissionAsync,
    native: {
      getMicrophonePermissionAsync,
      getBluetoothPermissionAsync: vi.fn(async () => ({ granted: true })),
      getReadinessSnapshotAsync: vi.fn(async () => snapshot),
      configureReadinessAsync,
      disableReadinessAsync,
    } as unknown as T3VoiceNativeModule,
  };
};

const unavailableRequest = (label: string) => {
  const target = { mode: "thread" as const, label, target: null };
  return {
    identity: androidVoiceReadinessIdentity(target, null),
    prepared: null,
    client: null,
    target,
    threadSwitch: null,
    requestNotificationPermission: async () => "granted" as const,
  };
};

describe("AndroidVoiceReadinessCoordinator", () => {
  it("deduplicates the same in-flight desired configuration", async () => {
    const harness = coordinatorNative();
    const coordinator = new AndroidVoiceReadinessCoordinator(harness.native, () => undefined);
    const request = unavailableRequest("Thread A");

    const first = coordinator.request(request);
    const second = coordinator.request(request);

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ posture: "unavailable", label: "Thread A" });
    expect(harness.configureReadinessAsync).toHaveBeenCalledOnce();
  });

  it("supersedes the same target when its connection dependency changes", async () => {
    const harness = coordinatorNative();
    let releaseFirst!: () => void;
    const firstPermission = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    harness.getMicrophonePermissionAsync
      .mockImplementationOnce(async () => {
        await firstPermission;
        return { granted: true };
      })
      .mockResolvedValue({ granted: true });
    const coordinator = new AndroidVoiceReadinessCoordinator(harness.native, () => undefined);
    const request = unavailableRequest("Thread A");
    const staleClient = {} as VoiceHttpClient;
    const currentClient = {} as VoiceHttpClient;

    const stale = coordinator.request({ ...request, client: staleClient });
    await vi.waitFor(() => expect(harness.getMicrophonePermissionAsync).toHaveBeenCalledOnce());
    const current = coordinator.request({ ...request, client: currentClient });
    expect(current).not.toBe(stale);
    releaseFirst();

    await expect(stale).resolves.toBeNull();
    await expect(current).resolves.toMatchObject({ posture: "unavailable", label: "Thread A" });
    expect(harness.configureReadinessAsync).toHaveBeenCalledOnce();
  });

  it("refreshes the same desired identity without disabling its valid Ready envelope", async () => {
    const harness = coordinatorNative();
    const coordinator = new AndroidVoiceReadinessCoordinator(harness.native, () => undefined);
    const request = unavailableRequest("Thread A");

    await coordinator.request(request);
    const disablesAfterInitialFence = harness.disableReadinessAsync.mock.calls.length;
    await coordinator.request(request);

    expect(harness.configureReadinessAsync).toHaveBeenCalledTimes(2);
    expect(harness.disableReadinessAsync).toHaveBeenCalledTimes(disablesAfterInitialFence);
  });

  it("fences a prior identity before resolving its replacement", async () => {
    const harness = coordinatorNative();
    const coordinator = new AndroidVoiceReadinessCoordinator(harness.native, () => undefined);
    await coordinator.request(unavailableRequest("Thread A"));
    harness.getMicrophonePermissionAsync.mockClear();
    let releaseFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    harness.disableReadinessAsync.mockImplementationOnce(async ({ generation }) => {
      await fence;
      return { posture: "disabled", generation };
    });

    const replacement = coordinator.request(unavailableRequest("Thread B"));
    await vi.waitFor(() => expect(harness.disableReadinessAsync).toHaveBeenCalledOnce());
    expect(harness.getMicrophonePermissionAsync).not.toHaveBeenCalled();
    releaseFence();
    await replacement;
  });

  it("cancels a stale resolver and only configures the newest identity", async () => {
    const harness = coordinatorNative();
    let releaseFirst!: () => void;
    const firstPermission = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    harness.getMicrophonePermissionAsync
      .mockImplementationOnce(async () => {
        await firstPermission;
        return { granted: true };
      })
      .mockResolvedValue({ granted: true });
    const coordinator = new AndroidVoiceReadinessCoordinator(harness.native, () => undefined);

    const stale = coordinator.request(unavailableRequest("Thread A"));
    await vi.waitFor(() => expect(harness.getMicrophonePermissionAsync).toHaveBeenCalledOnce());
    const newest = coordinator.request(unavailableRequest("Thread B"));
    releaseFirst();

    await expect(stale).resolves.toBeNull();
    await expect(newest).resolves.toMatchObject({ posture: "unavailable", label: "Thread B" });
    expect(harness.configureReadinessAsync).toHaveBeenCalledOnce();
    expect(harness.configureReadinessAsync.mock.calls[0]?.[0].label).toBe("Thread B");
  });

  it("does not retry a denied permission", async () => {
    const harness = coordinatorNative();
    harness.getMicrophonePermissionAsync.mockResolvedValue({ granted: false });
    const coordinator = new AndroidVoiceReadinessCoordinator(harness.native, () => undefined);

    await expect(coordinator.request(unavailableRequest("Thread"))).rejects.toThrow(
      "microphone access",
    );
    expect(harness.getMicrophonePermissionAsync).toHaveBeenCalledOnce();
    expect(harness.configureReadinessAsync).not.toHaveBeenCalled();
  });
});

describe("persistAndroidVoiceReadinessSetting", () => {
  it("awaits native compensation before surfacing a durable preference failure", async () => {
    const order: string[] = [];

    await expect(
      persistAndroidVoiceReadinessSetting(
        true,
        async () => {
          order.push("persist");
          throw new Error("storage failed");
        },
        async () => {
          order.push("compensate");
        },
      ),
    ).rejects.toThrow("storage failed");
    expect(order).toEqual(["persist", "compensate"]);
  });
});

describe("reconcileAndroidVoiceReadinessDisable", () => {
  it("persists once before acknowledging the native marker", async () => {
    const order: string[] = [];
    const native = {
      getPendingReadinessDisableAsync: async () => 12,
      acknowledgeReadinessDisableAsync: async ({ generation }: { generation: number }) => {
        order.push(`ack:${generation}`);
      },
    } as unknown as T3VoiceNativeModule;

    await expect(
      reconcileAndroidVoiceReadinessDisable(
        native,
        async () => {
          order.push("persist");
        },
        () => order.push("cancel"),
        () => order.push("accept"),
      ),
    ).resolves.toBe(true);
    expect(order).toEqual(["cancel", "persist", "accept", "ack:12"]);
  });
});

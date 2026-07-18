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
import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-notifications", () => ({
  AndroidImportance: { LOW: 4 },
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

import {
  concreteRealtimeReadinessTarget,
  provisionAndroidVoiceReadiness,
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
    const threadSwitch = { target: { threadId: "remembered" } } as unknown as VoiceThreadStartInput;

    await provisionAndroidVoiceReadiness({
      native,
      prepared: { httpBaseUrl: "https://environment.example.test/base-path" } as PreparedConnection,
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
});

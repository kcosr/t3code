import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import {
  VoiceConversationId,
  VoiceSessionId,
  type VoiceSessionCreateInput,
} from "@t3tools/contracts";
import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { RealtimeVoiceController } from "./realtimeVoiceController";

const SESSION_ID = VoiceSessionId.make("voice-session-1");
const createInput: VoiceSessionCreateInput = {
  mode: "realtime-agent",
  conversation: { type: "new", retention: "ephemeral" },
  media: {
    transports: ["webrtc-sdp-v1"],
    audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
    supportsInputRouteSelection: true,
    supportsOutputRouteSelection: true,
  },
  idempotencyKey: "start-1",
};

const serverSession = {
  state: {
    sessionId: SESSION_ID,
    conversationId: VoiceConversationId.make("conversation-1"),
    mode: "realtime-agent" as const,
    phase: "signaling" as const,
    leaseGeneration: 1,
    sequence: 0,
  },
  transport: {
    kind: "webrtc-sdp-v1" as const,
    signalingPath: `/api/voice/sessions/${SESSION_ID}/webrtc-offer`,
  },
  expiresAt: "2026-07-10T22:00:00.000Z" as never,
  heartbeatIntervalSeconds: 10,
};

const makeHarness = () => {
  const listeners = new Map<string, (event: never) => void>();
  const native = {
    getMicrophonePermissionAsync: vi.fn(async () => ({ granted: true })),
    requestMicrophonePermissionAsync: vi.fn(),
    prepareRealtimeSessionAsync: vi.fn(async () => ({
      nativeSessionId: SESSION_ID,
      sdp: "local-offer",
    })),
    applyRealtimeAnswerAsync: vi.fn(async () => undefined),
    stopRealtimeSessionAsync: vi.fn(async () => true),
    setRealtimeMutedAsync: vi.fn(async () => undefined),
    getAudioRoutesAsync: vi.fn(async () => []),
    setAudioRouteAsync: vi.fn(async () => []),
    addListener: vi.fn((name: string, listener: (event: never) => void) => {
      listeners.set(name, listener);
      return { remove: vi.fn() };
    }),
  } as unknown as T3VoiceNativeModule;
  const client = {
    createSession: vi.fn(() => Effect.succeed(serverSession)),
    offerSession: vi.fn(() =>
      Effect.succeed({
        sessionId: SESSION_ID,
        leaseGeneration: 1,
        sdp: "remote-answer",
      }),
    ),
    closeSession: vi.fn(() =>
      Effect.succeed({ state: { ...serverSession.state, phase: "ended" as const }, closed: true }),
    ),
    heartbeatSession: vi.fn(() => Effect.succeed(serverSession.state)),
    sessionEvents: vi.fn(() => Effect.succeed({ state: serverSession.state, events: [] })),
  } as unknown as VoiceHttpClient;
  const snapshots: Array<string> = [];
  const scheduler = { setInterval: vi.fn(() => Symbol()), clearInterval: vi.fn() };
  const controller = new RealtimeVoiceController(
    native,
    client,
    { onSnapshot: (snapshot) => snapshots.push(snapshot.phase) },
    { scheduler },
  );
  return { client, controller, native, scheduler, snapshots };
};

describe("RealtimeVoiceController", () => {
  it("signals an ICE-complete native offer through the authenticated server", async () => {
    const { client, controller, native, snapshots } = makeHarness();

    await controller.start(createInput);

    expect(client.createSession).toHaveBeenCalledWith(createInput);
    expect(native.prepareRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(client.offerSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      leaseGeneration: 1,
      sdp: "local-offer",
    });
    expect(native.applyRealtimeAnswerAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
      sdp: "remote-answer",
    });
    expect(controller.getSnapshot().phase).toBe("active");
    expect(snapshots).toContain("starting");
    expect(snapshots).toContain("active");
  });

  it("closes both native and server sessions when signaling fails", async () => {
    const { client, controller, native } = makeHarness();
    vi.mocked(client.offerSession).mockReturnValue(Effect.die(new Error("signaling failed")));

    await expect(controller.start(createInput)).rejects.toThrow("signaling failed");

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(client.closeSession).toHaveBeenCalledWith(SESSION_ID, 1);
    expect(controller.getSnapshot().phase).toBe("error");
  });

  it("stops native media and closes the server lease", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);

    await controller.stop();

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(client.closeSession).toHaveBeenCalledWith(SESSION_ID, 1);
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", session: null });
  });

  it("closes both sides after repeated control failures", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(client.sessionEvents).mockReturnValue(Effect.die(new Error("offline")));

    await controller.refreshEvents();
    await controller.refreshEvents();
    await controller.refreshEvents();
    await Promise.resolve();

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(client.closeSession).toHaveBeenCalledWith(SESSION_ID, 1);
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: expect.any(String) });
  });
});

import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import {
  ProjectId,
  ThreadId,
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
  const listeners = new Map<string, (event: unknown) => void>();
  const native = {
    getMicrophonePermissionAsync: vi.fn(async () => ({ granted: true })),
    requestMicrophonePermissionAsync: vi.fn(),
    getStateAsync: vi.fn(async () => ({
      phase: "realtime" as const,
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connecting" as const,
      realtimeMuted: false,
      sequence: 1,
    })),
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
      listeners.set(name, (event) => listener(event as never));
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
    updateSessionFocus: vi.fn(() =>
      Effect.succeed({
        state: { ...serverSession.state, sequence: 1 },
        projectId: ProjectId.make("project-2"),
        threadId: ThreadId.make("thread-2"),
      }),
    ),
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
  const emitNative = (name: string, event: unknown) => {
    const listener = listeners.get(name);
    if (listener === undefined) throw new Error(`Missing native listener: ${name}`);
    listener(event);
  };
  return { client, controller, emitNative, native, scheduler, snapshots };
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
    expect(controller.getSnapshot().native).toMatchObject({
      activeRealtimeSessionId: SESSION_ID,
      sequence: 1,
    });
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

  it("rejects startup when native media terminates after accepting the answer", async () => {
    const { client, controller, native } = makeHarness();
    vi.mocked(native.getStateAsync).mockResolvedValueOnce({
      phase: "idle",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: null,
      realtimeConnectionState: "failed",
      realtimeMuted: false,
      sequence: 2,
    });

    await expect(controller.start(createInput)).rejects.toThrow(
      "The Realtime media session ended during startup",
    );

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

  it("updates focus through the active lease without replacing native media", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    const projectId = ProjectId.make("project-2");
    const threadId = ThreadId.make("thread-2");

    await controller.updateFocus(projectId, threadId);

    expect(client.updateSessionFocus).toHaveBeenCalledWith(SESSION_ID, 1, {
      projectId,
      threadId,
    });
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session?.sequence).toBe(1);
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

  it("identifies invalid event payloads separately from connectivity failures", async () => {
    const { client, controller } = makeHarness();
    await controller.start(createInput);
    const invalidResponse = Object.assign(new Error("invalid response"), {
      _tag: "RemoteEnvironmentAuthInvalidJsonError",
    });
    vi.mocked(client.sessionEvents).mockReturnValue(Effect.fail(invalidResponse as never));

    await controller.refreshEvents();
    await controller.refreshEvents();
    await controller.refreshEvents();

    expect(controller.getSnapshot().error).toContain(
      "Realtime event stream returned an invalid response",
    );
  });

  it("ignores aggregate and stale native terminal events that do not own the active session", async () => {
    const { client, controller, emitNative, native } = makeHarness();
    await controller.start(createInput);

    emitNative("stateChanged", {
      phase: "idle",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: null,
      realtimeConnectionState: "failed",
      realtimeMuted: false,
      sequence: 2,
    });
    emitNative("realtimeTerminated", {
      nativeSessionId: "an-older-session",
      outcome: "failed",
      code: "realtime-connection-failed",
      retryable: true,
    });
    await Promise.resolve();

    expect(controller.getSnapshot().phase).toBe("active");
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
  });

  it("rejects stale or foreign native state after startup reconciliation", async () => {
    const { controller, emitNative } = makeHarness();
    await controller.start(createInput);

    emitNative("stateChanged", {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: true,
      sequence: 0,
    });
    emitNative("stateChanged", {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: "an-older-session",
      realtimeConnectionState: "connected",
      realtimeMuted: true,
      sequence: 3,
    });

    expect(controller.getSnapshot().native).toMatchObject({
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connecting",
      realtimeMuted: false,
      sequence: 1,
    });
  });

  it("preserves a safe native failure reason and closes the server lease once", async () => {
    const { client, controller, emitNative } = makeHarness();
    await controller.start(createInput);

    emitNative("realtimeTerminated", {
      nativeSessionId: SESSION_ID,
      outcome: "failed",
      code: "realtime-ice-timeout",
      retryable: true,
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        phase: "error",
        error: "The Realtime connection timed out",
      });
    });
    expect(client.closeSession).toHaveBeenCalledTimes(1);
  });

  it("does not surface raw native diagnostic payloads", async () => {
    const { controller, emitNative } = makeHarness();
    await controller.start(createInput);

    emitNative("runtimeError", {
      operation: `realtime:${SESSION_ID}`,
      code: "data-channel-error",
      message: "private provider payload",
      recoverable: true,
    });

    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      error: "The Realtime media connection reported an error",
    });
  });

  it("preserves the latest server error while cleaning native media", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(client.sessionEvents).mockReturnValueOnce(
      Effect.succeed({
        state: { ...serverSession.state, phase: "listening" as const, sequence: 2 },
        events: [
          {
            sessionId: SESSION_ID,
            leaseGeneration: 1,
            sequence: 2,
            occurredAt: "2026-07-10T22:01:00.000Z" as never,
            type: "error" as const,
            reason: "The provider connection was interrupted",
            recoverable: false,
          },
        ],
      }),
    );
    vi.mocked(client.sessionEvents).mockReturnValueOnce(
      Effect.succeed({
        state: { ...serverSession.state, phase: "error" as const, sequence: 3 },
        events: [],
      }),
    );

    await controller.refreshEvents();
    expect(controller.getSnapshot().phase).toBe("active");
    await controller.refreshEvents();

    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: "The provider connection was interrupted",
    });
    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(client.closeSession).not.toHaveBeenCalled();
  });

  it("returns to idle on graceful server termination without closing the server twice", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(client.sessionEvents).mockReturnValue(
      Effect.succeed({
        state: { ...serverSession.state, phase: "ended" as const, sequence: 1 },
        events: [],
      }),
    );

    await controller.refreshEvents();

    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", session: null, error: null });
    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledTimes(1);
    expect(client.closeSession).not.toHaveBeenCalled();
  });

  it("coalesces duplicate native terminal events during asynchronous cleanup", async () => {
    const { client, controller, emitNative } = makeHarness();
    await controller.start(createInput);
    const terminalEvent = {
      nativeSessionId: SESSION_ID,
      outcome: "failed",
      code: "realtime-connection-failed",
      retryable: true,
    };

    emitNative("realtimeTerminated", terminalEvent);
    emitNative("realtimeTerminated", terminalEvent);

    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("error"));
    expect(client.closeSession).toHaveBeenCalledTimes(1);
  });

  it("does not let an old native-terminal cleanup overwrite a restarted call", async () => {
    const { client, controller, emitNative } = makeHarness();
    let resolveClose!: () => void;
    const pendingClose = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    vi.mocked(client.closeSession).mockReturnValue(
      Effect.promise(async () => {
        await pendingClose;
        return {
          state: { ...serverSession.state, phase: "ended" as const },
          closed: true,
        };
      }),
    );
    await controller.start(createInput);

    emitNative("realtimeTerminated", {
      nativeSessionId: SESSION_ID,
      outcome: "failed",
      code: "realtime-connection-failed",
      retryable: true,
    });
    expect(controller.getSnapshot().phase).toBe("error");

    await controller.start(createInput);
    resolveClose();
    await Promise.resolve();

    expect(controller.getSnapshot().phase).toBe("active");
  });

  it("lets one terminal owner win when native and server termination race", async () => {
    const { client, controller, emitNative, native } = makeHarness();
    await controller.start(createInput);
    let resolveEvents!: (value: {
      state: typeof serverSession.state;
      events: ReadonlyArray<never>;
    }) => void;
    const pendingEvents = new Promise<{
      state: typeof serverSession.state;
      events: ReadonlyArray<never>;
    }>((resolve) => {
      resolveEvents = resolve;
    });
    vi.mocked(client.sessionEvents).mockReturnValue(Effect.promise(() => pendingEvents));

    const refresh = controller.refreshEvents();
    await Promise.resolve();
    emitNative("realtimeTerminated", {
      nativeSessionId: SESSION_ID,
      outcome: "failed",
      code: "realtime-connection-failed",
      retryable: true,
    });
    resolveEvents({ state: serverSession.state, events: [] });
    await refresh;
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("error"));

    expect(client.closeSession).toHaveBeenCalledTimes(1);
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
  });
});

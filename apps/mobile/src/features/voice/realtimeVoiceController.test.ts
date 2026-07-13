import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import {
  EnvironmentAuthInvalidError,
  EnvironmentVoiceOperationError,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  VoiceSessionId,
  type VoiceSessionCreateInput,
} from "@t3tools/contracts";
import type { T3VoiceNativeModule, T3VoiceRuntimeState } from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import type { PermissionResponse } from "expo";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  RealtimeControllerHandoff,
  RealtimeServerCleanupCoordinator,
  RealtimeVoiceController,
  type RealtimeVoiceControllerOptions,
} from "./realtimeVoiceController";
import type {
  RealtimeVoiceAttachmentRecord,
  RealtimeVoiceAttachmentStore,
} from "./realtimeVoiceAttachmentStore";

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
  nativeControlGrant: {
    token: "native-control-token",
    sessionId: SESSION_ID,
    leaseGeneration: 1,
    expiresAt: "2026-07-10T22:00:00.000Z" as never,
    heartbeatIntervalSeconds: 8,
    failureGraceSeconds: 30,
  },
};

const makeAttachmentStore = (initial: RealtimeVoiceAttachmentRecord | null = null) => {
  let record = initial;
  return {
    store: {
      load: vi.fn(async () => record),
      replace: vi.fn(async (next) => {
        record = next;
      }),
      update: vi.fn(async (next) => {
        const current = record;
        if (
          current !== null &&
          (current.sessionId !== next.sessionId || current.ownerId !== next.ownerId)
        )
          return false;
        record = next;
        return true;
      }),
      clear: vi.fn(async (sessionId, ownerId) => {
        const current = record;
        if (current === null || current.sessionId !== sessionId || current.ownerId !== ownerId)
          return false;
        record = null;
        return true;
      }),
    } satisfies RealtimeVoiceAttachmentStore,
    current: () => record,
  };
};

const makeHarness = (options: RealtimeVoiceControllerOptions = {}) => {
  const listeners = new Map<string, (event: unknown) => void>();
  const subscriptionRemovals: Array<ReturnType<typeof vi.fn>> = [];
  let nativeState: T3VoiceRuntimeState = {
    phase: "idle" as const,
    isForeground: false,
    activeRecordingId: null,
    activePlaybackId: null,
    activeRealtimeSessionId: null,
    realtimeConnectionState: null,
    realtimeMuted: false,
    realtimeInputReady: false,
    sequence: 0,
  };
  const native = {
    getMicrophonePermissionAsync: vi.fn(async () => ({ granted: true })),
    requestMicrophonePermissionAsync: vi.fn(),
    getNotificationPermissionAsync: vi.fn(async () => ({ granted: true })),
    requestNotificationPermissionAsync: vi.fn(async () => ({ granted: true })),
    getStateAsync: vi.fn(async () => nativeState),
    prepareRealtimeSessionAsync: vi.fn(async () => {
      nativeState = {
        ...nativeState,
        phase: "realtime" as const,
        isForeground: true,
        activeRealtimeSessionId: SESSION_ID,
        realtimeConnectionState: "offer-ready" as const,
        realtimeInputReady: false,
        sequence: nativeState.sequence + 1,
      };
      return { nativeSessionId: SESSION_ID, sdp: "local-offer" };
    }),
    applyRealtimeAnswerAsync: vi.fn(async () => {
      nativeState = {
        ...nativeState,
        realtimeConnectionState: "connected" as const,
        realtimeInputReady: true,
        sequence: nativeState.sequence + 1,
      };
      listeners.get("stateChanged")?.(nativeState);
    }),
    stopRealtimeSessionAsync: vi.fn(async () => {
      nativeState = {
        ...nativeState,
        phase: "idle" as const,
        isForeground: false,
        activeRealtimeSessionId: null,
        realtimeConnectionState: "closed" as const,
        realtimeInputReady: false,
        sequence: nativeState.sequence + 1,
      };
      return true;
    }),
    drainAndStopRealtimeSessionAsync: vi.fn(async () => undefined),
    armThreadVoiceHandoffAsync: vi.fn(async () => undefined),
    setRealtimeMutedAsync: vi.fn(async () => undefined),
    getAudioRoutesAsync: vi.fn(async () => []),
    setAudioRouteAsync: vi.fn(async () => []),
    addListener: vi.fn((name: string, listener: (event: never) => void) => {
      listeners.set(name, (event) => listener(event as never));
      const remove = vi.fn();
      subscriptionRemovals.push(remove);
      return { remove };
    }),
  } as unknown as T3VoiceNativeModule;
  const client = {
    createSession: vi.fn(() => Effect.succeed(serverSession)),
    getSession: vi.fn(() => Effect.succeed(serverSession.state)),
    offerSession: vi.fn(() =>
      Effect.succeed({
        sessionId: SESSION_ID,
        leaseGeneration: 1,
        sdp: "remote-answer",
      }),
    ),
    closeSession: vi.fn(() =>
      Effect.succeed({
        state: { ...serverSession.state, phase: "ended" as const },
        closed: true,
      }),
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
    acknowledgeClientAction: vi.fn((_sessionId, actionId) =>
      Effect.succeed({ actionId, outcome: "succeeded" as const }),
    ),
    decideConfirmation: vi.fn((_sessionId, confirmationId) =>
      Effect.succeed({ confirmationId, outcome: "approved" as const }),
    ),
  } as unknown as VoiceHttpClient;
  const snapshots: Array<string> = [];
  const deliveredEvents: Array<ReadonlyArray<unknown>> = [];
  const routeChanges: Array<string> = [];
  const scheduledCallbacks = new Map<number, () => void>();
  const scheduler = {
    setInterval: vi.fn((callback: () => void, delayMs: number) => {
      scheduledCallbacks.set(delayMs, callback);
      return Symbol();
    }),
    clearInterval: vi.fn(),
  };
  const controller = new RealtimeVoiceController(
    native,
    client,
    "https://environment.example.test",
    {
      onSnapshot: (snapshot) => snapshots.push(snapshot.phase),
      onSessionEvents: (events) => deliveredEvents.push(events),
      onAudioRouteChanged: (event) => routeChanges.push(`${event.reason}:${event.routeId}`),
    },
    { scheduler, ...options },
  );
  const emitNative = (name: string, event: unknown) => {
    if (name === "stateChanged") nativeState = event as typeof nativeState;
    if (name === "realtimeTerminated") {
      nativeState = {
        ...nativeState,
        phase: "idle" as const,
        isForeground: false,
        activeRealtimeSessionId: null,
        realtimeConnectionState: "closed" as const,
        sequence: nativeState.sequence + 1,
      };
    }
    const listener = listeners.get(name);
    if (listener === undefined) throw new Error(`Missing native listener: ${name}`);
    listener(event);
  };
  const runScheduled = async (delayMs: number) => {
    const callback = scheduledCallbacks.get(delayMs);
    if (callback === undefined) throw new Error(`Missing scheduled callback for ${delayMs}ms`);
    callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    client,
    controller,
    deliveredEvents,
    emitNative,
    native,
    runScheduled,
    routeChanges,
    scheduler,
    snapshots,
    subscriptionRemovals,
  };
};

describe("RealtimeVoiceController", () => {
  it("forwards sanitized native route fallback events for the active owner", async () => {
    const { controller, emitNative, routeChanges } = makeHarness();
    await controller.start(createInput);

    emitNative("audioRouteChanged", {
      nativeSessionId: SESSION_ID,
      routeId: "system",
      routeType: "system",
      reason: "selected-route-unavailable",
    });
    emitNative("audioRouteChanged", {
      nativeSessionId: "stale-session",
      routeId: "system",
      routeType: "system",
      reason: "selected-route-unavailable",
    });

    expect(routeChanges).toEqual(["selected-route-unavailable:system"]);
  });

  it("adopts a live native session and replays background events from a safe sequence", async () => {
    const { client, controller, native } = makeHarness();
    vi.mocked(native.getStateAsync).mockResolvedValue({
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    });

    await Promise.all([controller.reconcileNativeRuntime(), controller.reconcileNativeRuntime()]);

    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      session: serverSession.state,
      native: { activeRealtimeSessionId: SESSION_ID },
    });
    expect(client.getSession).toHaveBeenCalledWith(SESSION_ID);
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();

    await controller.refreshEvents();
    expect(client.sessionEvents).toHaveBeenCalledWith(SESSION_ID, 0);
  });

  it("treats Resume during native adoption as an idempotent active session", async () => {
    const { client, controller, native } = makeHarness();
    vi.mocked(native.getStateAsync).mockResolvedValue({
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    });

    await expect(controller.start(createInput)).resolves.toMatchObject({ phase: "active" });

    expect(client.getSession).toHaveBeenCalledWith(SESSION_ID);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("joins foreground adoption when Resume overlaps the server attachment", async () => {
    const { client, controller, native } = makeHarness();
    const nativeActive = {
      phase: "realtime" as const,
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected" as const,
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    };
    vi.mocked(native.getStateAsync).mockResolvedValue(nativeActive);
    let resolveSession!: (state: typeof serverSession.state) => void;
    vi.mocked(client.getSession).mockReturnValue(
      Effect.promise(
        () =>
          new Promise<typeof serverSession.state>((resolve) => {
            resolveSession = resolve;
          }),
      ),
    );

    const adoption = controller.reconcileNativeRuntime();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("starting"));
    const resume = controller.start(createInput);
    resolveSession(serverSession.state);
    await Promise.all([adoption, resume]);

    expect(controller.getSnapshot().phase).toBe("active");
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("reconciles a missed native stop after returning to the foreground", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(native.getStateAsync).mockResolvedValue({
      phase: "idle",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: null,
      realtimeConnectionState: "closed",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 20,
    });

    await controller.reconcileNativeRuntime();

    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      native: { activeRealtimeSessionId: null },
    });
    await vi.waitFor(() => expect(client.closeSession).toHaveBeenCalledWith(SESSION_ID, 1));
  });

  it("does not create a session when native ownership changes at final adoption", async () => {
    const { client, controller, native } = makeHarness();
    const nativeActive = {
      phase: "realtime" as const,
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected" as const,
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    };
    vi.mocked(native.getStateAsync)
      .mockResolvedValueOnce(nativeActive)
      .mockResolvedValueOnce(nativeActive)
      .mockResolvedValueOnce({
        ...nativeActive,
        activeRealtimeSessionId: "replacement",
        sequence: 9,
      });

    await expect(controller.start(createInput)).rejects.toThrow(
      "The native Realtime session changed during attachment",
    );

    expect(controller.getSnapshot().phase).toBe("error");
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("does not let a stale adoption rejection overwrite a completed stop", async () => {
    const { client, controller, native } = makeHarness();
    const nativeActive = {
      phase: "realtime" as const,
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected" as const,
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    };
    vi.mocked(native.getStateAsync)
      .mockResolvedValueOnce(nativeActive)
      .mockResolvedValue({
        ...nativeActive,
        phase: "idle",
        activeRealtimeSessionId: null,
        realtimeConnectionState: "closed",
        sequence: 9,
      });
    let rejectSession!: (cause: Error) => void;
    vi.mocked(client.getSession).mockReturnValue(
      Effect.promise(
        () =>
          new Promise<typeof serverSession.state>((_resolve, reject) => {
            rejectSession = reject;
          }),
      ),
    );

    const adoption = controller.reconcileNativeRuntime();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("starting"));
    const stopping = controller.stop();
    rejectSession(new Error("late server rejection"));
    await Promise.all([adoption, stopping]);

    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", error: null });
  });

  it("recreates after a crash from the durable consumed cursor and focus", async () => {
    const attachments = makeAttachmentStore({
      ownerId: "previous-owner",
      environmentOrigin: "https://environment.example.test",
      sessionId: SESSION_ID,
      afterSequence: 6,
      focus: {
        projectId: ProjectId.make("project-persisted"),
        threadId: ThreadId.make("thread-persisted"),
      },
      pendingEvents: [],
    });
    const { client, controller, native } = makeHarness({ attachmentStore: attachments.store });
    vi.mocked(native.getStateAsync).mockResolvedValue({
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    });
    vi.mocked(client.getSession).mockReturnValue(
      Effect.succeed({ ...serverSession.state, sequence: 9 }),
    );

    await controller.reconcileNativeRuntime();
    await controller.refreshEvents();

    expect(controller.getSnapshot().focus).toEqual(attachments.current()?.focus);
    expect(client.sessionEvents).toHaveBeenCalledWith(SESSION_ID, 6);
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
  });

  it("does not adopt a cursor from another environment or a future server sequence", async () => {
    for (const record of [
      {
        ownerId: "previous-owner",
        environmentOrigin: "https://other.example.test",
        sessionId: SESSION_ID,
        afterSequence: 3,
        focus: null,
        pendingEvents: [],
      },
      {
        ownerId: "previous-owner",
        environmentOrigin: "https://environment.example.test",
        sessionId: SESSION_ID,
        afterSequence: 99,
        focus: null,
        pendingEvents: [],
      },
    ] satisfies ReadonlyArray<RealtimeVoiceAttachmentRecord>) {
      const attachments = makeAttachmentStore(record);
      const { client, controller, native } = makeHarness({ attachmentStore: attachments.store });
      vi.mocked(native.getStateAsync).mockResolvedValue({
        phase: "realtime",
        isForeground: true,
        activeRecordingId: null,
        activePlaybackId: null,
        activeRealtimeSessionId: SESSION_ID,
        realtimeConnectionState: "connected",
        realtimeMuted: false,
        realtimeInputReady: true,
        sequence: 8,
      });

      await controller.reconcileNativeRuntime();
      await controller.refreshEvents();

      expect(client.sessionEvents).toHaveBeenCalledWith(SESSION_ID, 0);
    }
  });

  it("preserves native media when the server session cannot be authorized", async () => {
    const { client, controller, native } = makeHarness();
    vi.mocked(native.getStateAsync).mockResolvedValueOnce({
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 4,
    });
    vi.mocked(client.getSession).mockReturnValue(Effect.die(new Error("server unavailable")));

    await expect(controller.reconcileNativeRuntime()).rejects.toThrow("server unavailable");

    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().native?.activeRealtimeSessionId).toBe(SESSION_ID);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: expect.stringContaining("Could not attach"),
    });

    await controller.stop();

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({ nativeSessionId: SESSION_ID });
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", session: null });
  });

  it("cleans native media only when the server confirms the session is terminal", async () => {
    const { client, controller, native } = makeHarness();
    const staleNative: T3VoiceRuntimeState = {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 3,
    };
    vi.mocked(native.getStateAsync).mockResolvedValueOnce(staleNative);
    vi.mocked(client.getSession).mockReturnValueOnce(
      Effect.succeed({ ...serverSession.state, phase: "ended" as const }),
    );

    await controller.reconcileNativeRuntime();

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({ nativeSessionId: SESSION_ID });
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      native: { activeRealtimeSessionId: null },
    });
  });

  it("blocks startup when native ownership changes during attachment", async () => {
    const { controller, native } = makeHarness();
    const orphan: T3VoiceRuntimeState = {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 3,
    };
    vi.mocked(native.getStateAsync)
      .mockResolvedValueOnce(orphan)
      .mockResolvedValueOnce({ ...orphan, activeRealtimeSessionId: "replacement", sequence: 4 });

    await expect(controller.start(createInput)).rejects.toThrow(
      "The native Realtime session changed during attachment",
    );
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
  });

  it("signals an ICE-complete native offer through the authenticated server", async () => {
    const { client, controller, native, snapshots } = makeHarness();

    await controller.start(createInput);

    expect(client.createSession).toHaveBeenCalledWith(createInput);
    expect(native.prepareRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
      environmentOrigin: "https://environment.example.test",
      audioRouteId: "system",
      nativeControlGrant: serverSession.nativeControlGrant,
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
      sequence: 2,
    });
    expect(snapshots).toContain("starting");
    expect(snapshots).toContain("active");
  });

  it("remains starting until the connected peer finishes its ready cue", async () => {
    const { controller, emitNative, native } = makeHarness();
    vi.mocked(native.applyRealtimeAnswerAsync).mockResolvedValue(undefined);

    const starting = controller.start(createInput);
    await vi.waitFor(() => expect(native.applyRealtimeAnswerAsync).toHaveBeenCalledOnce());

    emitNative("stateChanged", {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: false,
      sequence: 2,
    });
    expect(controller.getSnapshot().phase).toBe("starting");

    emitNative("stateChanged", {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 3,
    });

    await expect(starting).resolves.toMatchObject({ phase: "active" });
  });

  it("stops native media immediately while the ready cue is pending", async () => {
    const { controller, native } = makeHarness();
    vi.mocked(native.applyRealtimeAnswerAsync).mockResolvedValue(undefined);

    const starting = controller.start(createInput);
    await vi.waitFor(() => expect(native.applyRealtimeAnswerAsync).toHaveBeenCalledOnce());

    await controller.stop();
    await expect(starting).resolves.toBeDefined();
    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({ nativeSessionId: SESSION_ID });
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", session: null });
  });

  it("fails startup immediately when native media terminates during the ready cue", async () => {
    const { controller, emitNative, native } = makeHarness();
    vi.mocked(native.applyRealtimeAnswerAsync).mockResolvedValue(undefined);

    const starting = controller.start(createInput);
    await vi.waitFor(() => expect(native.applyRealtimeAnswerAsync).toHaveBeenCalledOnce());
    emitNative("stateChanged", {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: false,
      sequence: 2,
    });
    await Promise.resolve();
    emitNative("realtimeTerminated", {
      nativeSessionId: SESSION_ID,
      outcome: "failed",
      code: "realtime-connection-failed",
      retryable: true,
    });

    await expect(starting).rejects.toThrow(/failed|ended/i);
    expect(controller.getSnapshot().phase).toBe("error");
  });

  it("fails adoption immediately when native media terminates before input is ready", async () => {
    const { controller, emitNative, native } = makeHarness();
    const connecting: T3VoiceRuntimeState = {
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: false,
      sequence: 8,
    };
    vi.mocked(native.getStateAsync).mockResolvedValue(connecting);

    const adoption = controller.reconcileNativeRuntime();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("starting"));
    await Promise.resolve();
    emitNative("realtimeTerminated", {
      nativeSessionId: SESSION_ID,
      outcome: "failed",
      code: "realtime-connection-failed",
      retryable: true,
    });

    await expect(adoption).rejects.toThrow(/failed|ended/i);
    emitNative("stateChanged", {
      ...connecting,
      phase: "idle",
      isForeground: false,
      activeRealtimeSessionId: null,
      realtimeConnectionState: "closed",
      sequence: 9,
    });
    expect(controller.getSnapshot().native?.activeRealtimeSessionId).toBeNull();
  });

  it("requests notification visibility without making denial block startup", async () => {
    const { controller, native } = makeHarness();
    vi.mocked(native.requestNotificationPermissionAsync).mockResolvedValueOnce({
      granted: false,
      status: "denied" as PermissionResponse["status"],
      expires: "never",
      canAskAgain: true,
    });

    await controller.start(createInput);

    expect(native.requestNotificationPermissionAsync).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("active");
  });

  it("leaves lease heartbeats exclusively with the native runtime", async () => {
    const { client, controller, runScheduled } = makeHarness();
    await controller.start(createInput);

    await runScheduled(1_000);

    expect(client.heartbeatSession).not.toHaveBeenCalled();
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
    vi.mocked(native.getStateAsync)
      .mockResolvedValueOnce({
        phase: "idle",
        isForeground: false,
        activeRecordingId: null,
        activePlaybackId: null,
        activeRealtimeSessionId: null,
        realtimeConnectionState: null,
        realtimeMuted: false,
        realtimeInputReady: true,
        sequence: 0,
      })
      .mockResolvedValueOnce({
        phase: "idle",
        isForeground: true,
        activeRecordingId: null,
        activePlaybackId: null,
        activeRealtimeSessionId: null,
        realtimeConnectionState: "failed",
        realtimeMuted: false,
        realtimeInputReady: true,
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
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      session: null,
    });
  });

  it("detaches React observers while preserving an established native session", async () => {
    const { client, controller, native, scheduler, subscriptionRemovals } = makeHarness();
    await controller.start(createInput);
    vi.mocked(native.stopRealtimeSessionAsync).mockClear();
    vi.mocked(client.closeSession).mockClear();

    await controller.detach();

    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      session: serverSession.state,
      native: { activeRealtimeSessionId: SESSION_ID },
    });
    expect(scheduler.clearInterval).toHaveBeenCalledTimes(1);
    expect(subscriptionRemovals).toHaveLength(4);
    expect(subscriptionRemovals.every((remove) => remove.mock.calls.length === 1)).toBe(true);
  });

  it("fences an attachment that completes after React detaches", async () => {
    const { client, controller, native, scheduler } = makeHarness();
    const nativeActive = {
      phase: "realtime" as const,
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected" as const,
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    };
    vi.mocked(native.getStateAsync).mockResolvedValue(nativeActive);
    let resolveSession!: (state: typeof serverSession.state) => void;
    const pendingSession = new Promise<typeof serverSession.state>((resolve) => {
      resolveSession = resolve;
    });
    vi.mocked(client.getSession).mockReturnValue(Effect.promise(() => pendingSession));

    const reconciliation = controller.reconcileNativeRuntime();
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledTimes(1));
    expect(controller.getSnapshot()).toMatchObject({
      phase: "starting",
      native: { activeRealtimeSessionId: SESSION_ID },
    });
    const detachment = controller.detach();
    resolveSession(serverSession.state);
    await Promise.all([reconciliation, detachment]);

    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", session: null });
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(scheduler.setInterval).not.toHaveBeenCalled();
  });

  it("does not publish active or restart timers when stop wins a delayed attachment write", async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const attachments = makeAttachmentStore();
    vi.mocked(attachments.store.replace).mockImplementationOnce(async () => {
      await writeBlocked;
    });
    const { controller, scheduler, snapshots } = makeHarness({
      attachmentStore: attachments.store,
    });

    const starting = controller.start(createInput);
    await vi.waitFor(() => expect(attachments.store.replace).toHaveBeenCalledOnce());
    const stopping = controller.stop();
    releaseWrite();
    await Promise.all([starting, stopping]);

    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", focus: null });
    expect(snapshots.slice(snapshots.indexOf("stopping"))).not.toContain("active");
    expect(scheduler.setInterval).not.toHaveBeenCalled();
  });

  it("does not resurrect an attachment when stop wins a retry race", async () => {
    const { client, controller, emitNative, native, scheduler } = makeHarness();
    const nativeActive = {
      phase: "realtime" as const,
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected" as const,
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    };
    emitNative("stateChanged", nativeActive);
    let resolveSession!: (state: typeof serverSession.state) => void;
    const pendingSession = new Promise<typeof serverSession.state>((resolve) => {
      resolveSession = resolve;
    });
    vi.mocked(client.getSession).mockReturnValue(Effect.promise(() => pendingSession));

    const reconciliation = controller.reconcileNativeRuntime();
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledOnce());
    const stopping = controller.stop();
    resolveSession(serverSession.state);
    await Promise.all([reconciliation, stopping]);

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({ nativeSessionId: SESSION_ID });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      session: null,
      native: { activeRealtimeSessionId: null },
    });
    expect(scheduler.setInterval).not.toHaveBeenCalled();
    await expect(controller.setMuted(true)).rejects.toThrow("No Realtime voice session is active");
  });

  it("keeps dispose destructive after a prior detach", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    await controller.detach();

    await controller.dispose();

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(client.closeSession).toHaveBeenCalledWith(SESSION_ID, 1);
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("reports idle after native release while preserving server cleanup as a reconnect barrier", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    let resolveClose!: () => void;
    const pendingClose = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    vi.mocked(client.closeSession).mockReturnValueOnce(
      Effect.promise(async () => {
        await pendingClose;
        return {
          state: { ...serverSession.state, phase: "ended" as const },
          closed: true,
        };
      }),
    );
    vi.mocked(client.createSession).mockClear();

    await controller.stop();

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(controller.getSnapshot().phase).toBe("idle");
    const restart = controller.start(createInput);
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("starting"));
    expect(controller.getSnapshot().phase).toBe("starting");
    expect(client.createSession).not.toHaveBeenCalled();

    resolveClose();
    await restart;
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("active");
  });

  it("retries a bounded server cleanup before reconnecting", async () => {
    const { client, controller } = makeHarness({ serverCleanupTimeoutMs: 5 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await controller.start(createInput);
    vi.mocked(client.closeSession).mockReturnValueOnce(Effect.never);

    await controller.stop();
    await controller.start(createInput);

    expect(controller.getSnapshot().phase).toBe("active");
    expect(client.closeSession).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      "[voice] server session cleanup failed",
      expect.objectContaining({ errorTag: "TimeoutError" }),
    );
    warning.mockRestore();
  });

  it("does not create a competing lease while prior cleanup remains unreachable", async () => {
    const { client, controller } = makeHarness({ serverCleanupTimeoutMs: 5 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await controller.start(createInput);
    vi.mocked(client.closeSession).mockReturnValue(Effect.never);

    await controller.stop();
    await expect(controller.start(createInput)).rejects.toThrow(
      "The previous Realtime session could not be released",
    );

    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.closeSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      session: null,
      error: expect.stringContaining("Check connectivity and try again"),
    });
    warning.mockRestore();
  });

  it("carries unresolved cleanup across controller replacement", async () => {
    const cleanupCoordinator = new RealtimeServerCleanupCoordinator(5);
    const { client, controller, native } = makeHarness({ cleanupCoordinator });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await controller.start(createInput);
    vi.mocked(client.closeSession).mockReturnValueOnce(Effect.never);

    await controller.stop();
    await controller.dispose();

    const replacementClose = vi.fn(() =>
      Effect.succeed({
        state: { ...serverSession.state, phase: "ended" as const },
        closed: true,
      }),
    );
    const replacementCreate = vi.fn(() => Effect.succeed(serverSession));
    const replacementClient = {
      ...client,
      closeSession: replacementClose,
      createSession: replacementCreate,
    } as unknown as VoiceHttpClient;
    const replacement = new RealtimeVoiceController(
      native,
      replacementClient,
      "https://environment.example.test",
      { onSnapshot: () => undefined },
      { cleanupCoordinator },
    );
    await replacement.start(createInput);

    expect(client.closeSession).toHaveBeenCalledTimes(2);
    expect(replacementClose).not.toHaveBeenCalled();
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(replacementCreate).toHaveBeenCalledTimes(1);
    expect(replacement.getSnapshot().phase).toBe("active");
    warning.mockRestore();
  });

  it("holds replacement readiness until the prior controller is disposed", async () => {
    const handoff = new RealtimeControllerHandoff();
    const active = handoff.reserve();
    const replacement = handoff.reserve();
    let ready = false;
    const replacementReady = replacement.ready.then(() => {
      ready = true;
    });

    await Promise.resolve();
    expect(ready).toBe(false);
    active.release();
    await replacementReady;
    expect(ready).toBe(true);
    replacement.release();
  });

  it("retires cleanup owned by a revoked authentication session", async () => {
    const cleanupCoordinator = new RealtimeServerCleanupCoordinator(5);
    const { client, controller } = makeHarness({ cleanupCoordinator });
    vi.mocked(client.closeSession).mockReturnValue(
      Effect.fail(
        new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason: "invalid_credential",
          traceId: "trace-auth-invalid",
        }),
      ),
    );
    await controller.start(createInput);

    await controller.stop();
    await controller.dispose();
    vi.mocked(client.createSession).mockClear();
    await controller.start(createInput);

    expect(client.closeSession).toHaveBeenCalledTimes(1);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("active");
  });

  it("retires a non-retryable voice cleanup error", async () => {
    const cleanupCoordinator = new RealtimeServerCleanupCoordinator(5);
    const { client, controller } = makeHarness({ cleanupCoordinator });
    vi.mocked(client.closeSession).mockReturnValue(
      Effect.fail(
        new EnvironmentVoiceOperationError({
          code: "voice_operation_failed",
          reason: "invalid-phase",
          message: "The cleanup cannot be retried.",
          retryable: false,
          traceId: "trace-cleanup-terminal",
        }),
      ),
    );
    await controller.start(createInput);

    await controller.stop();
    await controller.start(createInput);

    expect(client.closeSession).toHaveBeenCalledTimes(1);
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe("active");
  });

  it("keeps a retryable voice cleanup error blocking until the server watchdog bound", async () => {
    let now = 1_000;
    const cleanupCoordinator = new RealtimeServerCleanupCoordinator(5, () => now);
    const { client, controller } = makeHarness({ cleanupCoordinator });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(client.closeSession).mockReturnValue(
      Effect.fail(
        new EnvironmentVoiceOperationError({
          code: "voice_operation_failed",
          reason: "provider-unavailable",
          message: "The cleanup can be retried.",
          retryable: true,
          traceId: "trace-cleanup-retryable",
        }),
      ),
    );
    await controller.start(createInput);

    await controller.stop();
    await expect(controller.start(createInput)).rejects.toThrow(
      "The previous Realtime session could not be released",
    );
    now += 40_000;
    await controller.start(createInput);

    expect(client.closeSession).toHaveBeenCalledTimes(2);
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe("active");
    warning.mockRestore();
  });

  it("joins and cleans a startup interrupted before signaling completes", async () => {
    const { client, controller, native } = makeHarness();
    let resolveOffer!: () => void;
    const pendingOffer = new Promise<void>((resolve) => {
      resolveOffer = resolve;
    });
    vi.mocked(client.offerSession).mockReturnValueOnce(
      Effect.promise(async () => {
        await pendingOffer;
        return {
          sessionId: SESSION_ID,
          leaseGeneration: 1,
          sdp: "remote-answer",
        };
      }),
    );
    const start = controller.start(createInput);
    await vi.waitFor(() => expect(client.offerSession).toHaveBeenCalledTimes(1));

    const stop = controller.stop();
    resolveOffer();
    await Promise.all([start, stop]);

    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(client.closeSession).toHaveBeenCalledWith(SESSION_ID, 1);
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("cancels startup when disposed during initial native reconciliation", async () => {
    const { client, controller, native } = makeHarness();
    let resolveReconciliation!: (state: T3VoiceRuntimeState) => void;
    const reconciliation = new Promise<T3VoiceRuntimeState>((resolve) => {
      resolveReconciliation = resolve;
    });
    vi.mocked(native.getStateAsync).mockReturnValueOnce(reconciliation);

    const start = controller.start(createInput);
    const dispose = controller.dispose();
    resolveReconciliation({
      phase: "idle",
      isForeground: false,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: null,
      realtimeConnectionState: null,
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 0,
    });
    await Promise.allSettled([start, dispose]);

    expect(client.createSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("does not report idle when explicit stop leaves native media active", async () => {
    const { controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(native.stopRealtimeSessionAsync).mockResolvedValueOnce(false);

    await controller.stop();

    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: "The Realtime media session could not be stopped",
    });
  });

  it("does not report idle when server termination cleanup leaves native media active", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(native.stopRealtimeSessionAsync).mockResolvedValueOnce(false);
    vi.mocked(client.sessionEvents).mockReturnValue(
      Effect.succeed({
        state: { ...serverSession.state, phase: "ended" as const },
        events: [],
      }),
    );

    await controller.refreshEvents();

    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: "The Realtime media session could not be stopped",
    });
  });

  it("updates focus through the active lease without replacing native media", async () => {
    const attachments = makeAttachmentStore();
    const { client, controller, native } = makeHarness({ attachmentStore: attachments.store });
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
    expect(controller.getSnapshot().focus).toEqual({ projectId, threadId });
    expect(attachments.current()?.focus).toEqual({ projectId, threadId });
  });

  it("persists the consumed cursor after delivering a server event", async () => {
    const attachments = makeAttachmentStore();
    const { client, controller } = makeHarness({ attachmentStore: attachments.store });
    await controller.start(createInput);
    vi.mocked(client.sessionEvents).mockReturnValueOnce(
      Effect.succeed({
        state: { ...serverSession.state, phase: "listening" as const, sequence: 4 },
        events: [
          {
            sessionId: SESSION_ID,
            leaseGeneration: 1,
            sequence: 4,
            occurredAt: "2026-07-10T22:01:00.000Z" as never,
            type: "state" as const,
            phase: "listening" as const,
          },
        ],
      }),
    );

    await controller.refreshEvents();
    await controller.detach();

    expect(attachments.current()).toMatchObject({
      environmentOrigin: "https://environment.example.test",
      sessionId: SESSION_ID,
      afterSequence: 4,
    });
  });

  it("replays a durably pending client action after a crash past the event cursor", async () => {
    const attachments = makeAttachmentStore();
    const first = makeHarness({
      attachmentStore: attachments.store,
      attachmentOwnerIdFactory: () => "first-owner",
    });
    await first.controller.start(createInput);
    const action = {
      sessionId: SESSION_ID,
      leaseGeneration: 1,
      sequence: 4,
      occurredAt: "2026-07-13T04:00:00.000Z" as never,
      type: "client-action" as const,
      action: "activate-thread" as const,
      actionId: "action-1" as never,
      projectId: ProjectId.make("project-2"),
      threadId: ThreadId.make("thread-2"),
      expiresAt: "2099-07-13T04:01:00.000Z" as never,
    };
    vi.mocked(first.client.sessionEvents).mockReturnValueOnce(
      Effect.succeed({
        state: { ...serverSession.state, sequence: 4 },
        events: [action],
      }),
    );

    await first.controller.refreshEvents();
    await first.controller.detach();

    expect(attachments.current()).toMatchObject({
      afterSequence: 4,
      pendingEvents: [action],
    });

    const second = makeHarness({
      attachmentStore: attachments.store,
      attachmentOwnerIdFactory: () => "second-owner",
    });
    vi.mocked(second.native.getStateAsync).mockResolvedValue({
      phase: "realtime",
      isForeground: true,
      activeRecordingId: null,
      activePlaybackId: null,
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 8,
    });
    vi.mocked(second.client.getSession).mockReturnValue(
      Effect.succeed({ ...serverSession.state, sequence: 4 }),
    );
    vi.mocked(second.client.sessionEvents).mockReturnValue(
      Effect.succeed({ state: { ...serverSession.state, sequence: 4 }, events: [] }),
    );

    await second.controller.reconcileNativeRuntime();
    await second.controller.refreshEvents();

    expect(second.client.sessionEvents).toHaveBeenCalledWith(SESSION_ID, 4);
    expect(second.deliveredEvents.at(-1)).toEqual([action]);
    await second.controller.acknowledgeClientAction(action.actionId, {
      action: "activate-thread",
      outcome: "succeeded",
    });
    expect(attachments.current()?.pendingEvents).toEqual([]);
  });

  it("keeps a confirmation durable until the server accepts the decision", async () => {
    const attachments = makeAttachmentStore();
    const { client, controller } = makeHarness({ attachmentStore: attachments.store });
    await controller.start(createInput);
    const confirmation = {
      sessionId: SESSION_ID,
      leaseGeneration: 1,
      sequence: 5,
      occurredAt: "2026-07-13T04:00:00.000Z" as never,
      type: "confirmation-required" as const,
      confirmationId: "confirmation-1" as never,
      toolCallId: "tool-call-1" as never,
      tool: "archive_thread" as const,
      summary: "Archive a thread",
      expiresAt: "2099-07-13T04:01:00.000Z" as never,
    };
    vi.mocked(client.sessionEvents).mockReturnValueOnce(
      Effect.succeed({
        state: { ...serverSession.state, sequence: 5 },
        events: [confirmation],
      }),
    );

    await controller.refreshEvents();
    expect(attachments.current()?.pendingEvents).toEqual([confirmation]);

    await controller.decideConfirmation(confirmation.confirmationId, "approve");
    expect(attachments.current()?.pendingEvents).toEqual([]);
  });

  it("advances locally, heals persistence, and suppresses replayed events after a failed replace", async () => {
    const attachments = makeAttachmentStore();
    vi.mocked(attachments.store.replace).mockRejectedValueOnce(new Error("secure store busy"));
    const { client, controller, deliveredEvents } = makeHarness({
      attachmentStore: attachments.store,
    });
    await controller.start(createInput);
    const transcript = {
      sessionId: SESSION_ID,
      leaseGeneration: 1,
      sequence: 4,
      occurredAt: "2026-07-13T04:00:00.000Z" as never,
      type: "transcript" as const,
      role: "assistant" as const,
      text: "Persist once",
      final: true,
    };
    const confirmation = {
      sessionId: SESSION_ID,
      leaseGeneration: 1,
      sequence: 5,
      occurredAt: "2026-07-13T04:00:01.000Z" as never,
      type: "confirmation-required" as const,
      confirmationId: "confirmation-heal" as never,
      toolCallId: "tool-call-heal" as never,
      tool: "archive_thread" as const,
      summary: "Archive a thread",
      expiresAt: "2099-07-13T04:01:00.000Z" as never,
    };
    const result = Effect.succeed({
      state: { ...serverSession.state, sequence: 5 },
      events: [transcript, confirmation],
    });
    vi.mocked(client.sessionEvents).mockReturnValue(result);

    await controller.refreshEvents();
    await controller.refreshEvents();

    expect(client.sessionEvents).toHaveBeenNthCalledWith(1, SESSION_ID, 0);
    expect(client.sessionEvents).toHaveBeenNthCalledWith(2, SESSION_ID, 5);
    expect(deliveredEvents).toEqual([[transcript, confirmation]]);
    expect(attachments.current()).toMatchObject({
      afterSequence: 5,
      pendingEvents: [confirmation],
    });
  });

  it("clears focus after a normal stop", async () => {
    const { controller } = makeHarness();
    await controller.start({
      ...createInput,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await controller.stop();

    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", focus: null });
  });

  it("closes both sides after repeated control failures", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(client.sessionEvents).mockReturnValue(Effect.die(new Error("offline")));

    await controller.refreshEvents();
    await controller.refreshEvents();
    await controller.refreshEvents();

    await vi.waitFor(() => {
      expect(native.stopRealtimeSessionAsync).toHaveBeenCalledWith({
        nativeSessionId: SESSION_ID,
      });
      expect(client.closeSession).toHaveBeenCalledWith(SESSION_ID, 1);
      expect(controller.getSnapshot()).toMatchObject({
        phase: "error",
        error: expect.any(String),
      });
    });
  });

  it("reports retained native media after repeated control failures", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(client.sessionEvents).mockReturnValue(Effect.die(new Error("offline")));
    vi.mocked(native.stopRealtimeSessionAsync).mockResolvedValueOnce(false);

    await controller.refreshEvents();
    await controller.refreshEvents();
    await controller.refreshEvents();

    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        phase: "error",
        error: expect.stringContaining("could not be stopped"),
        native: { activeRealtimeSessionId: SESSION_ID },
      });
    });
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

    await vi.waitFor(() => {
      expect(controller.getSnapshot().error).toContain(
        "Realtime event stream returned an invalid response",
      );
    });
  });

  it("keeps event polling single-flight", async () => {
    const { client, controller } = makeHarness();
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

    const first = controller.refreshEvents();
    await controller.refreshEvents();

    expect(client.sessionEvents).toHaveBeenCalledTimes(1);
    resolveEvents({ state: serverSession.state, events: [] });
    await first;
    await controller.refreshEvents();
    expect(client.sessionEvents).toHaveBeenCalledTimes(2);
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
      realtimeInputReady: true,
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
      realtimeInputReady: true,
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
      realtimeInputReady: true,
      sequence: 3,
    });

    expect(controller.getSnapshot().native).toMatchObject({
      activeRealtimeSessionId: SESSION_ID,
      realtimeConnectionState: "connected",
      realtimeMuted: false,
      realtimeInputReady: true,
      sequence: 2,
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

  it("offers resume after transient native control loss", async () => {
    const { controller, emitNative } = makeHarness();
    await controller.start(createInput);

    emitNative("realtimeTerminated", {
      nativeSessionId: SESSION_ID,
      outcome: "failed",
      code: "native-control-lost",
      retryable: true,
    });

    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: "The Realtime control connection was lost. Resume to reconnect",
    });
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
        state: {
          ...serverSession.state,
          phase: "listening" as const,
          sequence: 2,
        },
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

    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      session: null,
      error: null,
    });
    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledTimes(1);
    expect(client.closeSession).not.toHaveBeenCalled();
  });

  it("arms native handoff ownership before stopping terminal Realtime media", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    const order: string[] = [];
    vi.mocked(native.armThreadVoiceHandoffAsync).mockImplementation(async () => {
      order.push("arm");
    });
    vi.mocked(native.stopRealtimeSessionAsync).mockImplementation(async () => {
      order.push("stop");
      return true;
    });
    vi.mocked(client.sessionEvents).mockReturnValue(
      Effect.succeed({
        state: { ...serverSession.state, phase: "ended" as const, sequence: 1 },
        events: [
          {
            sessionId: SESSION_ID,
            leaseGeneration: 1,
            sequence: 1,
            occurredAt: "2026-07-10T22:01:00.000Z",
            type: "client-action",
            action: "handoff-to-thread-voice",
            actionId: "action-1",
            projectId: "project-1",
            threadId: "thread-1",
            autoRearm: true,
            expiresAt: "2026-07-10T22:01:30.000Z",
          } as never,
        ],
      }),
    );

    await controller.refreshEvents();

    expect(native.armThreadVoiceHandoffAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(order).toEqual(["arm", "stop"]);
  });

  it("requests a local playout drain before cleaning up an agent-requested stop", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    const order: string[] = [];
    vi.mocked(native.drainAndStopRealtimeSessionAsync).mockImplementation(async () => {
      order.push("drain-stop");
    });
    vi.mocked(client.sessionEvents).mockReturnValue(
      Effect.succeed({
        state: { ...serverSession.state, phase: "ended" as const, sequence: 1 },
        events: [
          {
            sessionId: SESSION_ID,
            leaseGeneration: 1,
            sequence: 1,
            occurredAt: "2026-07-10T22:01:00.000Z",
            type: "terminal-action",
            action: "stop-realtime-voice",
          },
        ],
      }),
    );

    await controller.refreshEvents();

    expect(native.drainAndStopRealtimeSessionAsync).toHaveBeenCalledWith({
      nativeSessionId: SESSION_ID,
    });
    expect(order).toEqual(["drain-stop"]);
    expect(native.stopRealtimeSessionAsync).not.toHaveBeenCalled();
  });

  it("still completes terminal cleanup when native handoff arming loses a binder race", async () => {
    const { client, controller, native } = makeHarness();
    await controller.start(createInput);
    vi.mocked(native.armThreadVoiceHandoffAsync).mockRejectedValueOnce(new Error("binder gone"));
    vi.mocked(client.sessionEvents).mockReturnValue(
      Effect.succeed({
        state: { ...serverSession.state, phase: "ended" as const, sequence: 1 },
        events: [
          {
            sessionId: SESSION_ID,
            leaseGeneration: 1,
            sequence: 1,
            occurredAt: "2026-07-10T22:01:00.000Z",
            type: "client-action",
            action: "handoff-to-thread-voice",
            actionId: "action-1",
            projectId: "project-1",
            threadId: "thread-1",
            autoRearm: true,
            expiresAt: "2026-07-10T22:01:30.000Z",
          } as never,
        ],
      }),
    );

    await controller.refreshEvents();

    expect(controller.getSnapshot().phase).toBe("idle");
    expect(native.stopRealtimeSessionAsync).toHaveBeenCalledTimes(1);
    expect(client.sessionEvents).toHaveBeenCalledTimes(1);
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

  it("does not let a restart race old native-terminal server cleanup", async () => {
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

    const restart = controller.start(createInput);
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("starting"));
    expect(client.createSession).toHaveBeenCalledTimes(1);
    resolveClose();
    await restart;

    expect(controller.getSnapshot().phase).toBe("active");
    expect(client.createSession).toHaveBeenCalledTimes(2);
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

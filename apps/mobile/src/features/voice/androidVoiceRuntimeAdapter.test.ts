import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type {
  VoiceHttpClient,
  VoiceRealtimeTarget,
  VoiceRuntimeSnapshot,
  VoiceThreadStartInput,
} from "@t3tools/client-runtime/voice";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceClientActionId,
  VoiceConfirmationId,
} from "@t3tools/contracts";
import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./mobileVoiceClient", () => ({ makeMobileVoiceClient: vi.fn() }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { LOW: 4 },
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

import { makeAndroidVoiceRuntimeAdapter } from "./androidVoiceRuntimeAdapter";

const ENVIRONMENT_ID = EnvironmentId.make("environment-voice");
const PROJECT_ID = ProjectId.make("project-voice");
const THREAD_ID = ThreadId.make("thread-voice");

const prepared: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Voice environment",
  httpBaseUrl: "https://environment.example.test/base-path",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "parent-token" },
  target: new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Voice environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  }),
};

const realtimeTarget: VoiceRealtimeTarget = {
  environmentId: ENVIRONMENT_ID,
  conversation: { type: "new", retention: "durable", title: "Voice" },
  focus: { projectId: PROJECT_ID, threadId: THREAD_ID },
  threadSwitch: null,
};

const threadInput: VoiceThreadStartInput = {
  target: {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  settings: {
    submission: "auto-submit",
    playResponses: true,
    autoRearm: true,
    endpointDetection: {
      endSilenceMs: 900,
      noSpeechTimeoutMs: 8_000,
      maximumUtteranceMs: 60_000,
    },
    rearmDelayMs: 400,
    transcriptionTimeoutMs: 30_000,
    submissionTimeoutMs: 30_000,
    responseTimeoutMs: 120_000,
  },
};

const idleSnapshot = (sequence: number): VoiceRuntimeSnapshot => ({
  mode: "idle",
  generation: 0,
  sequence,
});

const activeRealtimeSnapshot: VoiceRuntimeSnapshot = {
  mode: "realtime",
  phase: "connected",
  generation: 4,
  sequence: 12,
  target: realtimeTarget,
  muted: false,
  audioRoutes: [],
  transcript: [],
  pendingConfirmations: [],
  pendingClientActions: [],
};

const activeThreadSnapshot: VoiceRuntimeSnapshot = {
  mode: "thread",
  phase: "reviewing",
  generation: 5,
  sequence: 18,
  target: threadInput.target,
  settings: threadInput.settings,
  transcript: "Review this transcript",
  reviewId: 3,
  attention: null,
};

const makeHarness = (getSnapshot = async () => idleSnapshot(0)) => {
  let currentPrepared: PreparedConnection | null = prepared;
  let snapshotListener: ((snapshot: VoiceRuntimeSnapshot) => void) | null = null;
  const remove = vi.fn();
  const native = {
    getRuntimeSnapshotAsync: vi.fn(getSnapshot),
    getMicrophonePermissionAsync: vi.fn(async () => ({ granted: true })),
    requestMicrophonePermissionAsync: vi.fn(async () => ({ granted: true })),
    getBluetoothPermissionAsync: vi.fn(async () => ({ granted: true })),
    requestBluetoothPermissionAsync: vi.fn(async () => ({ granted: true })),
    addListener: vi.fn((eventName: string, listener: (snapshot: VoiceRuntimeSnapshot) => void) => {
      expect(eventName).toBe("runtimeSnapshotChanged");
      snapshotListener = listener;
      return { remove };
    }),
    startRealtimeAsync: vi.fn(async () => undefined),
    startThreadAsync: vi.fn(async () => undefined),
    switchRealtimeToThreadAsync: vi.fn(async () => undefined),
    switchThreadToRealtimeAsync: vi.fn(async () => undefined),
    stopRuntimeAsync: vi.fn(async () => undefined),
    setRealtimeMutedAsync: vi.fn(async () => undefined),
    setRealtimeAudioRouteAsync: vi.fn(async () => undefined),
    updateRealtimeContextAsync: vi.fn(async () => undefined),
    decideRealtimeConfirmationAsync: vi.fn(async () => undefined),
    completeRealtimeClientActionAsync: vi.fn(async () => undefined),
    finishThreadRecordingAsync: vi.fn(async () => undefined),
    updateThreadReviewTranscriptAsync: vi.fn(async () => undefined),
    submitThreadTranscriptAsync: vi.fn(async () => undefined),
  } as unknown as T3VoiceNativeModule;
  const createNativeSession = vi.fn(() =>
    Effect.succeed({
      accessToken: "native-child-token",
      expiresAt: "2026-07-17T08:00:00.000Z" as never,
    }),
  );
  const makeClient = vi.fn(
    async () => ({ createNativeSession }) as Pick<VoiceHttpClient, "createNativeSession">,
  );
  const requestNotificationPermission = vi.fn(async (): Promise<"granted" | "denied"> => "granted");
  const adapter = makeAndroidVoiceRuntimeAdapter({
    native,
    environmentId: ENVIRONMENT_ID,
    getPrepared: () => currentPrepared,
    makeClient,
    requestNotificationPermission,
  });
  const emit = (snapshot: VoiceRuntimeSnapshot) => {
    if (snapshotListener === null) throw new Error("Snapshot listener is not attached");
    snapshotListener(snapshot);
  };
  return {
    adapter,
    createNativeSession,
    emit,
    makeClient,
    native,
    remove,
    requestNotificationPermission,
    setPrepared: (next: PreparedConnection | null) => {
      currentPrepared = next;
    },
  };
};

describe("makeAndroidVoiceRuntimeAdapter", () => {
  it("mints child credentials for starts and passes them directly to native", async () => {
    const realtimeHarness = makeHarness();
    const threadHarness = makeHarness();

    await realtimeHarness.adapter.getSnapshot();
    await realtimeHarness.adapter.startRealtime(realtimeTarget);
    await threadHarness.adapter.startThread(threadInput);
    await realtimeHarness.adapter.switchRealtimeToThread(threadInput);

    expect(realtimeHarness.createNativeSession).toHaveBeenCalledOnce();
    expect(threadHarness.createNativeSession).toHaveBeenCalledOnce();
    expect(realtimeHarness.requestNotificationPermission).toHaveBeenCalledOnce();
    expect(threadHarness.requestNotificationPermission).toHaveBeenCalledOnce();
    expect(realtimeHarness.native.startRealtimeAsync).toHaveBeenCalledWith({
      target: realtimeTarget,
      session: {
        baseUrl: "https://environment.example.test/",
        accessToken: "native-child-token",
        expiresAt: "2026-07-17T08:00:00.000Z",
      },
    });
    expect(threadHarness.native.startThreadAsync).toHaveBeenCalledWith({
      input: threadInput,
      session: {
        baseUrl: "https://environment.example.test/",
        accessToken: "native-child-token",
        expiresAt: "2026-07-17T08:00:00.000Z",
      },
    });
    expect(realtimeHarness.native.switchRealtimeToThreadAsync).toHaveBeenCalledWith(threadInput);
  });

  it("mints a fresh child credential for a native Thread-to-Realtime transition", async () => {
    const harness = makeHarness(async () => activeThreadSnapshot);

    await harness.adapter.startRealtime(realtimeTarget);

    expect(harness.createNativeSession).toHaveBeenCalledOnce();
    expect(harness.requestNotificationPermission).toHaveBeenCalledOnce();
    expect(harness.native.switchThreadToRealtimeAsync).toHaveBeenCalledWith({
      target: realtimeTarget,
      session: {
        baseUrl: "https://environment.example.test/",
        accessToken: "native-child-token",
        expiresAt: "2026-07-17T08:00:00.000Z",
      },
    });
  });

  it("selects the current native Realtime admission path after permission prompts", async () => {
    let current: VoiceRuntimeSnapshot = activeThreadSnapshot;
    const harness = makeHarness(async () => current);
    let releaseNotification!: (result: "granted" | "denied") => void;
    harness.requestNotificationPermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNotification = resolve;
        }),
    );

    const starting = harness.adapter.startRealtime(realtimeTarget);
    await vi.waitFor(() => expect(harness.requestNotificationPermission).toHaveBeenCalledOnce());
    current = idleSnapshot(19);
    releaseNotification("granted");

    await expect(starting).resolves.toBeUndefined();
    expect(harness.native.startRealtimeAsync).toHaveBeenCalledOnce();
    expect(harness.native.switchThreadToRealtimeAsync).not.toHaveBeenCalled();
  });

  it("serializes concurrent cross-mode starts and mints only for the Idle winner", async () => {
    let current: VoiceRuntimeSnapshot = idleSnapshot(0);
    const harness = makeHarness(async () => current);
    vi.mocked(harness.native.startRealtimeAsync).mockImplementationOnce(async () => {
      current = {
        mode: "realtime",
        phase: "starting",
        generation: 1,
        sequence: 1,
        target: realtimeTarget,
        muted: false,
        audioRoutes: [],
        transcript: [],
        pendingConfirmations: [],
        pendingClientActions: [],
      };
    });

    const realtimeStart = harness.adapter.startRealtime(realtimeTarget);
    const threadStart = harness.adapter.startThread(threadInput);

    await expect(realtimeStart).resolves.toBeUndefined();
    await expect(threadStart).rejects.toThrow("Native voice runtime is already active");
    expect(harness.createNativeSession).toHaveBeenCalledOnce();
    expect(harness.native.startRealtimeAsync).toHaveBeenCalledOnce();
    expect(harness.native.startThreadAsync).not.toHaveBeenCalled();
  });

  it("rejects a target from another environment before minting", async () => {
    const harness = makeHarness();
    const target = {
      ...realtimeTarget,
      environmentId: EnvironmentId.make("another-environment"),
    };

    await expect(harness.adapter.startRealtime(target)).rejects.toThrow(
      "does not belong to the runtime environment",
    );
    expect(harness.makeClient).not.toHaveBeenCalled();
    expect(harness.requestNotificationPermission).not.toHaveBeenCalled();
    expect(harness.native.getMicrophonePermissionAsync).not.toHaveBeenCalled();
    expect(harness.native.startRealtimeAsync).not.toHaveBeenCalled();
  });

  it("validates nested Realtime Thread context before crossing the bridge", async () => {
    const harness = makeHarness();
    const wrongEnvironment = {
      ...threadInput,
      target: {
        ...threadInput.target,
        environmentId: EnvironmentId.make("another-environment"),
      },
    };
    const wrongFocus = {
      ...threadInput,
      target: {
        ...threadInput.target,
        threadId: ThreadId.make("another-thread"),
      },
    };

    await expect(
      harness.adapter.startRealtime({
        ...realtimeTarget,
        threadSwitch: wrongEnvironment,
      }),
    ).rejects.toThrow("does not belong to the runtime environment");
    await expect(
      harness.adapter.updateRealtimeContext({
        focus: realtimeTarget.focus,
        threadSwitch: wrongFocus,
      }),
    ).rejects.toThrow("does not match the Realtime focus");
    await expect(
      harness.adapter.updateRealtimeContext({
        focus: null,
        threadSwitch: threadInput,
      }),
    ).rejects.toThrow("requires a Realtime focus");
    expect(harness.makeClient).not.toHaveBeenCalled();
    expect(harness.native.startRealtimeAsync).not.toHaveBeenCalled();
    expect(harness.native.updateRealtimeContextAsync).not.toHaveBeenCalled();
  });

  it("requests microphone permission before minting and stops on denial", async () => {
    const harness = makeHarness();
    vi.mocked(harness.native.getMicrophonePermissionAsync).mockResolvedValueOnce({
      granted: false,
    } as never);
    vi.mocked(harness.native.requestMicrophonePermissionAsync).mockResolvedValueOnce({
      granted: false,
    } as never);

    await expect(harness.adapter.startThread(threadInput)).rejects.toThrow(
      "Microphone permission is required",
    );
    expect(harness.native.requestMicrophonePermissionAsync).toHaveBeenCalledOnce();
    expect(harness.requestNotificationPermission).not.toHaveBeenCalled();
    expect(harness.makeClient).not.toHaveBeenCalled();
    expect(harness.native.startThreadAsync).not.toHaveBeenCalled();
  });

  it("requests notification access after microphone admission and before credential minting", async () => {
    const harness = makeHarness();

    await harness.adapter.startThread(threadInput);

    const microphoneOrder = vi.mocked(harness.native.getMicrophonePermissionAsync).mock
      .invocationCallOrder[0];
    const notificationOrder = harness.requestNotificationPermission.mock.invocationCallOrder[0];
    const bluetoothOrder = vi.mocked(harness.native.getBluetoothPermissionAsync).mock
      .invocationCallOrder[0];
    const clientOrder = harness.makeClient.mock.invocationCallOrder[0];
    expect(microphoneOrder).toBeLessThan(notificationOrder ?? 0);
    expect(notificationOrder).toBeLessThan(bluetoothOrder ?? 0);
    expect(bluetoothOrder).toBeLessThan(clientOrder ?? 0);
  });

  it("cancels Realtime admission before credential minting", async () => {
    const harness = makeHarness();
    let releaseNotification!: (result: "granted" | "denied") => void;
    harness.requestNotificationPermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNotification = resolve;
        }),
    );
    const abort = new AbortController();

    const starting = harness.adapter.startRealtime(realtimeTarget, { signal: abort.signal });
    await vi.waitFor(() => expect(harness.requestNotificationPermission).toHaveBeenCalledOnce());
    abort.abort();
    releaseNotification("granted");

    await expect(starting).rejects.toThrow("Voice start was cancelled");
    expect(harness.makeClient).not.toHaveBeenCalled();
    expect(harness.native.startRealtimeAsync).not.toHaveBeenCalled();
  });

  it("revalidates the prepared environment after permission prompts", async () => {
    const harness = makeHarness();
    let releaseNotification!: (result: "granted" | "denied") => void;
    harness.requestNotificationPermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNotification = resolve;
        }),
    );

    const starting = harness.adapter.startRealtime(realtimeTarget);
    await vi.waitFor(() => expect(harness.requestNotificationPermission).toHaveBeenCalledOnce());
    harness.setPrepared(null);
    releaseNotification("granted");

    await expect(starting).rejects.toThrow("A prepared environment connection is required");
    expect(harness.makeClient).not.toHaveBeenCalled();
    expect(harness.native.startRealtimeAsync).not.toHaveBeenCalled();
  });

  it("continues a visible voice start when the user denies drawer notifications", async () => {
    const harness = makeHarness();
    harness.requestNotificationPermission.mockResolvedValueOnce("denied");

    await harness.adapter.startRealtime(realtimeTarget);

    expect(harness.createNativeSession).toHaveBeenCalledOnce();
    expect(harness.native.startRealtimeAsync).toHaveBeenCalledOnce();
  });

  it("continues a visible voice start when notification preflight throws", async () => {
    const harness = makeHarness();
    harness.requestNotificationPermission.mockRejectedValueOnce(
      new Error("notification manager unavailable"),
    );

    await harness.adapter.startRealtime(realtimeTarget);

    expect(harness.createNativeSession).toHaveBeenCalledOnce();
    expect(harness.native.startRealtimeAsync).toHaveBeenCalledOnce();
  });

  it("requests Bluetooth route access without blocking start when the user denies it", async () => {
    const harness = makeHarness();
    vi.mocked(harness.native.getBluetoothPermissionAsync).mockResolvedValueOnce({
      granted: false,
      canAskAgain: true,
    } as never);
    vi.mocked(harness.native.requestBluetoothPermissionAsync).mockResolvedValueOnce({
      granted: false,
      canAskAgain: false,
    } as never);

    await harness.adapter.startThread(threadInput);

    expect(harness.native.requestBluetoothPermissionAsync).toHaveBeenCalledOnce();
    expect(harness.createNativeSession).toHaveBeenCalledOnce();
    expect(harness.native.startThreadAsync).toHaveBeenCalledOnce();
  });

  it("continues voice start when reading Bluetooth permission throws", async () => {
    const harness = makeHarness();
    vi.mocked(harness.native.getBluetoothPermissionAsync).mockRejectedValueOnce(
      new Error("Bluetooth permission manager unavailable"),
    );

    await harness.adapter.startThread(threadInput);

    expect(harness.native.requestBluetoothPermissionAsync).not.toHaveBeenCalled();
    expect(harness.createNativeSession).toHaveBeenCalledOnce();
    expect(harness.native.startThreadAsync).toHaveBeenCalledOnce();
  });

  it("continues voice start when requesting Bluetooth permission throws", async () => {
    const harness = makeHarness();
    vi.mocked(harness.native.getBluetoothPermissionAsync).mockResolvedValueOnce({
      granted: false,
      canAskAgain: true,
    } as never);
    vi.mocked(harness.native.requestBluetoothPermissionAsync).mockRejectedValueOnce(
      new Error("Bluetooth prompt unavailable"),
    );

    await harness.adapter.startThread(threadInput);

    expect(harness.native.requestBluetoothPermissionAsync).toHaveBeenCalledOnce();
    expect(harness.createNativeSession).toHaveBeenCalledOnce();
    expect(harness.native.startThreadAsync).toHaveBeenCalledOnce();
  });

  it("hydrates first and retains only the newest complete buffered snapshot", async () => {
    let resolveSnapshot!: (snapshot: VoiceRuntimeSnapshot) => void;
    const harness = makeHarness(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const received: Array<number> = [];
    const subscribing = harness.adapter.subscribe((snapshot) => received.push(snapshot.sequence));

    harness.emit(idleSnapshot(1));
    harness.emit(idleSnapshot(3));
    harness.emit(idleSnapshot(2));
    resolveSnapshot(idleSnapshot(0));
    const detach = await subscribing;

    expect(received).toEqual([0, 3]);
    harness.emit(idleSnapshot(3));
    harness.emit(idleSnapshot(4));
    expect(received).toEqual([0, 3, 4]);

    detach();
    detach();
    harness.emit(idleSnapshot(5));
    expect(received).toEqual([0, 3, 4]);
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.native.stopRuntimeAsync).not.toHaveBeenCalled();
  });

  it("reattaches to active Realtime and Thread snapshots without issuing another start", async () => {
    for (const activeSnapshot of [activeRealtimeSnapshot, activeThreadSnapshot]) {
      const harness = makeHarness(async () => activeSnapshot);
      const received: Array<VoiceRuntimeSnapshot> = [];

      const detach = await harness.adapter.subscribe((snapshot) => received.push(snapshot));

      expect(received).toEqual([activeSnapshot]);
      expect(harness.makeClient).not.toHaveBeenCalled();
      expect(harness.createNativeSession).not.toHaveBeenCalled();
      expect(harness.native.startRealtimeAsync).not.toHaveBeenCalled();
      expect(harness.native.startThreadAsync).not.toHaveBeenCalled();

      detach();
      expect(harness.remove).toHaveBeenCalledOnce();
    }
  });

  it("removes the native listener when initial hydration fails", async () => {
    const harness = makeHarness(async () => {
      throw new Error("binder unavailable");
    });

    await expect(harness.adapter.subscribe(() => undefined)).rejects.toThrow("binder unavailable");
    expect(harness.remove).toHaveBeenCalledTimes(1);
  });

  it("coalesces queued review edits while preserving their order before Submit", async () => {
    const harness = makeHarness();
    let releaseFirst!: () => void;
    vi.mocked(harness.native.updateThreadReviewTranscriptAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const token = { generation: 4, reviewId: 9 };

    const first = harness.adapter.updateThreadReviewTranscript(token, "a");
    await vi.waitFor(() =>
      expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenCalledOnce(),
    );
    const second = harness.adapter.updateThreadReviewTranscript(token, "ab");
    const third = harness.adapter.updateThreadReviewTranscript(token, "abc");
    const submit = harness.adapter.submitThreadTranscript(token, "abc");

    releaseFirst();
    await Promise.all([first, second, third, submit]);

    expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenCalledTimes(2);
    expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenNthCalledWith(2, {
      expectedGeneration: 4,
      expectedReviewId: 9,
      transcript: "abc",
    });
    expect(
      vi.mocked(harness.native.updateThreadReviewTranscriptAsync).mock.invocationCallOrder[1],
    ).toBeLessThan(
      vi.mocked(harness.native.submitThreadTranscriptAsync).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("never coalesces review edits across native review identities", async () => {
    const harness = makeHarness();
    let releaseFirst!: () => void;
    vi.mocked(harness.native.updateThreadReviewTranscriptAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const firstReview = { generation: 4, reviewId: 9 };
    const nextReview = { generation: 5, reviewId: 1 };

    const first = harness.adapter.updateThreadReviewTranscript(firstReview, "old");
    await vi.waitFor(() =>
      expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenCalledOnce(),
    );
    const superseded = harness.adapter.updateThreadReviewTranscript(firstReview, "old edited");
    const next = harness.adapter.updateThreadReviewTranscript(nextReview, "new");
    const nextEdited = harness.adapter.updateThreadReviewTranscript(nextReview, "new edited");

    releaseFirst();
    await Promise.all([first, superseded, next, nextEdited]);

    expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenCalledTimes(3);
    expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenNthCalledWith(2, {
      expectedGeneration: 4,
      expectedReviewId: 9,
      transcript: "old edited",
    });
    expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenNthCalledWith(3, {
      expectedGeneration: 5,
      expectedReviewId: 1,
      transcript: "new edited",
    });
  });

  it("forwards semantic controls without involving the parent credential", async () => {
    const harness = makeHarness();
    const confirmationId = VoiceConfirmationId.make("confirmation-1");
    const actionId = VoiceClientActionId.make("action-1");

    await harness.adapter.setRealtimeMuted(true);
    await harness.adapter.setRealtimeAudioRoute("bluetooth-device");
    await harness.adapter.updateRealtimeContext({
      focus: realtimeTarget.focus,
      threadSwitch: threadInput,
    });
    await harness.adapter.decideRealtimeConfirmation(confirmationId, "approve");
    await harness.adapter.completeRealtimeClientAction(actionId, "failed", "Navigation failed");
    await harness.adapter.finishThreadRecording();
    await harness.adapter.updateThreadReviewTranscript(
      { generation: 4, reviewId: 9 },
      "Editing transcript",
    );
    await harness.adapter.submitThreadTranscript(
      { generation: 4, reviewId: 9 },
      "Edited transcript",
    );
    await harness.adapter.stop();

    expect(harness.makeClient).not.toHaveBeenCalled();
    expect(harness.native.setRealtimeMutedAsync).toHaveBeenCalledWith({ muted: true });
    expect(harness.native.setRealtimeAudioRouteAsync).toHaveBeenCalledWith({
      routeId: "bluetooth-device",
    });
    expect(harness.native.updateRealtimeContextAsync).toHaveBeenCalledWith({
      focus: realtimeTarget.focus,
      threadSwitch: threadInput,
    });
    expect(harness.native.decideRealtimeConfirmationAsync).toHaveBeenCalledWith({
      confirmationId,
      decision: "approve",
    });
    expect(harness.native.completeRealtimeClientActionAsync).toHaveBeenCalledWith({
      actionId,
      outcome: "failed",
      message: "Navigation failed",
    });
    expect(harness.native.finishThreadRecordingAsync).toHaveBeenCalledOnce();
    expect(harness.native.updateThreadReviewTranscriptAsync).toHaveBeenCalledWith({
      expectedGeneration: 4,
      expectedReviewId: 9,
      transcript: "Editing transcript",
    });
    expect(harness.native.submitThreadTranscriptAsync).toHaveBeenCalledWith({
      expectedGeneration: 4,
      expectedReviewId: 9,
      transcript: "Edited transcript",
    });
    expect(harness.native.stopRuntimeAsync).toHaveBeenCalledOnce();
  });

  it("keeps snapshots and native-local controls available without a prepared connection", async () => {
    const harness = makeHarness();
    harness.setPrepared(null);
    const listener = vi.fn();

    const detach = await harness.adapter.subscribe(listener);
    await harness.adapter.setRealtimeMuted(true);
    await harness.adapter.switchRealtimeToThread(threadInput);
    await expect(harness.adapter.startThread(threadInput)).rejects.toThrow(
      "A prepared environment connection is required",
    );

    expect(listener).toHaveBeenCalledWith(idleSnapshot(0));
    expect(harness.native.setRealtimeMutedAsync).toHaveBeenCalledWith({ muted: true });
    expect(harness.native.switchRealtimeToThreadAsync).toHaveBeenCalledWith(threadInput);
    expect(harness.native.getMicrophonePermissionAsync).not.toHaveBeenCalled();
    expect(harness.requestNotificationPermission).not.toHaveBeenCalled();
    expect(harness.makeClient).not.toHaveBeenCalled();
    detach();
  });

  it("does not resolve stop until native media ownership reaches idle", async () => {
    let current: VoiceRuntimeSnapshot = {
      mode: "realtime",
      phase: "stopping",
      generation: 4,
      sequence: 20,
      target: realtimeTarget,
      muted: false,
      audioRoutes: [],
      transcript: [],
      pendingConfirmations: [],
      pendingClientActions: [],
    };
    const harness = makeHarness(async () => current);
    let resolved = false;
    const stopping = harness.adapter.stop().then(() => {
      resolved = true;
    });
    const muted = harness.adapter.setRealtimeMuted(true);

    await vi.waitFor(() => expect(harness.native.getRuntimeSnapshotAsync).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    expect(harness.native.setRealtimeMutedAsync).not.toHaveBeenCalled();
    current = {
      mode: "failed",
      environmentId: ENVIRONMENT_ID,
      operation: "realtime",
      generation: 4,
      sequence: 21,
      failure: {
        code: "realtime-stop-timeout",
        message: "Realtime cleanup is still draining.",
        retryable: true,
      },
    };
    harness.emit(current);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(harness.native.setRealtimeMutedAsync).not.toHaveBeenCalled();
    current = idleSnapshot(22);
    harness.emit(current);
    await stopping;
    await muted;

    expect(resolved).toBe(true);
    expect(harness.native.setRealtimeMutedAsync).toHaveBeenCalledWith({ muted: true });
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it("removes the stop observer when native command dispatch fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.native.stopRuntimeAsync).mockRejectedValueOnce(new Error("binder failed"));

    await expect(harness.adapter.stop()).rejects.toThrow("binder failed");

    expect(harness.remove).toHaveBeenCalledOnce();
  });
});

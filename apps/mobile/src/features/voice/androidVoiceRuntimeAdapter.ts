import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type {
  VoiceHttpClient,
  VoiceRealtimeContext,
  VoiceRealtimeTarget,
  VoiceRuntimeAdmissionOptions,
  VoiceRuntimeAdapter,
  VoiceRuntimeSnapshot,
  VoiceRuntimeSnapshotListener,
  VoiceThreadStartInput,
} from "@t3tools/client-runtime/voice";
import type {
  EnvironmentId,
  VoiceClientActionId,
  VoiceClientActionOutcome,
  VoiceConfirmationDecision,
  VoiceConfirmationId,
} from "@t3tools/contracts";
import type {
  T3VoiceNativeModule,
  T3VoiceNativeSessionConfiguration,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";

import { AndroidVoiceCommandQueue } from "./androidVoiceCommandQueue";
import { requestAndroidVoiceNotificationPermission } from "./androidVoiceNotificationPermission";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import { ensureMicrophonePermission } from "./microphonePermission";

export type AndroidVoiceRuntimeClientFactory = (
  prepared: PreparedConnection,
) => Promise<Pick<VoiceHttpClient, "createNativeSession">>;

export interface AndroidVoiceRuntimeAdapterInput {
  readonly native: T3VoiceNativeModule;
  readonly environmentId: EnvironmentId;
  readonly getPrepared: () => PreparedConnection | null;
  readonly makeClient?: AndroidVoiceRuntimeClientFactory;
  readonly requestNotificationPermission?: () => Promise<"granted" | "denied">;
}

const requestOptionalBluetoothPermission = async (native: T3VoiceNativeModule): Promise<void> => {
  try {
    const current = await native.getBluetoothPermissionAsync();
    if (current.granted || current.canAskAgain === false) return;
    // Bluetooth denial degrades route discovery but does not block microphone
    // work or the system-selected non-Bluetooth route.
    await native.requestBluetoothPermissionAsync();
  } catch {
    // Permission-manager failure has the same degraded-route behavior as denial.
  }
};

const assertEnvironment = (
  runtimeEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
): void => {
  if (environmentId !== runtimeEnvironmentId) {
    throw new Error("The native voice target does not belong to the runtime environment");
  }
};

const ensureInitialStartIdle = async (native: T3VoiceNativeModule): Promise<void> => {
  if ((await native.getRuntimeSnapshotAsync()).mode !== "idle") {
    throw new Error("Native voice runtime is already active");
  }
};

const realtimeAdmissionMode = async (native: T3VoiceNativeModule): Promise<"idle" | "thread"> => {
  const mode = (await native.getRuntimeSnapshotAsync()).mode;
  if (mode !== "idle" && mode !== "thread") {
    throw new Error("Native voice runtime cannot admit Realtime from its current state");
  }
  return mode;
};

const attachSnapshotListener = async (
  native: T3VoiceNativeModule,
  listener: VoiceRuntimeSnapshotListener,
): Promise<() => void> => {
  let buffered: VoiceRuntimeSnapshot | null = null;
  let attached = true;
  let hydrating = true;
  let latestSequence = Number.NEGATIVE_INFINITY;

  const publish = (snapshot: VoiceRuntimeSnapshot) => {
    if (snapshot.sequence <= latestSequence) return;
    latestSequence = snapshot.sequence;
    listener(snapshot);
  };
  const subscription = native.addListener("runtimeSnapshotChanged", (snapshot) => {
    if (!attached) return;
    if (hydrating) {
      if (buffered === null || snapshot.sequence > buffered.sequence) buffered = snapshot;
      return;
    }
    publish(snapshot);
  });

  try {
    publish(await native.getRuntimeSnapshotAsync());
    if (buffered !== null) publish(buffered);
    hydrating = false;
  } catch (cause) {
    attached = false;
    subscription.remove();
    throw cause;
  }

  return () => {
    if (!attached) return;
    attached = false;
    subscription.remove();
  };
};

const STOP_COMPLETION_TIMEOUT_MS = 15_000;

const stopAndAwaitRelease = async (native: T3VoiceNativeModule): Promise<void> => {
  let terminal = false;
  let resolveTerminal!: () => void;
  const terminalSnapshot = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const accept = (snapshot: VoiceRuntimeSnapshot) => {
    if (terminal || snapshot.mode !== "idle") return;
    terminal = true;
    resolveTerminal();
  };
  const subscription = native.addListener("runtimeSnapshotChanged", accept);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await native.stopRuntimeAsync();
    accept(await native.getRuntimeSnapshotAsync());
    if (terminal) return;
    await Promise.race([
      terminalSnapshot,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Native voice did not release its media resources in time")),
          STOP_COMPLETION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    subscription.remove();
  }
};

export const makeAndroidVoiceRuntimeAdapter = (
  input: AndroidVoiceRuntimeAdapterInput,
): VoiceRuntimeAdapter => {
  const commands = new AndroidVoiceCommandQueue();
  const makeClient = input.makeClient ?? makeMobileVoiceClient;
  const requestNotificationPermission =
    input.requestNotificationPermission ?? requestAndroidVoiceNotificationPermission;

  const assertNotCancelled = (options?: VoiceRuntimeAdmissionOptions): void => {
    if (options?.signal?.aborted === true) throw new Error("Voice start was cancelled");
  };

  const requirePreparedConnection = (environmentId: EnvironmentId): PreparedConnection => {
    assertEnvironment(input.environmentId, environmentId);
    const prepared = input.getPrepared();
    if (prepared === null || prepared.environmentId !== input.environmentId) {
      throw new Error("A prepared environment connection is required to start native voice");
    }
    return prepared;
  };

  const issueNativeSession = async (
    prepared: PreparedConnection,
    options?: VoiceRuntimeAdmissionOptions,
  ): Promise<T3VoiceNativeSessionConfiguration> => {
    assertNotCancelled(options);
    const client = await makeClient(prepared);
    assertNotCancelled(options);
    const credential = await Effect.runPromise(client.createNativeSession(), {
      signal: options?.signal,
    });
    assertNotCancelled(options);
    return {
      baseUrl: environmentEndpointUrl(prepared.httpBaseUrl, "/"),
      accessToken: credential.accessToken,
      expiresAt: credential.expiresAt,
    };
  };

  const prepareNativeSession = async (
    environmentId: EnvironmentId,
    options?: VoiceRuntimeAdmissionOptions,
  ): Promise<T3VoiceNativeSessionConfiguration> => {
    assertNotCancelled(options);
    requirePreparedConnection(environmentId);
    assertNotCancelled(options);
    await ensureMicrophonePermission(input.native);
    assertNotCancelled(options);
    await requestNotificationPermission().catch(() => "denied" as const);
    assertNotCancelled(options);
    await requestOptionalBluetoothPermission(input.native);
    assertNotCancelled(options);
    return issueNativeSession(requirePreparedConnection(environmentId), options);
  };

  return {
    getSnapshot: async () => input.native.getRuntimeSnapshotAsync(),
    subscribe: (listener) => attachSnapshotListener(input.native, listener),
    startRealtime: async (target: VoiceRealtimeTarget, options?: VoiceRuntimeAdmissionOptions) => {
      assertEnvironment(input.environmentId, target.environmentId);
      return commands.enqueue(async () => {
        await realtimeAdmissionMode(input.native);
        const session = await prepareNativeSession(target.environmentId, options);
        assertNotCancelled(options);
        requirePreparedConnection(target.environmentId);
        const mode = await realtimeAdmissionMode(input.native);
        assertNotCancelled(options);
        if (mode === "thread") {
          await input.native.switchThreadToRealtimeAsync({ target, session });
        } else {
          await input.native.startRealtimeAsync({ target, session });
        }
      });
    },
    startThread: async (threadInput: VoiceThreadStartInput) => {
      assertEnvironment(input.environmentId, threadInput.target.environmentId);
      return commands.enqueue(async () => {
        await ensureInitialStartIdle(input.native);
        const session = await prepareNativeSession(threadInput.target.environmentId);
        await ensureInitialStartIdle(input.native);
        await input.native.startThreadAsync({ input: threadInput, session });
      });
    },
    switchRealtimeToThread: async (threadInput: VoiceThreadStartInput) => {
      assertEnvironment(input.environmentId, threadInput.target.environmentId);
      return commands.enqueue(() => input.native.switchRealtimeToThreadAsync(threadInput));
    },
    stop: () => commands.enqueue(() => stopAndAwaitRelease(input.native)),
    setRealtimeMuted: (muted: boolean) =>
      commands.enqueue(() => input.native.setRealtimeMutedAsync({ muted })),
    updateRealtimeContext: async (context: VoiceRealtimeContext) => {
      return commands.enqueue(() => input.native.updateRealtimeContextAsync(context));
    },
    decideRealtimeConfirmation: async (
      confirmationId: VoiceConfirmationId,
      decision: VoiceConfirmationDecision,
    ) =>
      commands.enqueue(() =>
        input.native.decideRealtimeConfirmationAsync({ confirmationId, decision }),
      ),
    completeRealtimeClientAction: async (
      actionId: VoiceClientActionId,
      outcome: VoiceClientActionOutcome,
      message?: string,
    ) =>
      commands.enqueue(() =>
        input.native.completeRealtimeClientActionAsync({
          actionId,
          outcome,
          ...(message === undefined ? {} : { message }),
        }),
      ),
    finishThreadRecording: () => commands.enqueue(() => input.native.finishThreadRecordingAsync()),
    updateThreadReviewTranscript: (token, transcript) =>
      commands.enqueueReviewUpdate(token, transcript, (currentToken, currentTranscript) =>
        input.native.updateThreadReviewTranscriptAsync({
          expectedGeneration: currentToken.generation,
          expectedReviewId: currentToken.reviewId,
          transcript: currentTranscript,
        }),
      ),
    submitThreadTranscript: (token, transcript) =>
      commands.enqueue(() =>
        input.native.submitThreadTranscriptAsync({
          expectedGeneration: token.generation,
          expectedReviewId: token.reviewId,
          transcript,
        }),
      ),
  };
};

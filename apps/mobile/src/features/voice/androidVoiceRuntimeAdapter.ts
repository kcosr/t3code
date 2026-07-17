import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type {
  VoiceHttpClient,
  VoiceRealtimeContext,
  VoiceRealtimeTarget,
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

const assertRealtimeContext = (
  runtimeEnvironmentId: EnvironmentId,
  context: VoiceRealtimeContext,
): void => {
  const threadSwitch = context.threadSwitch;
  if (threadSwitch === null) return;
  assertEnvironment(runtimeEnvironmentId, threadSwitch.target.environmentId);
  const focus = context.focus;
  if (focus === null) {
    throw new Error("A native voice Thread switch target requires a Realtime focus");
  }
  if (
    focus.projectId !== threadSwitch.target.projectId ||
    focus.threadId !== threadSwitch.target.threadId
  ) {
    throw new Error("The native voice Thread switch target does not match the Realtime focus");
  }
};

const ensureInitialStartIdle = async (native: T3VoiceNativeModule): Promise<void> => {
  if ((await native.getRuntimeSnapshotAsync()).mode !== "idle") {
    throw new Error("Native voice runtime is already active");
  }
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
  ): Promise<T3VoiceNativeSessionConfiguration> => {
    const client = await makeClient(prepared);
    const credential = await Effect.runPromise(client.createNativeSession());
    return {
      baseUrl: environmentEndpointUrl(prepared.httpBaseUrl, "/"),
      accessToken: credential.accessToken,
      expiresAt: credential.expiresAt,
    };
  };

  const prepareInitialStart = async (
    environmentId: EnvironmentId,
  ): Promise<T3VoiceNativeSessionConfiguration> => {
    const prepared = requirePreparedConnection(environmentId);
    await ensureInitialStartIdle(input.native);
    await ensureMicrophonePermission(input.native);
    await requestNotificationPermission().catch(() => "denied" as const);
    await requestOptionalBluetoothPermission(input.native);
    return issueNativeSession(prepared);
  };

  return {
    getSnapshot: async () => input.native.getRuntimeSnapshotAsync(),
    subscribe: (listener) => attachSnapshotListener(input.native, listener),
    startRealtime: async (target: VoiceRealtimeTarget) => {
      assertEnvironment(input.environmentId, target.environmentId);
      assertRealtimeContext(input.environmentId, target);
      return commands.enqueue(async () => {
        const session = await prepareInitialStart(target.environmentId);
        await input.native.startRealtimeAsync({ target, session });
      });
    },
    startThread: async (threadInput: VoiceThreadStartInput) => {
      assertEnvironment(input.environmentId, threadInput.target.environmentId);
      return commands.enqueue(async () => {
        const session = await prepareInitialStart(threadInput.target.environmentId);
        await input.native.startThreadAsync({ input: threadInput, session });
      });
    },
    switchRealtimeToThread: async (threadInput: VoiceThreadStartInput) => {
      assertEnvironment(input.environmentId, threadInput.target.environmentId);
      return commands.enqueue(() => input.native.switchRealtimeToThreadAsync(threadInput));
    },
    switchThreadToRealtime: async (target: VoiceRealtimeTarget) => {
      assertEnvironment(input.environmentId, target.environmentId);
      assertRealtimeContext(input.environmentId, target);
      return commands.enqueue(async () => {
        const prepared = requirePreparedConnection(target.environmentId);
        await ensureMicrophonePermission(input.native);
        await requestNotificationPermission().catch(() => "denied" as const);
        await requestOptionalBluetoothPermission(input.native);
        const session = await issueNativeSession(prepared);
        await input.native.switchThreadToRealtimeAsync({ target, session });
      });
    },
    stop: () => commands.enqueue(() => stopAndAwaitRelease(input.native)),
    setRealtimeMuted: (muted: boolean) =>
      commands.enqueue(() => input.native.setRealtimeMutedAsync({ muted })),
    setRealtimeAudioRoute: (routeId: string) =>
      commands.enqueue(() => input.native.setRealtimeAudioRouteAsync({ routeId })),
    updateRealtimeContext: async (context: VoiceRealtimeContext) => {
      assertRealtimeContext(input.environmentId, context);
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

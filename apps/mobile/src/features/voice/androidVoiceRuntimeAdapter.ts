import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type {
  VoiceHttpClient,
  VoiceRealtimeContext,
  VoiceRealtimeTarget,
  VoiceRuntimeAdapter,
  VoiceRuntimeSnapshot,
  VoiceRuntimeSnapshotListener,
  VoiceThreadReviewToken,
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

export type AndroidVoiceRuntimeClientFactory = (
  prepared: PreparedConnection,
) => Promise<Pick<VoiceHttpClient, "createNativeSession">>;

export interface AndroidVoiceRuntimeAdapterInput {
  readonly native: T3VoiceNativeModule;
  readonly prepared: PreparedConnection;
  readonly makeClient?: AndroidVoiceRuntimeClientFactory;
  readonly requestNotificationPermission?: () => Promise<"granted" | "denied">;
}

const ensureMicrophonePermission = async (native: T3VoiceNativeModule): Promise<void> => {
  const current = await native.getMicrophonePermissionAsync();
  if (current.granted) return;
  const requested = await native.requestMicrophonePermissionAsync();
  if (!requested.granted) {
    throw new Error("Microphone permission is required for voice");
  }
};

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

const assertEnvironment = (prepared: PreparedConnection, environmentId: EnvironmentId): void => {
  if (environmentId !== prepared.environmentId) {
    throw new Error("The native voice target does not belong to the prepared environment");
  }
};

const assertRealtimeContext = (
  prepared: PreparedConnection,
  context: VoiceRealtimeContext,
): void => {
  const threadSwitch = context.threadSwitch;
  if (threadSwitch === null) return;
  assertEnvironment(prepared, threadSwitch.target.environmentId);
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
  const buffered: Array<VoiceRuntimeSnapshot> = [];
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
      buffered.push(snapshot);
      return;
    }
    publish(snapshot);
  });

  try {
    publish(await native.getRuntimeSnapshotAsync());
    buffered.sort((left, right) => left.sequence - right.sequence);
    for (const snapshot of buffered) publish(snapshot);
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
  const commands = new AndroidVoiceCommandQueue<VoiceThreadReviewToken>();
  const makeClient = input.makeClient ?? makeMobileVoiceClient;
  const requestNotificationPermission =
    input.requestNotificationPermission ?? requestAndroidVoiceNotificationPermission;

  const issueNativeSession = async (
    environmentId: EnvironmentId,
  ): Promise<T3VoiceNativeSessionConfiguration> => {
    assertEnvironment(input.prepared, environmentId);
    const client = await makeClient(input.prepared);
    const credential = await Effect.runPromise(client.createNativeSession());
    return {
      baseUrl: environmentEndpointUrl(input.prepared.httpBaseUrl, "/"),
      accessToken: credential.accessToken,
      expiresAt: credential.expiresAt,
    };
  };

  const prepareInitialStart = async (
    environmentId: EnvironmentId,
  ): Promise<T3VoiceNativeSessionConfiguration> => {
    await ensureInitialStartIdle(input.native);
    await ensureMicrophonePermission(input.native);
    await requestNotificationPermission().catch(() => "denied" as const);
    await requestOptionalBluetoothPermission(input.native);
    return issueNativeSession(environmentId);
  };

  return {
    getSnapshot: async () => input.native.getRuntimeSnapshotAsync(),
    subscribe: (listener) => attachSnapshotListener(input.native, listener),
    startRealtime: async (target: VoiceRealtimeTarget) => {
      assertEnvironment(input.prepared, target.environmentId);
      assertRealtimeContext(input.prepared, target);
      return commands.enqueue(async () => {
        const session = await prepareInitialStart(target.environmentId);
        await input.native.startRealtimeAsync({ target, session });
      });
    },
    startThread: async (threadInput: VoiceThreadStartInput) => {
      assertEnvironment(input.prepared, threadInput.target.environmentId);
      return commands.enqueue(async () => {
        const session = await prepareInitialStart(threadInput.target.environmentId);
        await input.native.startThreadAsync({ input: threadInput, session });
      });
    },
    switchRealtimeToThread: async (threadInput: VoiceThreadStartInput) => {
      assertEnvironment(input.prepared, threadInput.target.environmentId);
      return commands.enqueue(() => input.native.switchRealtimeToThreadAsync(threadInput));
    },
    stop: () => commands.enqueue(() => stopAndAwaitRelease(input.native)),
    setRealtimeMuted: (muted: boolean) =>
      commands.enqueue(() => input.native.setRealtimeMutedAsync({ muted })),
    setRealtimeAudioRoute: (routeId: string) =>
      commands.enqueue(() => input.native.setRealtimeAudioRouteAsync({ routeId })),
    updateRealtimeContext: async (context: VoiceRealtimeContext) => {
      assertRealtimeContext(input.prepared, context);
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

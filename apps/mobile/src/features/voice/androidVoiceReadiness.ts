import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type {
  VoiceHttpClient,
  VoiceRealtimeTarget,
  VoiceThreadStartInput,
} from "@t3tools/client-runtime/voice";
import type {
  T3VoiceNativeModule,
  T3VoiceNativeSessionConfiguration,
  T3VoiceReadinessMode,
  T3VoiceReadinessSnapshot,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import { requestAndroidVoiceNotificationPermission } from "./androidVoiceNotificationPermission";
import { requestOptionalBluetoothPermission } from "./requestOptionalBluetoothPermission";
import { loadResumeSelection } from "./voiceConversationResume";

export type AndroidVoiceReadinessTarget =
  | {
      readonly mode: "realtime";
      readonly label: "Realtime";
      readonly target: Omit<VoiceRealtimeTarget, "conversation">;
    }
  | {
      readonly mode: "thread";
      readonly label: string;
      readonly target: VoiceThreadStartInput | null;
    };

export interface AndroidVoiceReadinessProvisionInput {
  readonly native: T3VoiceNativeModule;
  readonly prepared: PreparedConnection | null;
  readonly client: VoiceHttpClient | null;
  readonly target: AndroidVoiceReadinessTarget;
  readonly threadSwitch: VoiceThreadStartInput | null;
  readonly signal: AbortSignal;
  readonly requestNotificationPermission?: () => Promise<"granted" | "denied">;
  readonly ownsRequest?: () => boolean;
}

export interface AndroidVoiceReadinessRequest extends Omit<
  AndroidVoiceReadinessProvisionInput,
  "native" | "signal" | "ownsRequest"
> {
  readonly identity: string;
}

class AndroidVoiceReadinessSuperseded extends Error {}
export class AndroidVoiceReadinessDependencyUnavailable extends Error {}

const assertCurrent = (input: AndroidVoiceReadinessProvisionInput): void => {
  if (input.signal.aborted || input.ownsRequest?.() === false) {
    throw new AndroidVoiceReadinessSuperseded("Voice readiness request was superseded");
  }
};

const isNativeGenerationConflict = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /readiness.*generation.*stale|generation.*stale/i.test(message);
};

const nextGeneration = (snapshot: T3VoiceReadinessSnapshot): number => snapshot.generation + 1;
const nativeReadinessLabel = (label: string): string => {
  let truncated = "";
  for (const character of label.trim()) {
    if (truncated.length + character.length > 256) break;
    truncated += character;
  }
  return truncated || "Voice";
};

export async function acceptEnabledAndroidVoiceReadiness(
  snapshot: T3VoiceReadinessSnapshot | null,
  targetMode: AndroidVoiceReadinessTarget["mode"],
  disable: () => Promise<unknown>,
): Promise<T3VoiceReadinessSnapshot> {
  if (snapshot?.posture === "ready") return snapshot;
  await disable();
  throw new Error(
    snapshot?.posture === "unavailable"
      ? targetMode === "thread"
        ? "The selected Active Thread is unavailable"
        : "Realtime voice controls are unavailable"
      : "Voice controls need to be refreshed",
  );
}

export async function concreteRealtimeReadinessTarget(
  client: Pick<VoiceHttpClient, "listConversations" | "createConversation">,
  target: Omit<VoiceRealtimeTarget, "conversation">,
  signal: AbortSignal,
  ownsRequest: () => boolean = () => true,
): Promise<VoiceRealtimeTarget | null> {
  const selection = await loadResumeSelection(client, signal);
  if (selection === null || signal.aborted || !ownsRequest()) return null;
  if (selection.type === "continue") return { ...target, conversation: selection };
  const created = await Effect.runPromise(
    client.createConversation({
      retention: "durable",
      ...(selection.title === undefined ? {} : { title: selection.title }),
    }),
    { signal },
  );
  if (signal.aborted || !ownsRequest()) return null;
  return {
    ...target,
    conversation: {
      type: "continue",
      conversationId: created.conversationId,
      takeover: false,
    },
  };
}

export async function provisionAndroidVoiceReadiness(
  input: AndroidVoiceReadinessProvisionInput,
): Promise<T3VoiceReadinessSnapshot> {
  const targetEnvironmentId =
    input.target.mode === "realtime"
      ? input.target.target.environmentId
      : input.target.target?.target.environmentId;
  if (input.target.mode === "realtime" && (input.client === null || input.prepared === null)) {
    throw new AndroidVoiceReadinessDependencyUnavailable(
      "The Realtime environment is not connected",
    );
  }
  if (
    input.target.mode === "thread" &&
    input.target.target !== null &&
    (input.client === null || input.prepared === null)
  ) {
    throw new AndroidVoiceReadinessDependencyUnavailable(
      "The remembered Thread environment is not connected",
    );
  }
  if (
    targetEnvironmentId !== undefined &&
    input.prepared !== null &&
    input.prepared.environmentId !== targetEnvironmentId
  ) {
    throw new AndroidVoiceReadinessDependencyUnavailable(
      "Voice readiness received a connection for the wrong environment",
    );
  }
  const microphone = await input.native.getMicrophonePermissionAsync();
  assertCurrent(input);
  if (!microphone.granted) throw new Error("Background voice controls need microphone access");
  const notification = await (
    input.requestNotificationPermission ?? requestAndroidVoiceNotificationPermission
  )();
  assertCurrent(input);
  if (notification !== "granted") {
    throw new Error("Background voice controls need notification access");
  }
  await requestOptionalBluetoothPermission(input.native);
  assertCurrent(input);

  let resolved: {
    readonly mode: T3VoiceReadinessMode;
    readonly label: string;
    readonly input: unknown;
  } | null;
  if (input.target.mode === "realtime") {
    const client = input.client;
    if (client === null) {
      throw new AndroidVoiceReadinessDependencyUnavailable(
        "The Realtime environment is not connected",
      );
    }
    const target = await concreteRealtimeReadinessTarget(
      client,
      input.target.target,
      input.signal,
      input.ownsRequest,
    );
    if (target === null) throw new Error("Voice readiness provisioning was cancelled");
    resolved = { mode: "realtime", label: input.target.label, input: target };
  } else {
    resolved =
      input.target.target === null
        ? null
        : { mode: "thread", label: input.target.label, input: input.target.target };
  }

  let session: T3VoiceNativeSessionConfiguration | null = null;
  if (resolved !== null) {
    const prepared = input.prepared;
    const client = input.client;
    if (prepared === null || client === null) {
      throw new AndroidVoiceReadinessDependencyUnavailable(
        "The selected voice environment is not connected",
      );
    }
    session = {
      baseUrl: environmentEndpointUrl(prepared.httpBaseUrl, "/"),
      ...(await Effect.runPromise(client.createNativeSession(), { signal: input.signal })),
    };
  }
  assertCurrent(input);
  const current = await input.native.getReadinessSnapshotAsync();
  assertCurrent(input);
  const configured = await input.native.configureReadinessAsync({
    generation: nextGeneration(current),
    mode: input.target.mode,
    label: nativeReadinessLabel(input.target.label),
    start:
      resolved === null || session === null
        ? null
        : resolved.mode === "realtime"
          ? { type: "realtime", input: resolved.input as VoiceRealtimeTarget, session }
          : { type: "thread", input: resolved.input as VoiceThreadStartInput, session },
    threadSwitch:
      targetEnvironmentId !== undefined &&
      input.threadSwitch?.target.environmentId === targetEnvironmentId
        ? input.threadSwitch
        : null,
  });
  assertCurrent(input);
  return configured;
}

export async function disableAndroidVoiceReadiness(
  native: T3VoiceNativeModule,
): Promise<T3VoiceReadinessSnapshot> {
  const current = await native.getReadinessSnapshotAsync();
  if (current.posture === "disabled") return current;
  return native.disableReadinessAsync({ generation: nextGeneration(current) });
}

export function androidVoiceReadinessIdentity(
  target: AndroidVoiceReadinessTarget,
  threadSwitch: VoiceThreadStartInput | null,
): string {
  return JSON.stringify({ target, threadSwitch });
}

export async function persistAndroidVoiceReadinessSetting(
  enabled: boolean,
  persist: (enabled: boolean) => Promise<void>,
  compensate: () => Promise<void>,
): Promise<void> {
  try {
    await persist(enabled);
  } catch (cause) {
    await compensate();
    throw cause;
  }
}

export async function reconcileAndroidVoiceReadinessDisable(
  native: T3VoiceNativeModule,
  persistDisabled: () => Promise<void>,
  cancelDesired: () => void,
  acceptDisabled: () => void,
): Promise<boolean> {
  const generation = await native.getPendingReadinessDisableAsync();
  if (generation === null) return false;
  cancelDesired();
  await persistDisabled();
  acceptDisabled();
  await native.acknowledgeReadinessDisableAsync({ generation });
  return true;
}

export class AndroidVoiceReadinessCoordinator {
  private revision = 0;
  private desiredIdentity: string | null = null;
  private activeAbort: AbortController | null = null;
  private tail: Promise<void> = Promise.resolve();
  private inFlightRequest: AndroidVoiceReadinessRequest | null = null;
  private inFlight: Promise<T3VoiceReadinessSnapshot | null> | null = null;

  constructor(
    private readonly native: T3VoiceNativeModule,
    private readonly acceptSnapshot: (snapshot: T3VoiceReadinessSnapshot) => void,
  ) {}

  request(request: AndroidVoiceReadinessRequest): Promise<T3VoiceReadinessSnapshot | null> {
    if (
      this.inFlightRequest?.identity === request.identity &&
      this.inFlightRequest.prepared === request.prepared &&
      this.inFlightRequest.client === request.client &&
      this.inFlight !== null
    ) {
      return this.inFlight;
    }
    const revision = ++this.revision;
    const replaceIdentity = this.desiredIdentity !== request.identity;
    this.desiredIdentity = request.identity;
    this.activeAbort?.abort();
    const abort = new AbortController();
    this.activeAbort = abort;
    const result = this.enqueue(async () => {
      if (!this.owns(revision, request.identity)) return null;
      if (replaceIdentity) {
        const fenced = await disableAndroidVoiceReadiness(this.native);
        if (!this.owns(revision, request.identity)) return null;
        this.acceptSnapshot(fenced);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const snapshot = await provisionAndroidVoiceReadiness({
            ...request,
            native: this.native,
            signal: abort.signal,
            ownsRequest: () => this.owns(revision, request.identity),
          });
          if (!this.owns(revision, request.identity)) {
            await disableAndroidVoiceReadiness(this.native);
            return null;
          }
          this.acceptSnapshot(snapshot);
          return snapshot;
        } catch (cause) {
          if (cause instanceof AndroidVoiceReadinessSuperseded || abort.signal.aborted) return null;
          if (attempt === 1 || !isNativeGenerationConflict(cause)) throw cause;
        }
      }
      return null;
    });
    this.inFlightRequest = request;
    this.inFlight = result;
    void result.then(
      () => this.clearInFlight(result),
      () => this.clearInFlight(result),
    );
    return result;
  }

  disable(): Promise<T3VoiceReadinessSnapshot> {
    ++this.revision;
    this.desiredIdentity = null;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.inFlightRequest = null;
    this.inFlight = null;
    return this.enqueue(async () => {
      const snapshot = await disableAndroidVoiceReadiness(this.native);
      this.acceptSnapshot(snapshot);
      return snapshot;
    });
  }

  dispose(): void {
    this.cancelDesired();
  }

  cancelDesired(): void {
    ++this.revision;
    this.desiredIdentity = null;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.inFlightRequest = null;
    this.inFlight = null;
  }

  private owns(revision: number, identity: string): boolean {
    return this.revision === revision && this.desiredIdentity === identity;
  }

  private clearInFlight(result: Promise<T3VoiceReadinessSnapshot | null>): void {
    if (this.inFlight !== result) return;
    this.inFlight = null;
    this.inFlightRequest = null;
  }

  private enqueue<A>(work: () => Promise<A>): Promise<A> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

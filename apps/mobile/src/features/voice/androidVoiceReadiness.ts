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
  readonly prepared: PreparedConnection;
  readonly client: VoiceHttpClient;
  readonly target: AndroidVoiceReadinessTarget;
  readonly threadSwitch: VoiceThreadStartInput | null;
  readonly signal: AbortSignal;
  readonly requestNotificationPermission?: () => Promise<"granted" | "denied">;
}

const nextGeneration = (snapshot: T3VoiceReadinessSnapshot): number => snapshot.generation + 1;

export async function concreteRealtimeReadinessTarget(
  client: Pick<VoiceHttpClient, "listConversations" | "createConversation">,
  target: Omit<VoiceRealtimeTarget, "conversation">,
  signal: AbortSignal,
): Promise<VoiceRealtimeTarget | null> {
  const selection = await loadResumeSelection(client, signal);
  if (selection === null || signal.aborted) return null;
  if (selection.type === "continue") return { ...target, conversation: selection };
  const created = await Effect.runPromise(
    client.createConversation({
      retention: "durable",
      ...(selection.title === undefined ? {} : { title: selection.title }),
    }),
    { signal },
  );
  if (signal.aborted) return null;
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
  const microphone = await input.native.getMicrophonePermissionAsync();
  if (!microphone.granted) throw new Error("Background voice controls need microphone access");
  const notification = await (
    input.requestNotificationPermission ?? requestAndroidVoiceNotificationPermission
  )();
  if (notification !== "granted") {
    throw new Error("Background voice controls need notification access");
  }
  await requestOptionalBluetoothPermission(input.native);
  if (input.signal.aborted) throw new Error("Voice readiness provisioning was cancelled");

  let resolved: {
    readonly mode: T3VoiceReadinessMode;
    readonly label: string;
    readonly input: unknown;
  } | null;
  if (input.target.mode === "realtime") {
    const target = await concreteRealtimeReadinessTarget(
      input.client,
      input.target.target,
      input.signal,
    );
    if (target === null) throw new Error("Voice readiness provisioning was cancelled");
    resolved = { mode: "realtime", label: input.target.label, input: target };
  } else {
    resolved =
      input.target.target === null
        ? null
        : { mode: "thread", label: input.target.label, input: input.target.target };
  }

  const session: T3VoiceNativeSessionConfiguration | null =
    resolved === null
      ? null
      : {
          baseUrl: environmentEndpointUrl(input.prepared.httpBaseUrl, "/"),
          ...(await Effect.runPromise(input.client.createNativeSession(), {
            signal: input.signal,
          })),
        };
  if (input.signal.aborted) throw new Error("Voice readiness provisioning was cancelled");
  const current = await input.native.getReadinessSnapshotAsync();
  if (input.signal.aborted) throw new Error("Voice readiness provisioning was cancelled");
  return input.native.configureReadinessAsync({
    generation: nextGeneration(current),
    mode: input.target.mode,
    label: input.target.label,
    start:
      resolved === null || session === null
        ? null
        : resolved.mode === "realtime"
          ? { type: "realtime", input: resolved.input as VoiceRealtimeTarget, session }
          : { type: "thread", input: resolved.input as VoiceThreadStartInput, session },
    threadSwitch: input.threadSwitch,
  });
}

export async function disableAndroidVoiceReadiness(
  native: T3VoiceNativeModule,
): Promise<T3VoiceReadinessSnapshot> {
  const current = await native.getReadinessSnapshotAsync();
  if (current.posture === "disabled") return current;
  return native.disableReadinessAsync({ generation: nextGeneration(current) });
}

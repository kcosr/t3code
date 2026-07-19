import type { EnvironmentId } from "@t3tools/contracts";
import {
  voiceRuntimeCommandEnvironmentMatches,
  type VoiceRealtimeTarget,
} from "@t3tools/client-runtime/voice";
import type { T3VoiceTerminalRuntimeFailureEvent } from "@t3tools/mobile-voice-native";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { Alert } from "react-native";

import type { AndroidVoiceRuntimeAdapter } from "./androidVoiceRuntimeAdapter";
import { resolveRuntimeFailurePresentation } from "./runtimeFailurePresentationDecision";
import { RuntimeTerminalFailurePresentationRegistry } from "./runtimeTerminalFailurePresentations";
import { voiceErrorMessage as errorMessage } from "./voiceError";

export interface VoiceRuntimeConnection {
  readonly environmentId: EnvironmentId;
  readonly adapter: AndroidVoiceRuntimeAdapter;
}

export function useVoiceRuntimeFailurePresentation(input: {
  readonly applicationState: string;
  readonly subscribedEnvironmentId: EnvironmentId | null;
  readonly runtimeRef: MutableRefObject<VoiceRuntimeConnection | null>;
  readonly controllerEnvironmentIdRef: MutableRefObject<EnvironmentId | null>;
  readonly lastRealtimeTargetRef: MutableRefObject<VoiceRealtimeTarget | null>;
  readonly startRealtime: (target: VoiceRealtimeTarget) => Promise<void>;
  readonly onConversationNotFound: () => void;
}): void {
  const failurePresentationsRef = useRef(new RuntimeTerminalFailurePresentationRegistry());
  const {
    applicationState,
    subscribedEnvironmentId,
    runtimeRef,
    controllerEnvironmentIdRef,
    lastRealtimeTargetRef,
    startRealtime,
    onConversationNotFound,
  } = input;

  const presentRuntimeFailure = useCallback(
    (failed: T3VoiceTerminalRuntimeFailureEvent, acknowledge: () => Promise<void>) => {
      const presentation = failurePresentationsRef.current.register(failed.failureId, acknowledge);
      if (!presentation.shouldPresent) return;
      const complete = presentation.complete;
      const decision = resolveRuntimeFailurePresentation(failed, lastRealtimeTargetRef.current);

      if (decision.kind === "takeover") {
        const takeoverTarget = decision.target;
        const expectedEnvironmentId = takeoverTarget.environmentId;
        Alert.alert(
          "Take over active voice session?",
          "An existing voice session is already active for this conversation. Taking over stops it and starts a new session here.",
          [
            {
              text: "Cancel",
              style: "cancel",
              onPress: () => {
                complete();
                const runtime = runtimeRef.current;
                if (
                  runtime === null ||
                  !voiceRuntimeCommandEnvironmentMatches(
                    expectedEnvironmentId,
                    runtime.environmentId,
                    controllerEnvironmentIdRef.current,
                  )
                ) {
                  return;
                }
                void runtime.adapter
                  .stop()
                  .catch((cause) => Alert.alert("Could not stop voice", errorMessage(cause)));
              },
            },
            {
              text: "Take Over",
              onPress: () => {
                complete();
                void (async () => {
                  const runtime = runtimeRef.current;
                  if (
                    runtime === null ||
                    !voiceRuntimeCommandEnvironmentMatches(
                      expectedEnvironmentId,
                      runtime.environmentId,
                      controllerEnvironmentIdRef.current,
                    )
                  ) {
                    return;
                  }
                  await runtime.adapter.stop();
                  await startRealtime(takeoverTarget);
                })().catch((cause) => Alert.alert("Voice takeover failed", errorMessage(cause)));
              },
            },
          ],
          { cancelable: false },
        );
        return;
      }

      if (decision.kind === "conversation-not-found") {
        void runtimeRef.current?.adapter
          .stop()
          .catch((cause) => Alert.alert("Could not stop voice", errorMessage(cause)));
        Alert.alert(
          "Conversation no longer available",
          "It may have been deleted on another device. The conversation list has been refreshed.",
          [{ text: "OK", onPress: complete }],
          { cancelable: false },
        );
        onConversationNotFound();
        return;
      }

      Alert.alert("Voice session failed", decision.message, [{ text: "OK", onPress: complete }], {
        cancelable: false,
      });
    },
    [
      controllerEnvironmentIdRef,
      lastRealtimeTargetRef,
      onConversationNotFound,
      runtimeRef,
      startRealtime,
    ],
  );

  useEffect(() => {
    if (applicationState !== "active" || subscribedEnvironmentId === null) return;
    const runtime = runtimeRef.current;
    if (runtime === null || runtime.environmentId !== subscribedEnvironmentId) return;
    let disposed = false;
    let detach: (() => void) | null = null;

    void runtime.adapter
      .subscribeTerminalFailures((failure: T3VoiceTerminalRuntimeFailureEvent) => {
        if (disposed) return;
        presentRuntimeFailure(failure, () =>
          runtime.adapter.acknowledgeTerminalFailure(failure.failureId),
        );
      })
      .then((release) => {
        if (disposed) release();
        else detach = release;
      })
      .catch((cause) => {
        if (!disposed) Alert.alert("Voice failure reporting unavailable", errorMessage(cause));
      });

    return () => {
      disposed = true;
      detach?.();
    };
  }, [applicationState, presentRuntimeFailure, runtimeRef, subscribedEnvironmentId]);
}

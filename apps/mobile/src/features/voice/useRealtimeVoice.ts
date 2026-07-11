import type { ProjectId, ThreadId, VoiceSessionCreateInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import { uuidv4 } from "../../lib/uuid";
import { usePreparedConnection } from "../../state/session";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import {
  RealtimeVoiceController,
  type RealtimeVoiceControllerSnapshot,
} from "./realtimeVoiceController";

const INITIAL_SNAPSHOT: RealtimeVoiceControllerSnapshot = {
  phase: "idle",
  session: null,
  native: null,
  error: null,
};

const errorReason = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "reason" in cause
    ? String((cause as { readonly reason: unknown }).reason)
    : null;

export function useRealtimeVoice(input: {
  readonly environmentId: Parameters<typeof usePreparedConnection>[0];
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const native = getT3VoiceNativeModule();
  const controllerRef = useRef<RealtimeVoiceController | null>(null);
  const handledConfirmationsRef = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let disposed = false;
    setAvailable(false);
    setSnapshot(INITIAL_SNAPSHOT);
    if (prepared === null || native === null) return;

    void (async () => {
      const client = await makeMobileVoiceClient(prepared);
      const [capabilities, media] = await Promise.all([
        Effect.runPromise(client.capabilities()),
        native.getMediaCapabilitiesAsync(),
      ]);
      if (disposed) return;
      const realtimeReady = capabilities.capabilities.some(
        (capability) => capability.capability === "agent.realtime" && capability.state === "ready",
      );
      if (!realtimeReady || !media.realtimeWebRtc) return;

      const controller = new RealtimeVoiceController(native, client, {
        onSnapshot: (next) => {
          if (!disposed) setSnapshot(next);
        },
        onSessionEvents: (events) => {
          for (const event of events) {
            if (event.type !== "confirmation-required") continue;
            if (handledConfirmationsRef.current.has(event.confirmationId)) continue;
            handledConfirmationsRef.current.add(event.confirmationId);
            const decide = (decision: "approve" | "reject") => {
              if (disposed) return;
              void Effect.runPromise(
                client.decideConfirmation(event.sessionId, event.confirmationId, decision),
              ).catch((cause) => {
                if (disposed) return;
                const message = cause instanceof Error ? cause.message : String(cause);
                Alert.alert(
                  "Voice action failed",
                  message,
                  [
                    { text: "Reject", onPress: () => decide("reject") },
                    { text: "Retry", onPress: () => decide(decision) },
                  ],
                  { cancelable: false },
                );
              });
            };
            Alert.alert(
              "Confirm voice action",
              event.summary,
              [
                {
                  text: "Reject",
                  style: "cancel",
                  onPress: () => decide("reject"),
                },
                { text: "Approve", onPress: () => decide("approve") },
              ],
              { cancelable: false },
            );
          }
        },
      });
      if (disposed) {
        await controller.dispose();
        return;
      }
      controllerRef.current = controller;
      setAvailable(true);
    })().catch((cause) => {
      if (!disposed) setAvailable(false);
    });

    return () => {
      disposed = true;
      setAvailable(false);
      handledConfirmationsRef.current.clear();
      const controller = controllerRef.current;
      controllerRef.current = null;
      if (controller !== null) void controller.dispose();
    };
  }, [native, prepared]);

  const start = useCallback(
    async (takeover = false) => {
      const controller = controllerRef.current;
      if (controller === null || prepared === null) return;
      const client = await makeMobileVoiceClient(prepared);
      const conversations = await Effect.runPromise(client.listConversations());
      const latestDurable = conversations
        .filter((conversation) => conversation.retention === "durable")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const sessionInput: VoiceSessionCreateInput = {
        mode: "realtime-agent",
        conversation:
          latestDurable === undefined
            ? { type: "new", retention: "durable", title: "T3 Voice" }
            : {
                type: "continue",
                conversationId: latestDurable.conversationId,
                takeover,
              },
        projectId: input.projectId,
        threadId: input.threadId,
        media: {
          transports: ["webrtc-sdp-v1"],
          audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
          supportsInputRouteSelection: true,
          supportsOutputRouteSelection: true,
        },
        idempotencyKey: uuidv4(),
      };
      try {
        await controller.start(sessionInput);
      } catch (cause) {
        if (!takeover && errorReason(cause) === "takeover-required") {
          Alert.alert(
            "Continue on this device?",
            "The voice conversation is active on another device.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Take Over", onPress: () => void start(true) },
            ],
          );
          return;
        }
        throw cause;
      }
    },
    [input.projectId, input.threadId, prepared],
  );

  const toggle = useCallback(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    if (snapshot.phase === "stopping") return;
    if (snapshot.phase === "active" || snapshot.phase === "starting") {
      void controller.stop();
      return;
    }
    Alert.alert(
      "AI voice conversation",
      "This call uses an AI-generated voice and may run confirmed T3 actions.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start",
          onPress: () => {
            void start().catch((cause) =>
              setSnapshot({
                ...INITIAL_SNAPSHOT,
                phase: "error",
                error: String(cause),
              }),
            );
          },
        },
      ],
    );
  }, [snapshot.phase, start]);

  const toggleMuted = useCallback(() => {
    const controller = controllerRef.current;
    if (controller === null || snapshot.native === null) return;
    void controller.setMuted(!snapshot.native.realtimeMuted);
  }, [snapshot.native]);

  return {
    available,
    phase: snapshot.phase,
    muted: snapshot.native?.realtimeMuted ?? false,
    error: snapshot.error,
    onToggle: toggle,
    onToggleMuted: toggleMuted,
  };
}

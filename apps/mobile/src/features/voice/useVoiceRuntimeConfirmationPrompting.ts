import type { VoiceRuntimeSnapshot } from "@t3tools/client-runtime/voice";
import { useEffect, useRef, type MutableRefObject } from "react";
import { Alert } from "react-native";

import type { VoiceRuntimeConnection } from "./useVoiceRuntimeFailurePresentation";
import { voiceErrorMessage as errorMessage } from "./voiceError";

export function useVoiceRuntimeConfirmationPrompting(input: {
  readonly snapshot: VoiceRuntimeSnapshot;
  readonly runtimeRef: MutableRefObject<VoiceRuntimeConnection | null>;
}): void {
  const { snapshot, runtimeRef } = input;
  const promptedConfirmationsRef = useRef(new Set<string>());

  useEffect(() => {
    if (snapshot.mode !== "realtime") return;
    const pendingIds = new Set<string>(
      snapshot.pendingConfirmations.map((item) => item.confirmationId),
    );
    for (const confirmationId of promptedConfirmationsRef.current) {
      if (!pendingIds.has(confirmationId)) {
        promptedConfirmationsRef.current.delete(confirmationId);
      }
    }
    const confirmation = snapshot.pendingConfirmations[0];
    if (
      confirmation === undefined ||
      promptedConfirmationsRef.current.has(confirmation.confirmationId)
    ) {
      return;
    }
    promptedConfirmationsRef.current.add(confirmation.confirmationId);
    const decide = (decision: "approve" | "reject") => {
      void runtimeRef.current?.adapter
        .decideRealtimeConfirmation(confirmation.confirmationId, decision)
        .catch((cause) => {
          promptedConfirmationsRef.current.delete(confirmation.confirmationId);
          Alert.alert("Voice confirmation failed", errorMessage(cause));
        });
    };
    Alert.alert(
      "Confirm voice action",
      confirmation.summary,
      [
        { text: "Reject", style: "cancel", onPress: () => decide("reject") },
        { text: "Approve", onPress: () => decide("approve") },
      ],
      { cancelable: false },
    );
  }, [runtimeRef, snapshot]);
}

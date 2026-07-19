import {
  admittedClientActionFocusState,
  voiceRealtimeContextsEqual,
  voiceThreadNavigationRequest,
  type AdmittedClientActionFocus,
  type VoiceRealtimeContext,
  type VoiceRuntimeFocus,
  type VoiceRuntimeSnapshot,
} from "@t3tools/client-runtime/voice";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { Alert } from "react-native";

import type { VoiceRuntimeConnection } from "./useVoiceRuntimeFailurePresentation";
import { voiceErrorMessage as errorMessage } from "./voiceError";

interface ThreadNavigator {
  navigate(
    name: "Thread",
    params: { readonly environmentId: string; readonly threadId: string },
  ): void;
}

export function useVoiceRuntimeClientActionNavigation(input: {
  readonly snapshot: VoiceRuntimeSnapshot;
  readonly visibleFocus: VoiceRuntimeFocus | null;
  readonly realtimeContext: VoiceRealtimeContext;
  readonly navigation: ThreadNavigator;
  readonly runtimeRef: MutableRefObject<VoiceRuntimeConnection | null>;
  readonly snapshotRef: MutableRefObject<VoiceRuntimeSnapshot>;
  readonly dismissOverlays: () => void;
}): void {
  const {
    snapshot,
    visibleFocus,
    realtimeContext,
    navigation,
    runtimeRef,
    snapshotRef,
    dismissOverlays,
  } = input;
  const handledClientActionsRef = useRef(new Set<string>());
  const admittedClientActionFocusRef = useRef<AdmittedClientActionFocus | null>(null);
  const handledThreadNavigationRef = useRef<string | null>(null);

  const acknowledgeAdmittedClientAction = useCallback(
    (admittedFocus: AdmittedClientActionFocus): boolean => {
      const runtime = runtimeRef.current;
      const current = snapshotRef.current;
      if (
        runtime === null ||
        current.mode !== "realtime" ||
        runtime.environmentId !== current.target.environmentId
      ) {
        return false;
      }
      admittedClientActionFocusRef.current = null;
      void runtime.adapter
        .completeRealtimeClientAction(admittedFocus.actionId, "succeeded")
        .catch((cause) =>
          Alert.alert("Voice navigation acknowledgement failed", errorMessage(cause)),
        );
      return true;
    },
    [runtimeRef, snapshotRef],
  );

  useEffect(() => {
    const runtime = runtimeRef.current;
    let admittedFocus = admittedClientActionFocusRef.current;
    if (
      admittedFocus !== null &&
      snapshot.mode === "realtime" &&
      !snapshot.pendingClientActions.some((action) => action.actionId === admittedFocus?.actionId)
    ) {
      admittedClientActionFocusRef.current = null;
      admittedFocus = null;
    }
    const admission = admittedClientActionFocusState(admittedFocus, visibleFocus);
    if (admission === "waiting") return;
    if (admission === "admitted" && admittedFocus !== null) {
      acknowledgeAdmittedClientAction(admittedFocus);
      return;
    }
    if (
      runtime === null ||
      snapshot.mode !== "realtime" ||
      runtime.environmentId !== snapshot.target.environmentId ||
      voiceRealtimeContextsEqual(snapshot.target, realtimeContext)
    ) {
      return;
    }
    void runtime.adapter
      .updateRealtimeContext(realtimeContext)
      .catch((cause) => Alert.alert("Voice focus unavailable", errorMessage(cause)));
  }, [acknowledgeAdmittedClientAction, realtimeContext, runtimeRef, snapshot, visibleFocus]);

  useEffect(() => {
    const request = voiceThreadNavigationRequest(snapshot);
    if (request === null) {
      handledThreadNavigationRef.current = null;
      return;
    }
    if (handledThreadNavigationRef.current === request.key) return;
    handledThreadNavigationRef.current = request.key;
    dismissOverlays();
    try {
      navigation.navigate("Thread", {
        environmentId: String(request.environmentId),
        threadId: String(request.threadId),
      });
    } catch (cause) {
      handledThreadNavigationRef.current = null;
      Alert.alert("Voice navigation failed", errorMessage(cause));
    }
  }, [dismissOverlays, navigation, snapshot]);

  useEffect(() => {
    if (snapshot.mode !== "realtime") {
      handledClientActionsRef.current.clear();
      admittedClientActionFocusRef.current = null;
      return;
    }
    const pendingIds = new Set<string>(
      snapshot.pendingClientActions.map((action) => action.actionId),
    );
    const admittedFocus = admittedClientActionFocusRef.current;
    if (admittedFocus !== null && !pendingIds.has(admittedFocus.actionId)) {
      admittedClientActionFocusRef.current = null;
    }
    for (const actionId of handledClientActionsRef.current) {
      if (!pendingIds.has(actionId)) handledClientActionsRef.current.delete(actionId);
    }
    for (const action of snapshot.pendingClientActions) {
      if (handledClientActionsRef.current.has(action.actionId)) continue;
      handledClientActionsRef.current.add(action.actionId);
      try {
        dismissOverlays();
        admittedClientActionFocusRef.current = {
          actionId: action.actionId,
          environmentId: snapshot.target.environmentId,
          projectId: action.projectId,
          threadId: action.threadId,
        };
        navigation.navigate("Thread", {
          environmentId: String(snapshot.target.environmentId),
          threadId: String(action.threadId),
        });
        const nextAdmittedFocus = admittedClientActionFocusRef.current;
        if (
          nextAdmittedFocus !== null &&
          admittedClientActionFocusState(nextAdmittedFocus, visibleFocus) === "admitted"
        ) {
          acknowledgeAdmittedClientAction(nextAdmittedFocus);
        }
      } catch (cause) {
        admittedClientActionFocusRef.current = null;
        void runtimeRef.current?.adapter
          .completeRealtimeClientAction(action.actionId, "failed", errorMessage(cause))
          .catch((acknowledgementCause) =>
            Alert.alert(
              "Voice navigation acknowledgement failed",
              errorMessage(acknowledgementCause),
            ),
          );
      }
    }
  }, [
    acknowledgeAdmittedClientAction,
    dismissOverlays,
    navigation,
    runtimeRef,
    snapshot,
    visibleFocus,
  ]);
}

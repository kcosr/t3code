import {
  VoiceModeSessionId,
  type EnvironmentId,
  type VoiceConversationId,
  type VoiceRuntimeSnapshot,
} from "@t3tools/contracts";
import type { VoiceHttpClient, VoiceRuntimeCommandRequest } from "@t3tools/client-runtime/voice";
import { useVoiceRuntimePresentation } from "@t3tools/client-runtime/voice/react";
import { VoiceRuntimePresentationBinding } from "@t3tools/client-runtime/voice";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { getT3VoiceNativeModule, type T3VoiceAudioRoute } from "@t3tools/mobile-voice-native";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Alert, AppState, View } from "react-native";
import { useNavigation } from "@react-navigation/native";

import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadShells } from "../../state/entities";
import { prepareConnectionOnDemand, usePreparedConnection } from "../../state/session";
import { androidVoiceRuntimeFactory } from "./androidVoiceRuntime";
import {
  canonicalVoiceViewModel,
  voiceMuteIntent,
  voiceRouteIntent,
  voiceStopIntent,
} from "./canonicalVoiceViewModel";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import { MasterVoiceContext, type AutonomousMasterVoiceContextValue } from "./MasterVoiceContext";
import { CanonicalMasterVoiceCallBar, VoiceAudioRoutePicker } from "./MasterVoiceOverlays";
import {
  makeNativeVoiceRuntimeProvisioningAdapter,
  NativeVoiceRuntimeProvisioningCoordinator,
} from "./nativeVoiceRuntimeProvisioning";
import {
  nativeVoiceRuntimeReadinessTargetId,
  resolveNativeVoiceRuntimeTarget,
} from "./nativeVoiceRuntimeTarget";
import {
  newVoiceConversationTitle,
  nextVoiceThreadTarget,
  type MasterVoiceFocus,
} from "./masterVoiceState";
import { resolveVoicePreferences } from "./voicePreferences";
import { NativeVoiceReceiptIndex } from "./nativeVoiceReceiptIndex";
import { VoiceConversationBrowser } from "./VoiceConversationBrowser";

const nativeReceiptIndex = new NativeVoiceReceiptIndex();

export const autonomousAndroidVoiceBinding = new VoiceRuntimePresentationBinding({
  runtime: androidVoiceRuntimeFactory,
  createCommandId: uuidv4,
  onEvent: (event) => {
    if (event.kind === "thread-receipt") {
      nativeReceiptIndex.recordReceipts([event.receipt]);
    }
  },
  onRebase: (rebase) => {
    nativeReceiptIndex.recordReceipts(rebase.threadReceipts);
  },
});

const waitForBindingGeneration = async (snapshot: VoiceRuntimeSnapshot): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = autonomousAndroidVoiceBinding.getSnapshot().snapshot;
    if (
      current?.runtimeId === snapshot.runtimeId &&
      current.runtimeInstanceId === snapshot.runtimeInstanceId &&
      current.generation === snapshot.generation
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The voice presentation did not attach to the current native authority.");
};

export function AutonomousAndroidMasterVoiceProvider(props: {
  readonly children: ReactNode;
  readonly environmentId: EnvironmentId | null;
  readonly focus: MasterVoiceFocus | null;
}) {
  const navigation = useNavigation();
  const native = getT3VoiceNativeModule();
  if (native === null) throw new Error("The autonomous Android voice runtime is unavailable.");

  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const threadShells = useThreadShells();
  const environmentId = props.focus?.environmentId ?? props.environmentId;
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = Option.getOrNull(preparedOption);
  const [applicationState, setApplicationState] = useState(AppState.currentState);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [audioRoutePicker, setAudioRoutePicker] =
    useState<Parameters<typeof VoiceAudioRoutePicker>[0]["state"]>(null);
  const [conversationClient, setConversationClient] = useState<VoiceHttpClient | null>(null);
  const focusDispatchRef = useRef<string | null>(null);
  const provisioningRef = useRef<NativeVoiceRuntimeProvisioningCoordinator | null>(null);
  const provisioningEpochRef = useRef(0);
  const provisioningQueueRef = useRef(Promise.resolve());
  const requestedConversationIdRef = useRef<VoiceConversationId | null>(null);
  const presentedConfirmationActionIdsRef = useRef(new Set<string>());
  const latestRef = useRef({
    preferences,
    threadShells,
    environmentId,
    focus: props.focus,
    prepared,
  });
  latestRef.current = { preferences, threadShells, environmentId, focus: props.focus, prepared };

  provisioningRef.current ??= new NativeVoiceRuntimeProvisioningCoordinator(
    makeNativeVoiceRuntimeProvisioningAdapter(native, uuidv4),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setApplicationState);
    return () => subscription.remove();
  }, []);
  const presentation = useVoiceRuntimePresentation(
    autonomousAndroidVoiceBinding,
    applicationState === "active" ? "foreground-active" : "background",
  );
  const runtimeSnapshot = presentation.snapshot;
  const receiptAssistantMessageIds = useSyncExternalStore(
    nativeReceiptIndex.subscribe,
    nativeReceiptIndex.getSnapshot,
    nativeReceiptIndex.getSnapshot,
  );
  const voice = useMemo(
    () => (runtimeSnapshot === null ? null : canonicalVoiceViewModel(runtimeSnapshot)),
    [runtimeSnapshot],
  );

  useEffect(() => {
    const target = nextVoiceThreadTarget(preferences?.voiceThreadTarget, props.focus);
    if (target !== null) savePreferences({ voiceThreadTarget: target });
  }, [preferences?.voiceThreadTarget, props.focus, savePreferences]);

  useEffect(() => {
    if (prepared === null) {
      setConversationClient(null);
      return;
    }
    let disposed = false;
    void makeMobileVoiceClient(prepared).then((client) => {
      if (!disposed) setConversationClient(client);
    });
    return () => {
      disposed = true;
    };
  }, [prepared]);

  const ensureMode = useCallback(
    (mode: "realtime" | "thread"): Promise<VoiceRuntimeSnapshot> => {
      let result!: VoiceRuntimeSnapshot;
      const operation = provisioningQueueRef.current.then(async () => {
        const latest = latestRef.current;
        if (latest.environmentId === null || latest.preferences === null) {
          throw new Error("Voice environment preferences are not ready.");
        }
        const connection =
          latest.prepared ?? (await prepareConnectionOnDemand(latest.environmentId));
        if (connection === null) throw new Error("The voice environment is unavailable.");
        const microphone = await native.getMicrophonePermissionAsync();
        const microphonePermission = microphone.granted
          ? microphone
          : await native.requestMicrophonePermissionAsync();
        if (!microphonePermission.granted) throw new Error("Microphone permission is required.");
        const notification = await native.getNotificationPermissionAsync();
        const client = await makeMobileVoiceClient(connection);
        const resolvedPreferences = resolveVoicePreferences(latest.preferences);
        const commonTarget = {
          client,
          environmentId: latest.environmentId,
          activeConversationId:
            requestedConversationIdRef.current ??
            (runtimeSnapshot?.target?.mode === "realtime"
              ? runtimeSnapshot.target.conversationId
              : null),
          focus: latest.focus,
          threadTarget: latest.preferences.voiceThreadTarget,
          threads: latest.threadShells,
          autoRearm: resolvedPreferences.autoListenEnabled,
        } as const;
        const target =
          mode === "thread"
            ? await resolveNativeVoiceRuntimeTarget({
                ...commonTarget,
                mode: "thread",
                endpointPolicy: {
                  endSilenceMs: resolvedPreferences.endSilenceMs,
                  noSpeechTimeoutMs: resolvedPreferences.noSpeechTimeoutMs,
                  maximumUtteranceMs: resolvedPreferences.maximumUtteranceMs,
                },
                speechEnabled: true,
                rearmGuardMs: resolvedPreferences.postPlaybackGuardMs,
              })
            : await resolveNativeVoiceRuntimeTarget({ ...commonTarget, mode: "realtime" });
        const readinessEnabled =
          latest.preferences.voiceNotificationControlsEnabled === true && notification.granted;
        const readiness = {
          enabled: readinessEnabled,
          mode,
          targetId: nativeVoiceRuntimeReadinessTargetId(target.target),
          audioRouteId: latest.preferences.voiceAudioRouteId ?? "system",
          autoRearm: resolvedPreferences.autoListenEnabled,
          microphonePermissionGranted: true,
          notificationPermissionGranted: notification.granted,
        } as const;
        provisioningEpochRef.current += 1;
        await provisioningRef.current!.provision(client, {
          epoch: provisioningEpochRef.current,
          readiness,
          environmentOrigin: new URL(connection.httpBaseUrl).origin,
          operation: mode === "realtime" ? "realtime-start" : "thread-turn-start",
          resolvedTarget: target,
        });
        const snapshot = await native.getVoiceRuntimeSnapshotAsync();
        await waitForBindingGeneration(snapshot);
        requestedConversationIdRef.current = null;
        result = snapshot;
      });
      provisioningQueueRef.current = operation.catch(() => undefined);
      return operation.then(() => result);
    },
    [native, runtimeSnapshot?.target],
  );

  const dispatch = useCallback(async (request: VoiceRuntimeCommandRequest): Promise<void> => {
    const receipt = await autonomousAndroidVoiceBinding.dispatch(request);
    if (receipt.outcome.type === "accepted") return;
    if (receipt.outcome.type === "rebase-required") {
      await waitForBindingGeneration(receipt.outcome.rebase.snapshot);
      const retry = await autonomousAndroidVoiceBinding.dispatch(request);
      if (retry.outcome.type === "accepted") return;
      throw new Error(
        retry.outcome.type === "rejected"
          ? `Voice command rejected: ${retry.outcome.reason}`
          : "Voice authority changed while retrying the command.",
      );
    }
    throw new Error(`Voice command rejected: ${receipt.outcome.reason}`);
  }, []);

  useEffect(() => {
    if (runtimeSnapshot?.operation.kind !== "realtime") return;
    const focus =
      props.focus === null
        ? null
        : { projectId: props.focus.projectId, threadId: props.focus.threadId };
    const key = `${runtimeSnapshot.operation.modeSessionId}:${focus?.projectId ?? "none"}:${focus?.threadId ?? "none"}`;
    if (focusDispatchRef.current === key) return;
    focusDispatchRef.current = key;
    void dispatch({
      kind: "update-realtime-focus",
      modeSessionId: runtimeSnapshot.operation.modeSessionId,
      focus,
    }).catch(() => {
      if (focusDispatchRef.current === key) focusDispatchRef.current = null;
    });
  }, [dispatch, props.focus, runtimeSnapshot]);

  const stop = useCallback(async (): Promise<void> => {
    const snapshot = autonomousAndroidVoiceBinding.getSnapshot().snapshot;
    if (snapshot === null) return;
    const intent = voiceStopIntent(
      snapshot,
      snapshot.operation.kind === "realtime" ? "drain" : "pause-after-turn",
    );
    if (intent !== null) await dispatch(intent);
  }, [dispatch]);

  useEffect(() => {
    const action = presentation.presentationAction;
    if (action?.action !== "navigate-thread") return;
    try {
      navigation.navigate("Thread", {
        environmentId: String(runtimeSnapshot?.target?.environmentId ?? ""),
        threadId: String(action.threadId),
      });
      autonomousAndroidVoiceBinding.completePresentationAction(action.actionId, {
        outcome: "succeeded",
      });
    } catch (cause) {
      autonomousAndroidVoiceBinding.completePresentationAction(action.actionId, {
        outcome: "failed",
        message: cause instanceof Error ? cause.message : "Thread navigation failed.",
      });
    }
  }, [navigation, presentation.presentationAction, runtimeSnapshot?.target]);

  useEffect(() => {
    const action = presentation.presentationAction;
    const controller = presentation.controller;
    if (action?.action !== "realtime-confirmation-required" || controller === null) return;
    if (presentedConfirmationActionIdsRef.current.has(action.actionId)) return;
    presentedConfirmationActionIdsRef.current.add(action.actionId);
    const decide = (decision: "approve" | "reject") => {
      const operation = autonomousAndroidVoiceBinding.getSnapshot().snapshot?.operation;
      if (operation?.kind !== "realtime") {
        autonomousAndroidVoiceBinding.completePresentationAction(action.actionId, {
          outcome: "failed",
          message: "Realtime voice is no longer active.",
        });
        return;
      }
      void dispatch({
        kind: "decide-realtime-confirmation",
        modeSessionId: operation.modeSessionId,
        lease: controller.lease,
        actionId: action.actionId,
        confirmationId: action.confirmationId,
        decision,
      })
        .then(() =>
          autonomousAndroidVoiceBinding.completePresentationAction(action.actionId, {
            outcome: "succeeded",
          }),
        )
        .catch((cause) =>
          autonomousAndroidVoiceBinding.completePresentationAction(action.actionId, {
            outcome: "failed",
            message: cause instanceof Error ? cause.message : "Confirmation failed.",
          }),
        );
    };
    if (controller.snapshot.operation.kind !== "realtime") {
      autonomousAndroidVoiceBinding.completePresentationAction(action.actionId, {
        outcome: "failed",
        message: "Realtime voice is no longer active.",
      });
      return;
    }
    Alert.alert(
      "Confirm voice action",
      action.summary,
      [
        { text: "Reject", style: "cancel", onPress: () => decide("reject") },
        { text: "Approve", onPress: () => decide("approve") },
      ],
      { cancelable: false },
    );
  }, [dispatch, presentation.controller, presentation.presentationAction]);

  const contextValue = useMemo<AutonomousMasterVoiceContextValue>(
    () => ({
      executionModel: "autonomous",
      snapshot: runtimeSnapshot,
      voice,
      presentationAction: presentation.presentationAction,
      draftArtifact: presentation.draftArtifact,
      dispatch,
      ensureMode,
      completePresentationAction: (actionId, outcome, message) => {
        autonomousAndroidVoiceBinding.completePresentationAction(actionId, {
          outcome,
          ...(message === undefined ? {} : { message }),
        });
      },
      completeDraftArtifact: (artifactId, outcome) => {
        autonomousAndroidVoiceBinding.completeDraftArtifact(artifactId, outcome);
      },
      stop,
      active: voice?.active === true,
      suppressAutomaticThreadSpeech:
        runtimeSnapshot?.operation.kind === "thread-turn" || voice?.active === true,
      nativeAssistantMessageIds: receiptAssistantMessageIds,
    }),
    [
      dispatch,
      ensureMode,
      presentation.draftArtifact,
      presentation.presentationAction,
      receiptAssistantMessageIds,
      runtimeSnapshot,
      stop,
      voice,
    ],
  );

  const resume = useCallback(async () => {
    const snapshot = await ensureMode("realtime");
    if (canonicalVoiceViewModel(snapshot).active) return;
    await dispatch({
      kind: "start-realtime",
      modeSessionId: VoiceModeSessionId.make(uuidv4()),
      interruptionPolicy: "drain-conflicting",
    });
  }, [dispatch, ensureMode]);

  const resumeConversation = useCallback(
    async (conversationId: VoiceConversationId) => {
      requestedConversationIdRef.current = conversationId;
      await ensureMode("realtime");
      await dispatch({
        kind: "start-realtime",
        modeSessionId: VoiceModeSessionId.make(uuidv4()),
        interruptionPolicy: "drain-conflicting",
      });
    },
    [dispatch, ensureMode],
  );

  const startNewConversation = useCallback(async () => {
    if (conversationClient === null) return;
    const created = await Effect.runPromise(
      conversationClient.createConversation({
        retention: "durable",
        title: newVoiceConversationTitle(),
      }),
    );
    await resumeConversation(created.conversationId);
  }, [conversationClient, resumeConversation]);

  const toggleMuted = useCallback(async () => {
    if (runtimeSnapshot === null) return;
    const intent = voiceMuteIntent(runtimeSnapshot, !voice?.muted);
    if (intent !== null) await dispatch(intent);
  }, [dispatch, runtimeSnapshot, voice?.muted]);

  const chooseAudioRoute = useCallback(async () => {
    const routes = await native.getAudioRoutesAsync();
    setAudioRoutePicker({
      routes,
      selectingRouteId: null,
      error: null,
    });
  }, [native, runtimeSnapshot?.route.outputRouteId]);

  const selectAudioRoute = useCallback(
    async (route: T3VoiceAudioRoute) => {
      if (runtimeSnapshot === null) return;
      const intent = voiceRouteIntent(runtimeSnapshot, {
        inputRouteId: runtimeSnapshot.route.inputRouteId,
        outputRouteId: route.id,
      });
      if (intent === null) return;
      setAudioRoutePicker((current) =>
        current === null ? null : { ...current, selectingRouteId: route.id, error: null },
      );
      try {
        await dispatch(intent);
        setAudioRoutePicker(null);
      } catch (cause) {
        setAudioRoutePicker((current) =>
          current === null
            ? null
            : {
                ...current,
                selectingRouteId: null,
                error: cause instanceof Error ? cause.message : String(cause),
              },
        );
      }
    },
    [dispatch, runtimeSnapshot],
  );

  return (
    <MasterVoiceContext.Provider value={contextValue}>
      <View className="flex-1">
        {props.children}
        <CanonicalMasterVoiceCallBar
          historyAvailable={conversationClient !== null}
          voice={voice}
          onHistory={() => setBrowserVisible(true)}
          onMute={() => void toggleMuted()}
          onRoute={() => void chooseAudioRoute()}
          onResume={() => void resume()}
          onStop={() => void stop()}
        />
      </View>
      <VoiceConversationBrowser
        visible={browserVisible}
        client={conversationClient}
        onClose={() => setBrowserVisible(false)}
        onNew={() => {
          setBrowserVisible(false);
          void startNewConversation();
        }}
        onResume={(conversationId) => {
          setBrowserVisible(false);
          void resumeConversation(conversationId);
        }}
      />
      <VoiceAudioRoutePicker
        state={audioRoutePicker}
        onClose={() => setAudioRoutePicker(null)}
        onSelect={selectAudioRoute}
      />
    </MasterVoiceContext.Provider>
  );
}

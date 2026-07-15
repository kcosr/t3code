import {
  VoiceModeSessionId,
  type EnvironmentId,
  type VoiceConversationId,
  type VoiceRuntimeRetainedRecordAcknowledgement,
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
import { savePreferencesPatch } from "../../persistence/imperative";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadShells } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails } from "../../state/threads";
import {
  getPreparedConnection,
  prepareConnectionOnDemand,
  usePreparedConnection,
} from "../../state/session";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { androidVoiceRuntimeFactory } from "./androidVoiceRuntime";
import { autonomousNativeVoiceReadinessAction } from "./autonomousNativeVoiceReadiness";
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
  NativeVoiceRuntimeReplacementDeferredError,
  NativeVoiceRuntimeProvisioningCoordinator,
  resolveNativeVoiceRuntimeRevocationEndpoint,
  StaleNativeVoiceRuntimeProvisioningEpochError,
} from "./nativeVoiceRuntimeProvisioning";
import { NativeVoiceReconciliationBackoff } from "./nativeVoiceReconciliationBackoff";
import { reconcilePendingNativeReadinessDisable } from "./nativeVoiceReadiness";
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
import {
  type NativeVoiceReceiptProjectionSource,
  waitForNativeVoiceReceiptProjection,
} from "./nativeVoiceReceiptProjection";
import {
  VoicePresentationGenerationWaitScope,
  waitForVoicePresentationGeneration,
} from "./voicePresentationGeneration";
import { VoiceConversationBrowser } from "./VoiceConversationBrowser";

const nativeReceiptIndex = new NativeVoiceReceiptIndex();
const nativeReceiptProjectionSource: NativeVoiceReceiptProjectionSource = {
  read: (receipt) =>
    appAtomRegistry.get(
      environmentThreadDetails.messagesAtom({
        environmentId: receipt.target.environmentId,
        threadId: receipt.target.threadId,
      }),
    ),
  subscribe: (receipt, listener) =>
    appAtomRegistry.subscribe(
      environmentThreadDetails.messagesAtom({
        environmentId: receipt.target.environmentId,
        threadId: receipt.target.threadId,
      }),
      listener,
    ),
};

const acknowledgeRetainedRecord = (
  current: Omit<VoiceRuntimeRetainedRecordAcknowledgement, "record">,
  record: VoiceRuntimeRetainedRecordAcknowledgement["record"],
): Promise<void> => {
  const native = getT3VoiceNativeModule();
  if (native === null) throw new Error("The Android voice runtime is not available.");
  return native.acknowledgeVoiceRuntimeRetainedRecordAsync({
    runtimeId: current.runtimeId,
    runtimeInstanceId: current.runtimeInstanceId,
    authorityGeneration: current.authorityGeneration,
    record,
  });
};

export const autonomousAndroidVoiceBinding = new VoiceRuntimePresentationBinding({
  runtime: androidVoiceRuntimeFactory,
  createCommandId: uuidv4,
  onEvent: async (event) => {
    if (event.kind === "thread-receipt") {
      nativeReceiptIndex.recordReceipts([event.receipt]);
      await waitForNativeVoiceReceiptProjection(event.receipt, nativeReceiptProjectionSource);
      await acknowledgeRetainedRecord(
        {
          runtimeId: event.runtimeId,
          runtimeInstanceId: event.runtimeInstanceId,
          authorityGeneration: event.authorityGeneration,
        },
        {
          kind: "thread-receipt",
          sourceRuntimeId: event.receipt.runtimeId,
          sourceRuntimeInstanceId: event.receipt.runtimeInstanceId,
          sourceRuntimeGeneration: event.receipt.runtimeGeneration,
          modeSessionId: event.receipt.modeSessionId,
          turnClientOperationId: event.receipt.turnClientOperationId,
        },
      );
    }
    if (event.kind === "realtime-terminal") {
      await acknowledgeRetainedRecord(
        {
          runtimeId: event.runtimeId,
          runtimeInstanceId: event.runtimeInstanceId,
          authorityGeneration: event.authorityGeneration,
        },
        {
          kind: "realtime-terminal",
          sourceRuntimeId: event.summary.runtimeId,
          sourceRuntimeInstanceId: event.summary.runtimeInstanceId,
          sourceRuntimeGeneration: event.summary.runtimeGeneration,
          modeSessionId: event.summary.modeSessionId,
        },
      );
    }
  },
  onRebase: async (rebase) => {
    nativeReceiptIndex.recordReceipts(rebase.threadReceipts);
    const current = {
      runtimeId: rebase.cursor.runtimeId,
      runtimeInstanceId: rebase.cursor.runtimeInstanceId,
      authorityGeneration: rebase.cursor.generation,
    };
    await Promise.all([
      ...rebase.threadReceipts.map(async (receipt) => {
        await waitForNativeVoiceReceiptProjection(receipt, nativeReceiptProjectionSource);
        await acknowledgeRetainedRecord(current, {
          kind: "thread-receipt",
          sourceRuntimeId: receipt.runtimeId,
          sourceRuntimeInstanceId: receipt.runtimeInstanceId,
          sourceRuntimeGeneration: receipt.runtimeGeneration,
          modeSessionId: receipt.modeSessionId,
          turnClientOperationId: receipt.turnClientOperationId,
        });
      }),
      ...rebase.realtimeTerminalSummaries.map((summary) =>
        acknowledgeRetainedRecord(current, {
          kind: "realtime-terminal",
          sourceRuntimeId: summary.runtimeId,
          sourceRuntimeInstanceId: summary.runtimeInstanceId,
          sourceRuntimeGeneration: summary.runtimeGeneration,
          modeSessionId: summary.modeSessionId,
        }),
      ),
    ]);
  },
});

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

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
  const { savedConnectionsById } = useSavedRemoteConnections();
  const threadShells = useThreadShells();
  const environmentId = props.focus?.environmentId ?? props.environmentId;
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = Option.getOrNull(preparedOption);
  const [applicationState, setApplicationState] = useState(AppState.currentState);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [audioRoutePicker, setAudioRoutePicker] =
    useState<Parameters<typeof VoiceAudioRoutePicker>[0]["state"]>(null);
  const [conversationClient, setConversationClient] = useState<VoiceHttpClient | null>(null);
  const [commandState, setCommandState] = useState<{
    readonly pendingLabel: string | null;
    readonly error: string | null;
  }>({ pendingLabel: null, error: null });
  const [rebasePendingCount, setRebasePendingCount] = useState(0);
  const [readinessRetry, setReadinessRetry] = useState(0);
  const commandEpochRef = useRef(0);
  const presentationWaitScopeRef = useRef(new VoicePresentationGenerationWaitScope());
  const focusDispatchRef = useRef<string | null>(null);
  const provisioningRef = useRef<NativeVoiceRuntimeProvisioningCoordinator | null>(null);
  const provisioningEpochRef = useRef(0);
  const provisioningQueueRef = useRef(Promise.resolve());
  const readinessReconciliationBackoffRef = useRef(new NativeVoiceReconciliationBackoff());
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
    makeNativeVoiceRuntimeProvisioningAdapter(native, async (authority) => {
      await autonomousAndroidVoiceBinding.configureAuthority(authority);
    }),
  );

  const resolveNativeRevocationEndpoint = useCallback(
    (environmentOrigin: string) =>
      resolveNativeVoiceRuntimeRevocationEndpoint({
        environmentOrigin,
        connections: Object.entries(savedConnectionsById).map(([id, connection]) => ({
          id: id as EnvironmentId,
          httpBaseUrl: connection.httpBaseUrl,
        })),
        getPrepared: getPreparedConnection,
        prepare: prepareConnectionOnDemand,
        makeClient: makeMobileVoiceClient,
      }),
    [savedConnectionsById],
  );

  useEffect(() => {
    if (presentationWaitScopeRef.current.disposed) {
      presentationWaitScopeRef.current = new VoicePresentationGenerationWaitScope();
      setCommandState({ pendingLabel: null, error: null });
      setRebasePendingCount(0);
    }
    const scope = presentationWaitScopeRef.current;
    return () => {
      scope.dispose();
      commandEpochRef.current += 1;
    };
  }, []);

  useEffect(
    () => () => {
      readinessReconciliationBackoffRef.current.cancel();
    },
    [],
  );

  useEffect(() => {
    const subscription = native.addListener("readinessDisabled", () => {
      setReadinessRetry((current) => current + 1);
    });
    return () => subscription.remove();
  }, [native]);

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
    void makeMobileVoiceClient(prepared)
      .then((client) => {
        if (!disposed) setConversationClient(client);
      })
      .catch((cause) => {
        if (!disposed) {
          setConversationClient(null);
          setCommandState({ pendingLabel: null, error: errorMessage(cause) });
        }
      });
    return () => {
      disposed = true;
    };
  }, [prepared]);

  const ensureMode = useCallback(
    (mode: "realtime" | "thread"): Promise<VoiceRuntimeSnapshot> => {
      const lifecycle = presentationWaitScopeRef.current;
      let result!: VoiceRuntimeSnapshot;
      const operation = provisioningQueueRef.current.then(async () => {
        lifecycle.throwIfDisposed();
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
          resolvedTarget: target,
          resolvePendingRevocationEndpoint: resolveNativeRevocationEndpoint,
          retireUnresolvableRevocation: true,
        });
        lifecycle.throwIfDisposed();
        const snapshot = await native.getVoiceRuntimeSnapshotAsync();
        await waitForVoicePresentationGeneration(autonomousAndroidVoiceBinding, snapshot, {
          signal: lifecycle.signal,
        });
        requestedConversationIdRef.current = null;
        result = snapshot;
      });
      provisioningQueueRef.current = operation.catch(() => undefined);
      return operation.then(() => result);
    },
    [native, resolveNativeRevocationEndpoint, runtimeSnapshot?.target],
  );

  useEffect(() => {
    let disposed = false;
    const operation = provisioningQueueRef.current.then(async () => {
      if (disposed) return;
      const latest = latestRef.current;

      const pendingDisable = await reconcilePendingNativeReadinessDisable({
        getPending: () => native.getPendingReadinessDisabledAsync(),
        persistDisabled: async () => {
          await savePreferencesPatch({ voiceNotificationControlsEnabled: false });
          savePreferences({ voiceNotificationControlsEnabled: false });
        },
        acknowledge: (event) =>
          native.acknowledgeReadinessDisabledAsync({
            readinessGeneration: event.readinessGeneration,
          }),
      });
      if (disposed || pendingDisable !== null) {
        readinessReconciliationBackoffRef.current.reset();
        return;
      }
      if (latest.preferences === null) return;

      const runtime = await native.getVoiceRuntimeSnapshotAsync();
      if (disposed || runtime.operation.kind !== "none") {
        readinessReconciliationBackoffRef.current.reset();
        return;
      }

      const controlsRequested = latest.preferences.voiceNotificationControlsEnabled === true;
      if (!controlsRequested) {
        const [authority, pendingRevocation] = await Promise.all([
          native.inspectVoiceRuntimeAuthorityAsync(),
          native.getPendingVoiceRuntimeAuthorityRevocationAsync(),
        ]);
        if (disposed) return;
        const action = autonomousNativeVoiceReadinessAction({
          authority,
          operationActive: false,
          revocationPending: pendingRevocation !== null,
          resolvedTarget: null,
        });
        if (action === "disable") {
          provisioningEpochRef.current += 1;
          const disabled = await provisioningRef.current!.disableIfIdle(
            provisioningEpochRef.current,
            {
              resolveEndpoint: resolveNativeRevocationEndpoint,
              retireUnresolvableRevocation: true,
            },
          );
          if (!disabled) {
            throw new NativeVoiceRuntimeReplacementDeferredError(authority?.environmentOrigin);
          }
        }
        readinessReconciliationBackoffRef.current.reset();
        return;
      }
      if (latest.environmentId === null) {
        readinessReconciliationBackoffRef.current.reset();
        return;
      }

      const connection = latest.prepared ?? (await prepareConnectionOnDemand(latest.environmentId));
      if (disposed) return;
      if (connection === null) {
        throw new Error("The voice environment is temporarily unavailable.");
      }

      const [client, microphone, notification, authority] = await Promise.all([
        makeMobileVoiceClient(connection),
        native.getMicrophonePermissionAsync(),
        native.getNotificationPermissionAsync(),
        native.inspectVoiceRuntimeAuthorityAsync(),
      ]);
      if (disposed) return;

      const controlsEnabled = microphone.granted && notification.granted;
      const resolvedPreferences = resolveVoicePreferences(latest.preferences);
      const defaultMode = latest.preferences.voiceNotificationDefaultMode ?? "realtime";
      const commonTarget = {
        client,
        environmentId: latest.environmentId,
        activeConversationId:
          runtime.target?.mode === "realtime" ? runtime.target.conversationId : null,
        focus: latest.focus,
        threadTarget: latest.preferences.voiceThreadTarget,
        threads: latest.threadShells,
        autoRearm: resolvedPreferences.autoListenEnabled,
      } as const;
      const target = !controlsEnabled
        ? null
        : defaultMode === "thread"
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
      if (disposed) return;

      const action = autonomousNativeVoiceReadinessAction({
        authority,
        operationActive: false,
        resolvedTarget: target,
      });
      if (action === "none") {
        readinessReconciliationBackoffRef.current.reset();
        return;
      }

      provisioningEpochRef.current += 1;
      const epoch = provisioningEpochRef.current;
      if (action === "disable") {
        const disabled = await provisioningRef.current!.disableIfIdle(epoch, {
          fallback: { client, environmentOrigin: new URL(connection.httpBaseUrl).origin },
          resolveEndpoint: resolveNativeRevocationEndpoint,
          retireUnresolvableRevocation: true,
        });
        if (!disabled) {
          throw new NativeVoiceRuntimeReplacementDeferredError(authority?.environmentOrigin);
        }
        readinessReconciliationBackoffRef.current.reset();
        return;
      }
      if (target === null) return;

      await provisioningRef.current!.provision(client, {
        epoch,
        readiness: {
          enabled: true,
          mode: target.target.mode,
          targetId: nativeVoiceRuntimeReadinessTargetId(target.target),
          audioRouteId: latest.preferences.voiceAudioRouteId ?? "system",
          autoRearm: resolvedPreferences.autoListenEnabled,
          microphonePermissionGranted: true,
          notificationPermissionGranted: true,
        },
        environmentOrigin: new URL(connection.httpBaseUrl).origin,
        resolvedTarget: target,
        resolvePendingRevocationEndpoint: resolveNativeRevocationEndpoint,
        retireUnresolvableRevocation: true,
      });
      readinessReconciliationBackoffRef.current.reset();
    });
    provisioningQueueRef.current = operation.catch(() => undefined);
    void operation.catch((cause: unknown) => {
      if (disposed || cause instanceof StaleNativeVoiceRuntimeProvisioningEpochError) return;
      console.warn("[voice] native readiness reconciliation failed", {
        error: errorMessage(cause),
      });
      const fallbackKey =
        environmentId === null ? "native-runtime:unowned" : `environment:${environmentId}`;
      readinessReconciliationBackoffRef.current.schedule(
        cause instanceof NativeVoiceRuntimeReplacementDeferredError
          ? (cause.reconciliationKey ?? fallbackKey)
          : fallbackKey,
        () => setReadinessRetry((current) => current + 1),
      );
    });
    return () => {
      disposed = true;
    };
  }, [
    native,
    prepared,
    preferences?.voiceAudioRouteId,
    preferences?.voiceAutoListenEnabled,
    preferences?.voiceEndSilenceMs,
    preferences?.voiceMaximumUtteranceMs,
    preferences?.voiceNoSpeechTimeoutMs,
    preferences?.voiceNotificationControlsEnabled,
    preferences?.voiceNotificationDefaultMode,
    preferences?.voicePostPlaybackGuardMs,
    preferences?.voiceThreadTarget,
    readinessRetry,
    resolveNativeRevocationEndpoint,
    savePreferences,
    environmentId,
    runtimeSnapshot?.operation.kind,
    threadShells,
  ]);

  const dispatch = useCallback(async (request: VoiceRuntimeCommandRequest): Promise<void> => {
    const lifecycle = presentationWaitScopeRef.current;
    lifecycle.throwIfDisposed();
    const receipt = await autonomousAndroidVoiceBinding.dispatch(request);
    lifecycle.throwIfDisposed();
    if (receipt.outcome.type === "accepted") return;
    if (receipt.outcome.type === "rebase-required") {
      if (presentationWaitScopeRef.current === lifecycle) {
        setRebasePendingCount((count) => count + 1);
      }
      try {
        await waitForVoicePresentationGeneration(
          autonomousAndroidVoiceBinding,
          receipt.outcome.rebase.snapshot,
          { signal: lifecycle.signal },
        );
        lifecycle.throwIfDisposed();
        const retry = await autonomousAndroidVoiceBinding.dispatch(request);
        lifecycle.throwIfDisposed();
        if (retry.outcome.type === "accepted") return;
        throw new Error(
          retry.outcome.type === "rejected"
            ? `Voice command rejected: ${retry.outcome.reason}`
            : "Voice authority changed while retrying the command.",
        );
      } finally {
        if (presentationWaitScopeRef.current === lifecycle && !lifecycle.disposed) {
          setRebasePendingCount((count) => Math.max(0, count - 1));
        }
      }
    }
    throw new Error(`Voice command rejected: ${receipt.outcome.reason}`);
  }, []);

  const runCommand = useCallback((pendingLabel: string, command: () => Promise<unknown>): void => {
    const lifecycle = presentationWaitScopeRef.current;
    if (lifecycle.disposed) return;
    const epoch = ++commandEpochRef.current;
    setCommandState({ pendingLabel, error: null });
    void command().then(
      () => {
        if (
          presentationWaitScopeRef.current === lifecycle &&
          !lifecycle.disposed &&
          commandEpochRef.current === epoch
        ) {
          setCommandState({ pendingLabel: null, error: null });
        }
      },
      (cause: unknown) => {
        if (
          presentationWaitScopeRef.current === lifecycle &&
          !lifecycle.disposed &&
          commandEpochRef.current === epoch
        ) {
          setCommandState({ pendingLabel: null, error: errorMessage(cause) });
        }
      },
    );
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
    const lifecycle = presentationWaitScopeRef.current;
    void dispatch({
      kind: "update-realtime-focus",
      modeSessionId: runtimeSnapshot.operation.modeSessionId,
      focus,
    }).then(
      () => {
        if (
          focusDispatchRef.current === key &&
          presentationWaitScopeRef.current === lifecycle &&
          !lifecycle.disposed
        ) {
          setCommandState((current) =>
            current.error === "Voice thread focus could not be updated."
              ? { ...current, error: null }
              : current,
          );
        }
      },
      () => {
        if (focusDispatchRef.current !== key) return;
        focusDispatchRef.current = null;
        if (presentationWaitScopeRef.current === lifecycle && !lifecycle.disposed) {
          setCommandState({
            pendingLabel: null,
            error: "Voice thread focus could not be updated.",
          });
        }
      },
    );
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
    const lifecycle = presentationWaitScopeRef.current;
    const decide = (decision: "approve" | "reject") => {
      if (presentationWaitScopeRef.current !== lifecycle || lifecycle.disposed) return;
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
        .catch((cause) => {
          if (presentationWaitScopeRef.current === lifecycle && !lifecycle.disposed) {
            setCommandState({ pendingLabel: null, error: errorMessage(cause) });
          }
          autonomousAndroidVoiceBinding.completePresentationAction(action.actionId, {
            outcome: "failed",
            message: errorMessage(cause),
          });
        });
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
        return autonomousAndroidVoiceBinding.completeDraftArtifact(artifactId, outcome);
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
    const lifecycle = presentationWaitScopeRef.current;
    lifecycle.throwIfDisposed();
    const routes = await native.getAudioRoutesAsync();
    if (presentationWaitScopeRef.current === lifecycle && !lifecycle.disposed) {
      setAudioRoutePicker({
        routes,
        selectingRouteId: null,
        error: null,
      });
    }
  }, [native, runtimeSnapshot?.route.outputRouteId]);

  const selectAudioRoute = useCallback(
    async (route: T3VoiceAudioRoute) => {
      const lifecycle = presentationWaitScopeRef.current;
      lifecycle.throwIfDisposed();
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
        if (presentationWaitScopeRef.current === lifecycle && !lifecycle.disposed) {
          setAudioRoutePicker(null);
        }
      } catch (cause) {
        if (presentationWaitScopeRef.current === lifecycle && !lifecycle.disposed) {
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
      }
    },
    [dispatch, runtimeSnapshot],
  );

  return (
    <MasterVoiceContext.Provider value={contextValue}>
      <View className="flex-1">
        {props.children}
        <CanonicalMasterVoiceCallBar
          commandError={
            commandState.error ??
            (presentation.phase === "error" && presentation.error !== null
              ? errorMessage(presentation.error)
              : null)
          }
          commandPendingLabel={
            rebasePendingCount > 0 ? "Synchronizing voice controls…" : commandState.pendingLabel
          }
          historyAvailable={conversationClient !== null}
          voice={voice}
          onHistory={() => setBrowserVisible(true)}
          onMute={() => runCommand("Updating microphone…", toggleMuted)}
          onRoute={() => runCommand("Loading audio routes…", chooseAudioRoute)}
          onResume={() => runCommand("Connecting voice…", resume)}
          onStop={() => runCommand("Stopping voice…", stop)}
        />
      </View>
      <VoiceConversationBrowser
        visible={browserVisible}
        client={conversationClient}
        onClose={() => setBrowserVisible(false)}
        onNew={() => {
          setBrowserVisible(false);
          runCommand("Starting conversation…", startNewConversation);
        }}
        onResume={(conversationId) => {
          setBrowserVisible(false);
          runCommand("Connecting voice…", () => resumeConversation(conversationId));
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

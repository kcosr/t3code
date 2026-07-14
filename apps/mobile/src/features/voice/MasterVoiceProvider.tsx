import {
  ThreadId,
  VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
  type EnvironmentId,
  type VoiceConfirmationId,
  type VoiceConversationId,
  type VoiceConversationSelection,
  type VoiceConversationSummary,
  type VoiceSessionCreateInput,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  T3VoiceAudioRoute,
  T3VoiceCommandEvent,
  T3VoiceThreadVoiceHandoffEvent,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, AppState, View } from "react-native";
import { useNavigation } from "@react-navigation/native";

import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import { uuidv4 } from "../../lib/uuid";
import { savePreferencesPatch } from "../../persistence/imperative";
import {
  getPreparedConnection,
  prepareConnectionOnDemand,
  usePreparedConnection,
} from "../../state/session";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  acknowledgeClientActionWithRetry,
  clientActionAcknowledgementInput,
  executeThreadActivation,
  isPendingVoiceEventLive,
} from "./clientActionAcknowledgement";
import {
  MasterVoiceCallBar,
  VoiceAudioRoutePicker,
  VoiceTranscriptModal,
  type MasterVoiceTranscriptTurn,
  type VoiceAudioRoutePickerState,
} from "./MasterVoiceOverlays";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import {
  completeNativeVoiceCommandAttempt,
  completeNativeVoiceCommandSafely,
  isNextNativeReadinessGeneration,
  NativeVoiceCommandCompletionGate,
  NativeVoiceCommandDeduplicator,
  NativeVoiceForegroundCommandGate,
  NativeVoiceControllerGeneration,
  NativeVoiceOperationEpoch,
  reconcilePendingNativeReadinessDisable,
  resolveNativeVoiceReadiness,
  scheduleNativeVoiceCommandFailure,
} from "./nativeVoiceReadiness";
import {
  makeNativeVoiceRuntimeProvisioningAdapter,
  NativeVoiceRuntimeReplacementDeferredError,
  nativeVoiceRuntimeRefreshAt,
  NativeVoiceRuntimeProvisioningCoordinator,
  resolveNativeVoiceRuntimeRevocationEndpoint,
} from "./nativeVoiceRuntimeProvisioning";
import { NativeVoiceReconciliationBackoff } from "./nativeVoiceReconciliationBackoff";
import { resolveNativeVoiceRuntimeTarget } from "./nativeVoiceRuntimeTarget";
import { VoiceConversationBrowser, type VoiceConversationClient } from "./VoiceConversationBrowser";
import {
  continueVoiceConversationSelection,
  durableVoiceConversations,
  masterVoiceControllerEnvironmentId,
  newVoiceConversationSelection,
  nextVoiceThreadTarget,
  reconcileMasterVoiceFocus,
  refreshMasterVoiceForeground,
  resumeVoiceConversationSelection,
  acceptNativeRealtimeOwnerState,
  restoreMasterVoiceAttachment,
  shouldRetireUnresolvableNativeVoiceOwner,
  shouldRevokeUnavailableVoiceEnvironment,
  VoiceFocusUpdateQueue,
  type NativeRealtimeOwnerState,
  type ActiveMasterVoiceAttachment,
  type MasterVoiceFocus,
} from "./masterVoiceState";
import {
  RealtimeControllerHandoff,
  RealtimeVoiceController,
  RealtimeServerCleanupCoordinator,
  type RealtimeVoiceControllerSnapshot,
} from "./realtimeVoiceController";
import { realtimeVoiceAttachmentStore } from "./realtimeVoiceAttachmentStore";

interface PendingVoiceConfirmation {
  readonly confirmationId: VoiceConfirmationId;
  readonly event: Extract<VoiceSessionEvent, { readonly type: "confirmation-required" }>;
  readonly deciding: boolean;
  readonly error: string | null;
}

interface MasterVoiceRuntime {
  readonly environmentId: EnvironmentId;
  readonly client: VoiceHttpClient;
  readonly controller: RealtimeVoiceController;
}

interface VoiceConversationConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentOrigin: string;
  readonly client: VoiceHttpClient;
}

interface MasterVoiceContextValue {
  readonly phase: RealtimeVoiceControllerSnapshot["phase"];
  readonly stop: () => Promise<void>;
  readonly registerTraditionalAudioInterruption: (
    interrupt: () => void | (() => void) | Promise<void | (() => void)>,
  ) => () => void;
  readonly threadVoiceHandoff:
    | (T3VoiceThreadVoiceHandoffEvent & {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
      })
    | null;
  readonly settleThreadVoiceHandoff: (
    actionId: string,
    outcome: "adopted" | "failed",
  ) => Promise<void>;
  readonly nativeThreadCommand:
    | (T3VoiceCommandEvent & {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
      })
    | null;
  readonly completeNativeThreadCommand: (
    commandId: string,
    outcome: "success" | "failure",
  ) => Promise<void>;
}

const INITIAL_SNAPSHOT: RealtimeVoiceControllerSnapshot = {
  phase: "idle",
  session: null,
  native: null,
  error: null,
  focus: null,
};

const MasterVoiceContext = createContext<MasterVoiceContextValue | null>(null);

const errorReason = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "reason" in cause
    ? String((cause as { readonly reason: unknown }).reason)
    : null;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const loadResumeSelection = async (
  client: VoiceHttpClient,
): Promise<VoiceConversationSelection> => {
  const conversations: Array<VoiceConversationSummary> = [];
  let cursor: string | undefined;
  let shouldLoad = true;
  do {
    const page = await Effect.runPromise(
      client.listConversations({
        ...(cursor === undefined ? {} : { cursor }),
        limit: VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
      }),
    );
    conversations.push(...page.conversations);
    if (page.nextCursor === null) {
      shouldLoad = false;
      continue;
    }

    const best = durableVoiceConversations(conversations)[0];
    const oldestUpdatedAt = page.conversations.at(-1)?.updatedAt;
    if (
      best !== undefined &&
      oldestUpdatedAt !== undefined &&
      (best.lastCallAt ?? best.createdAt).localeCompare(oldestUpdatedAt) >= 0
    )
      shouldLoad = false;
    cursor = page.nextCursor;
  } while (shouldLoad);
  return resumeVoiceConversationSelection(conversations);
};

export function MasterVoiceProvider(props: {
  readonly children: ReactNode;
  readonly environmentId: EnvironmentId | null;
  readonly focus: MasterVoiceFocus | null;
}) {
  const navigation = useNavigation();
  const native = getT3VoiceNativeModule();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const threadShells = useThreadShells();
  const projects = useProjects();
  const { isLoadingSavedConnection, savedConnectionsById } = useSavedRemoteConnections();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const [attachment, setAttachment] = useState<ActiveMasterVoiceAttachment | null>(null);
  const [availableEnvironmentId, setAvailableEnvironmentId] = useState<EnvironmentId | null>(null);
  const [conversationConnection, setConversationConnection] =
    useState<VoiceConversationConnection | null>(null);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [audioRoutePicker, setAudioRoutePicker] = useState<VoiceAudioRoutePickerState | null>(null);
  const [transcriptVisible, setTranscriptVisible] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const [threadVoiceHandoff, setThreadVoiceHandoff] =
    useState<MasterVoiceContextValue["threadVoiceHandoff"]>(null);
  const [nativeThreadCommand, setNativeThreadCommand] =
    useState<MasterVoiceContextValue["nativeThreadCommand"]>(null);
  const [transcript, setTranscript] = useState<ReadonlyArray<MasterVoiceTranscriptTurn>>([]);
  const [confirmations, setConfirmations] = useState<ReadonlyArray<PendingVoiceConfirmation>>([]);
  const [nativePermissions, setNativePermissions] = useState({
    microphone: null as boolean | null,
    notification: null as boolean | null,
  });
  const [nativeRealtimeOwner, setNativeRealtimeOwner] = useState<NativeRealtimeOwnerState>({
    checked: false,
    sequence: -1,
    sessionId: null,
    environmentOrigin: null,
  });
  const [readinessRetry, setReadinessRetry] = useState(0);
  const runtimeRef = useRef<MasterVoiceRuntime | null>(null);
  const nativeProvisioningEpochRef = useRef(0);
  const nativeGrantRefreshRequestedRef = useRef(false);
  const nativeGrantRefreshScheduleRef = useRef<{
    readonly key: string;
    readonly refreshAtEpochMillis: number;
  } | null>(null);
  const cleanupCoordinatorsRef = useRef(new Map<EnvironmentId, RealtimeServerCleanupCoordinator>());
  const controllerHandoffsRef = useRef(new Map<EnvironmentId, RealtimeControllerHandoff>());
  const startInFlightRef = useRef(false);
  const resumeInFlightRef = useRef(false);
  const focusUpdateQueueRef = useRef(new VoiceFocusUpdateQueue());
  const attachmentRef = useRef(attachment);
  const focusRef = useRef(props.focus);
  const threadShellsRef = useRef(threadShells);
  const pendingClientActionsRef = useRef(
    new Map<string, Extract<VoiceSessionEvent, { readonly type: "client-action" }>>(),
  );
  const acceptedThreadVoiceHandoffIdRef = useRef<string | null>(null);
  const settledThreadVoiceHandoffIdRef = useRef<string | null>(null);
  const traditionalAudioInterruptionsRef = useRef(
    new Set<() => void | (() => void) | Promise<void | (() => void)>>(),
  );
  const nativeControllerGenerationRef = useRef(new NativeVoiceControllerGeneration());
  const nativeReadinessGenerationRef = useRef<number | null>(null);
  const nativeOperationsRef = useRef(new NativeVoiceOperationEpoch());
  const nativeCommandsRef = useRef(new NativeVoiceCommandDeduplicator());
  const nativeThreadCompletionsRef = useRef(new NativeVoiceCommandCompletionGate());
  const nativeThreadCommandRef = useRef<MasterVoiceContextValue["nativeThreadCommand"]>(null);
  const nativeThreadTimeoutsRef = useRef(new Map<string, () => void>());
  const completeNativeThreadCommandRef = useRef<
    (commandId: string, outcome: "success" | "failure") => Promise<void>
  >(async () => undefined);
  const activeNativeEpochRef = useRef<number | null>(null);
  const resumeRef = useRef<() => Promise<boolean>>(async () => false);
  const readinessAlertVisibleRef = useRef(false);
  const nativeReconciliationBackoffRef = useRef(new NativeVoiceReconciliationBackoff());
  attachmentRef.current = attachment;
  focusRef.current = props.focus;
  threadShellsRef.current = threadShells;
  nativeThreadCommandRef.current = nativeThreadCommand;

  const preferences = Option.getOrNull(AsyncResult.value(preferencesResult));
  const voiceCuesEnabled = preferences === null ? null : preferences.voiceCuesEnabled !== false;
  const nativeReadinessInputsReady =
    preferences !== null &&
    nativePermissions.microphone !== null &&
    nativePermissions.notification !== null;
  const preferredAudioRouteId = preferences?.voiceAudioRouteId ?? null;

  useEffect(() => {
    if (native === null || voiceCuesEnabled === null) return;
    void native.setVoiceCuesEnabledAsync({ enabled: voiceCuesEnabled }).catch(() => undefined);
  }, [native, voiceCuesEnabled]);
  const preferredAudioRouteIdRef = useRef(preferredAudioRouteId);
  preferredAudioRouteIdRef.current = preferredAudioRouteId;

  const backgroundTargetEnvironmentId = preferences?.voiceThreadTarget?.environmentId ?? null;
  const backgroundTargetThreadId = preferences?.voiceThreadTarget?.threadId ?? null;
  const backgroundThreadTargetValid =
    backgroundTargetEnvironmentId !== null &&
    backgroundTargetThreadId !== null &&
    threadShells.some(
      (thread) =>
        String(thread.environmentId) === backgroundTargetEnvironmentId &&
        String(thread.id) === backgroundTargetThreadId &&
        thread.archivedAt === null &&
        projects.some(
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        ),
    );

  useEffect(() => {
    const target = nextVoiceThreadTarget(preferences?.voiceThreadTarget, props.focus);
    if (target !== null) savePreferences({ voiceThreadTarget: target });
  }, [
    preferences?.voiceThreadTarget,
    props.focus?.environmentId,
    props.focus?.threadId,
    savePreferences,
  ]);

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

  const nativeOwnerEnvironmentId =
    nativeRealtimeOwner.environmentOrigin === null
      ? null
      : ((Object.entries(savedConnectionsById).find(([, connection]) => {
          try {
            return new URL(connection.httpBaseUrl).origin === nativeRealtimeOwner.environmentOrigin;
          } catch {
            return false;
          }
        })?.[0] as EnvironmentId | undefined) ?? null);
  const nativeOwnerOriginUnavailable = shouldRetireUnresolvableNativeVoiceOwner({
    nativeOwnerChecked: nativeRealtimeOwner.checked,
    catalogLoading: isLoadingSavedConnection,
    environmentOrigin: nativeRealtimeOwner.environmentOrigin,
    environmentId: nativeOwnerEnvironmentId,
  });
  const nativeOwnerOriginPending =
    nativeRealtimeOwner.sessionId !== null && nativeRealtimeOwner.environmentOrigin === null;
  const controllerEnvironmentId = masterVoiceControllerEnvironmentId({
    nativeOwnerChecked: nativeRealtimeOwner.checked,
    nativeSessionId: nativeRealtimeOwner.sessionId,
    nativeOwnerEnvironmentId,
    nativeOwnerFallbackEnvironmentId: availableEnvironmentId,
    activeEnvironmentId: attachment?.environmentId ?? null,
    focus: props.focus,
    fallbackEnvironmentId: props.environmentId,
  });
  const nativeReconciliationKey =
    nativeRealtimeOwner.environmentOrigin ??
    (controllerEnvironmentId === null
      ? "native-runtime:unowned"
      : `environment:${controllerEnvironmentId}`);
  const scheduleNativeReconciliation = useCallback(
    (cause: NativeVoiceRuntimeReplacementDeferredError) => {
      nativeReconciliationBackoffRef.current.schedule(
        cause.reconciliationKey ?? nativeReconciliationKey,
        () => setReadinessRetry((current) => current + 1),
      );
    },
    [nativeReconciliationKey],
  );
  const prepared = Option.getOrNull(usePreparedConnection(controllerEnvironmentId));
  const controllerEnvironmentAvailable =
    controllerEnvironmentId !== null &&
    Object.hasOwn(savedConnectionsById, controllerEnvironmentId);
  const nativeReadiness = useMemo(
    () =>
      resolveNativeVoiceReadiness(
        preferences,
        controllerEnvironmentId === null ? null : String(controllerEnvironmentId),
        {
          microphonePermissionGranted: nativePermissions.microphone === true,
          notificationPermissionGranted: nativePermissions.notification === true,
          threadTargetValid: backgroundThreadTargetValid,
        },
      ),
    [
      backgroundTargetEnvironmentId,
      backgroundTargetThreadId,
      controllerEnvironmentId,
      preferences?.voiceAudioRouteId,
      preferences?.voiceAutoListenEnabled,
      preferences?.voiceBackgroundControlsEnabled,
      preferences?.voiceBackgroundDefaultMode,
      nativePermissions.microphone,
      nativePermissions.notification,
      backgroundThreadTargetValid,
    ],
  );

  useEffect(() => {
    nativeReconciliationBackoffRef.current.setKey(nativeReconciliationKey);
  }, [nativeReconciliationKey]);

  useEffect(
    () => () => {
      nativeReconciliationBackoffRef.current.reset();
    },
    [],
  );

  useEffect(() => {
    if (native === null) return;
    let disposed = false;
    const acceptState = (state: Awaited<ReturnType<typeof native.getStateAsync>>) => {
      setNativeRealtimeOwner((current) =>
        acceptNativeRealtimeOwnerState(current, {
          sequence: state.sequence,
          sessionId: state.activeRealtimeSessionId,
          environmentOrigin:
            state.activeRealtimeSessionId === current.sessionId ? current.environmentOrigin : null,
        }),
      );
    };
    const refreshOwnership = async (): Promise<string | null> => {
      const [state, ownership, persisted] = await Promise.all([
        native.getStateAsync(),
        native.getBackgroundVoiceOwnershipAsync(),
        realtimeVoiceAttachmentStore.load().catch(() => null),
      ]);
      if (disposed) return null;
      const ownershipIsNewest = ownership !== null && ownership.sequence >= state.sequence;
      const sessionId = ownershipIsNewest
        ? ownership.nativeSessionId
        : state.activeRealtimeSessionId;
      const ownedOrigin =
        ownershipIsNewest && ownership.nativeSessionId === sessionId
          ? new URL(ownership.environmentOrigin).origin
          : null;
      const persistedOrigin =
        persisted?.sessionId === sessionId ? persisted.environmentOrigin : null;
      setNativeRealtimeOwner((current) =>
        acceptNativeRealtimeOwnerState(current, {
          sequence: ownershipIsNewest ? ownership.sequence : state.sequence,
          sessionId,
          environmentOrigin: ownedOrigin ?? persistedOrigin,
        }),
      );
      return sessionId;
    };
    const reconcileForegroundRuntime = async () => {
      if (disposed) return;
      const runtime = runtimeRef.current;
      if (runtime === null) return;
      const phase = runtime.controller.getSnapshot().phase;
      if (phase === "starting" || phase === "stopping") return;
      await runtime.controller.reconcileNativeRuntime();
    };
    const refreshPermissions = async () => {
      const [microphone, notification] = await Promise.all([
        native.getMicrophonePermissionAsync(),
        native.getNotificationPermissionAsync(),
      ]);
      if (!disposed) {
        setNativePermissions({
          microphone: microphone.granted,
          notification: notification.granted,
        });
      }
    };
    const refreshAndReconcile = () => {
      void refreshMasterVoiceForeground({
        refreshPermissions,
        refreshOwnership,
        reconcileRuntime: reconcileForegroundRuntime,
        onPermissionsUnavailable: () => {
          if (!disposed) setNativePermissions({ microphone: null, notification: null });
        },
      });
    };
    void refreshAndReconcile();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshAndReconcile();
    });
    const nativeStateSubscription = native.addListener("stateChanged", (state) => {
      if (disposed) return;
      acceptState(state);
      refreshAndReconcile();
    });
    return () => {
      disposed = true;
      subscription.remove();
      nativeStateSubscription.remove();
    };
  }, [native]);
  const conversationClient: VoiceConversationClient | null =
    conversationConnection?.environmentId === controllerEnvironmentId
      ? conversationConnection.client
      : null;
  const nativeProvisioning = useMemo(() => {
    if (native === null) return null;
    return new NativeVoiceRuntimeProvisioningCoordinator(
      makeNativeVoiceRuntimeProvisioningAdapter(native, uuidv4),
    );
  }, [native]);

  useEffect(() => {
    if (native === null || prepared === null || controllerEnvironmentId === null) return;
    let disposed = false;
    const accept = (event: T3VoiceThreadVoiceHandoffEvent) => {
      if (disposed) return;
      if (event.environmentOrigin !== new URL(prepared.httpBaseUrl).origin) return;
      if (
        acceptedThreadVoiceHandoffIdRef.current === event.actionId ||
        settledThreadVoiceHandoffIdRef.current === event.actionId
      ) {
        return;
      }
      acceptedThreadVoiceHandoffIdRef.current = event.actionId;
      setThreadVoiceHandoff({
        ...event,
        environmentId: controllerEnvironmentId,
        threadId: ThreadId.make(event.threadId),
      });
      setBrowserVisible(false);
      setTranscriptVisible(false);
    };
    const subscription = native.addListener("threadVoiceHandoff", accept);
    const loadPending = () =>
      native
        .getPendingThreadVoiceHandoffAsync()
        .then((event) => {
          if (!disposed && event !== null) accept(event);
        })
        .catch(() => undefined);
    void loadPending();
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void loadPending();
    });
    return () => {
      disposed = true;
      subscription.remove();
      appStateSubscription.remove();
    };
  }, [controllerEnvironmentId, native, prepared]);

  useEffect(() => {
    if (threadVoiceHandoff === null) return;
    if (
      props.focus?.environmentId === threadVoiceHandoff.environmentId &&
      props.focus.projectId === threadVoiceHandoff.projectId &&
      props.focus.threadId === threadVoiceHandoff.threadId
    ) {
      return;
    }

    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const navigate = () => {
      if (disposed) return;
      navigation.navigate("Thread", {
        environmentId: String(threadVoiceHandoff.environmentId),
        threadId: String(threadVoiceHandoff.threadId),
      });
      retry = setTimeout(navigate, 300);
    };
    navigate();
    return () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
    };
  }, [
    navigation,
    props.focus?.environmentId,
    props.focus?.projectId,
    props.focus?.threadId,
    threadVoiceHandoff,
  ]);

  const acknowledgeClientAction = useCallback(
    async (
      event: Extract<VoiceSessionEvent, { readonly type: "client-action" }>,
      outcome: "succeeded" | "failed",
      message?: string,
    ) => {
      const runtime = runtimeRef.current;
      if (runtime === null) return;
      const expiresAtMillis = Date.parse(event.expiresAt);
      await acknowledgeClientActionWithRetry({
        expiresAtMillis,
        acknowledge: async (input) => {
          await runtime.controller.acknowledgeClientAction(event.actionId, input);
        },
        input: clientActionAcknowledgementInput(outcome, message),
        shouldContinue: () =>
          runtimeRef.current === runtime && pendingClientActionsRef.current.has(event.actionId),
      });
      pendingClientActionsRef.current.delete(event.actionId);
    },
    [],
  );

  const queueFocusUpdate = useCallback(
    (runtime: MasterVoiceRuntime, nextAttachment: ActiveMasterVoiceAttachment) =>
      focusUpdateQueueRef.current.enqueue(
        async () => {
          if (runtimeRef.current !== runtime || nextAttachment.focus === null)
            throw new Error("Voice environment changed during thread activation");
          await runtime.controller.updateFocus(
            nextAttachment.focus.projectId,
            nextAttachment.focus.threadId,
          );
          if (runtimeRef.current !== runtime || runtime.controller.getSnapshot().phase !== "active")
            throw new Error("Voice session ended during thread activation");
        },
        () => setAttachment(nextAttachment),
      ),
    [],
  );

  const handleSessionEvents = useCallback(
    (events: ReadonlyArray<VoiceSessionEvent>) => {
      for (const event of events) {
        if (event.type === "transcript" && event.final) {
          setTranscript((current) =>
            [...current, { role: event.role, text: event.text }].slice(-100),
          );
        } else if (event.type === "confirmation-required") {
          if (!isPendingVoiceEventLive(event.expiresAt)) continue;
          setConfirmations((current) =>
            current.some((confirmation) => confirmation.confirmationId === event.confirmationId)
              ? current
              : [
                  ...current,
                  {
                    confirmationId: event.confirmationId,
                    event,
                    deciding: false,
                    error: null,
                  },
                ],
          );
        } else if (event.type === "tool") {
          setConfirmations((current) =>
            current.filter((confirmation) => confirmation.event.toolCallId !== event.toolCallId),
          );
        } else if (event.type === "lease-fenced") {
          setConfirmations([]);
          pendingClientActionsRef.current.clear();
        } else if (event.type === "client-action" && event.action === "activate-thread") {
          if (!isPendingVoiceEventLive(event.expiresAt)) continue;
          if (pendingClientActionsRef.current.has(event.actionId)) continue;
          pendingClientActionsRef.current.set(event.actionId, event);
          const visibleFocus = focusRef.current;
          const attachedFocus = attachmentRef.current?.focus ?? null;
          if (
            visibleFocus?.projectId === event.projectId &&
            visibleFocus.threadId === event.threadId &&
            attachedFocus?.projectId === event.projectId &&
            attachedFocus.threadId === event.threadId
          ) {
            void acknowledgeClientAction(event, "succeeded");
            continue;
          }
          setBrowserVisible(false);
          setTranscriptVisible(false);
          const runtime = runtimeRef.current;
          if (runtime === null) {
            void acknowledgeClientAction(event, "failed", "Voice environment is unavailable");
            continue;
          }
          void executeThreadActivation({
            navigate: () =>
              navigation.navigate("Thread", {
                environmentId: String(runtime.environmentId),
                threadId: String(event.threadId),
              }),
            updateFocus: async () => {
              const threadTitle =
                threadShellsRef.current.find(
                  (thread) =>
                    thread.environmentId === runtime.environmentId && thread.id === event.threadId,
                )?.title ?? "Thread";
              await queueFocusUpdate(runtime, {
                environmentId: runtime.environmentId,
                focus: {
                  environmentId: runtime.environmentId,
                  projectId: event.projectId,
                  threadId: event.threadId,
                  threadTitle,
                },
              });
            },
            acknowledge: (outcome, message) => acknowledgeClientAction(event, outcome, message),
            errorMessage,
          }).catch(() => undefined);
        }
      }
    },
    [acknowledgeClientAction, navigation, queueFocusUpdate],
  );

  useEffect(() => {
    let disposed = false;
    setConversationConnection(null);
    if (controllerEnvironmentId === null || prepared === null) return;

    void (async () => {
      const client = await makeMobileVoiceClient(prepared);
      if (disposed) return;
      setConversationConnection({
        environmentId: controllerEnvironmentId,
        environmentOrigin: new URL(prepared.httpBaseUrl).origin,
        client,
      });
    })().catch(() => {
      if (!disposed) setConversationConnection(null);
    });

    return () => {
      disposed = true;
      setConversationConnection(null);
    };
  }, [controllerEnvironmentId, prepared]);

  useEffect(() => {
    let disposed = false;
    setAvailableEnvironmentId(null);
    if (
      controllerEnvironmentId === null ||
      conversationConnection?.environmentId !== controllerEnvironmentId ||
      prepared === null ||
      native === null
    )
      return;

    const client = conversationConnection.client;
    const environmentOrigin = prepared.httpBaseUrl;
    let handoffReservation: ReturnType<RealtimeControllerHandoff["reserve"]> | null = null;
    let publishedRuntime: MasterVoiceRuntime | null = null;
    void (async () => {
      const [capabilities, media] = await Promise.all([
        Effect.runPromise(client.capabilities()),
        native.getMediaCapabilitiesAsync(),
      ]);
      if (disposed) return;
      const realtimeReady = capabilities.capabilities.some(
        (capability) => capability.capability === "agent.realtime" && capability.state === "ready",
      );
      if (!realtimeReady || !media.realtimeWebRtc) return;
      let controllerHandoff = controllerHandoffsRef.current.get(controllerEnvironmentId);
      if (controllerHandoff === undefined) {
        controllerHandoff = new RealtimeControllerHandoff();
        controllerHandoffsRef.current.set(controllerEnvironmentId, controllerHandoff);
      }
      handoffReservation = controllerHandoff.reserve();
      await handoffReservation.ready;
      if (disposed) {
        handoffReservation.release();
        return;
      }
      let cleanupCoordinator = cleanupCoordinatorsRef.current.get(controllerEnvironmentId);
      if (cleanupCoordinator === undefined) {
        cleanupCoordinator = new RealtimeServerCleanupCoordinator();
        cleanupCoordinatorsRef.current.set(controllerEnvironmentId, cleanupCoordinator);
      }
      const controller = new RealtimeVoiceController(
        native,
        client,
        environmentOrigin,
        {
          onSnapshot: (next) => {
            if (disposed) return;
            setSnapshot(next);
            if (next.phase === "idle") {
              setAttachment(null);
              setConfirmations([]);
              pendingClientActionsRef.current.clear();
            }
            if (next.phase !== "active") setAudioRoutePicker(null);
            if (next.phase === "active") {
              if (attachmentRef.current === null) {
                setAttachment(
                  restoreMasterVoiceAttachment({
                    environmentId: controllerEnvironmentId,
                    persistedFocus: next.focus,
                    visibleFocus: focusRef.current,
                    threadTitle: (threadId) =>
                      threadShellsRef.current.find(
                        (thread) =>
                          thread.environmentId === controllerEnvironmentId &&
                          thread.id === threadId,
                      )?.title ?? "Thread",
                  }),
                );
              }
              savePreferences({ voiceMode: "realtime" });
            } else if (next.phase === "idle" || next.phase === "error") {
              savePreferences({ voiceMode: "off" });
            }
          },
          onSessionEvents: handleSessionEvents,
          onAudioRouteChanged: (event) => {
            if (event.reason !== "selected-route-unavailable") return;
            savePreferences({ voiceAudioRouteId: event.routeId });
            void controller
              .getAudioRoutes()
              .then((routes) => {
                if (disposed) return;
                setAudioRoutePicker((current) =>
                  current === null ? null : { routes, selectingRouteId: null, error: null },
                );
              })
              .catch(() => undefined);
          },
        },
        {
          cleanupCoordinator,
          attachmentStore: realtimeVoiceAttachmentStore,
          preferredAudioRouteId: () => preferredAudioRouteIdRef.current ?? "system",
        },
      );
      try {
        await controller.reconcileNativeRuntime();
      } catch (cause) {
        const activeNativeSessionId = controller.getSnapshot().native?.activeRealtimeSessionId;
        if (activeNativeSessionId === null || activeNativeSessionId === undefined) {
          await controller.detach();
          throw cause;
        }
      }
      if (disposed) {
        await controller.detach();
        handoffReservation?.release();
        return;
      }
      const runtime: MasterVoiceRuntime = {
        environmentId: controllerEnvironmentId,
        client,
        controller,
      };
      publishedRuntime = runtime;
      runtimeRef.current = runtime;
      setAvailableEnvironmentId(controllerEnvironmentId);
    })().catch(async () => {
      if (publishedRuntime !== null)
        await publishedRuntime.controller.detach().catch(() => undefined);
      handoffReservation?.release();
      if (!disposed) setAvailableEnvironmentId(null);
    });

    return () => {
      disposed = true;
      setAvailableEnvironmentId(null);
      const runtime = runtimeRef.current;
      if (runtime?.environmentId !== controllerEnvironmentId || runtime !== publishedRuntime)
        return;
      runtimeRef.current = null;
      void runtime.controller
        .detach()
        .catch(() => undefined)
        .finally(() => handoffReservation?.release());
    };
  }, [
    controllerEnvironmentId,
    conversationConnection,
    handleSessionEvents,
    native,
    savePreferences,
  ]);

  useEffect(() => {
    if (
      nativeProvisioning === null ||
      nativeOwnerOriginPending ||
      (!nativeOwnerOriginUnavailable &&
        !shouldRevokeUnavailableVoiceEnvironment({
          nativeOwnerChecked: nativeRealtimeOwner.checked,
          environmentId: controllerEnvironmentId,
          catalogLoading: isLoadingSavedConnection,
          environmentAvailable: controllerEnvironmentAvailable,
        }))
    ) {
      return;
    }
    const removedEnvironmentId = controllerEnvironmentId;
    const provisioningEpoch = ++nativeProvisioningEpochRef.current;
    let disposed = false;
    void (async () => {
      const disabled = await nativeProvisioning.disableIfIdle(provisioningEpoch, {
        ...(conversationConnection === null
          ? {}
          : {
              fallback: {
                client: conversationConnection.client,
                environmentOrigin: conversationConnection.environmentOrigin,
              },
            }),
        resolveEndpoint: resolveNativeRevocationEndpoint,
        retireUnresolvableRevocation: true,
      });
      if (!disabled) return;
      nativeReconciliationBackoffRef.current.reset();
      if (
        removedEnvironmentId === null ||
        attachmentRef.current?.environmentId === removedEnvironmentId
      ) {
        setAttachment(null);
      }
    })().catch((cause) => {
      if (disposed || !(cause instanceof NativeVoiceRuntimeReplacementDeferredError)) return;
      scheduleNativeReconciliation(cause);
    });
    return () => {
      disposed = true;
    };
  }, [
    controllerEnvironmentAvailable,
    controllerEnvironmentId,
    conversationConnection,
    isLoadingSavedConnection,
    nativeProvisioning,
    nativeRealtimeOwner.checked,
    nativeOwnerOriginUnavailable,
    nativeOwnerOriginPending,
    readinessRetry,
    resolveNativeRevocationEndpoint,
    scheduleNativeReconciliation,
  ]);

  useEffect(() => {
    const current = attachmentRef.current;
    const reconciliation = reconcileMasterVoiceFocus(current, props.focus);
    if (reconciliation.type === "stop") {
      focusUpdateQueueRef.current.invalidate();
      void runtimeRef.current?.controller.stop();
      return;
    }
    if (reconciliation.type === "refresh") {
      setAttachment(reconciliation.attachment);
      return;
    }
    if (reconciliation.type !== "update") return;

    const runtime = runtimeRef.current;
    const nextAttachment = reconciliation.attachment;
    if (runtime === null || runtime.environmentId !== nextAttachment.environmentId) return;
    void queueFocusUpdate(runtime, nextAttachment)
      .then(async (committed) => {
        if (!committed) return;
        const actions = [...pendingClientActionsRef.current.values()].filter(
          (candidate) =>
            candidate.projectId === nextAttachment.focus?.projectId &&
            candidate.threadId === nextAttachment.focus?.threadId,
        );
        await Promise.all(actions.map((action) => acknowledgeClientAction(action, "succeeded")));
      })
      .catch(async (cause) => {
        if (runtimeRef.current !== runtime) return;
        const actions = [...pendingClientActionsRef.current.values()].filter(
          (candidate) =>
            candidate.projectId === nextAttachment.focus?.projectId &&
            candidate.threadId === nextAttachment.focus?.threadId,
        );
        await Promise.all(
          actions.map((action) => acknowledgeClientAction(action, "failed", errorMessage(cause))),
        );
        await runtime.controller.stop();
        Alert.alert(
          "Voice conversation ended",
          `Could not update thread focus. ${errorMessage(cause)}`,
        );
      });
  }, [acknowledgeClientAction, props.focus, queueFocusUpdate]);

  const interruptTraditionalAudio = useCallback(async () => {
    const releases: Array<void | (() => void)> = [];
    try {
      const interruptions = Array.from(traditionalAudioInterruptionsRef.current);
      for (const interrupt of interruptions) {
        releases.push(await interrupt());
      }
    } catch (cause) {
      for (const release of releases.toReversed()) {
        if (typeof release === "function") release();
      }
      throw cause;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases) {
        if (typeof release === "function") release();
      }
    };
  }, []);

  const start = useCallback(
    async (
      conversation: VoiceConversationSelection,
      takeover = false,
      existingAudioRelease?: () => void,
      ownsStartLock = false,
    ) => {
      const focus = props.focus;
      const runtime = runtimeRef.current;
      if (
        (!ownsStartLock && startInFlightRef.current) ||
        runtime === null ||
        (focus !== null && runtime.environmentId !== focus.environmentId)
      ) {
        existingAudioRelease?.();
        return;
      }
      if (!ownsStartLock) startInFlightRef.current = true;
      let releaseTraditionalAudio = existingAudioRelease ?? null;
      try {
        releaseTraditionalAudio ??= await interruptTraditionalAudio();
        setTranscript([]);
        const sessionInput: VoiceSessionCreateInput = {
          mode: "realtime-agent",
          conversation:
            conversation.type === "continue" ? { ...conversation, takeover } : conversation,
          ...(focus === null ? {} : { projectId: focus.projectId, threadId: focus.threadId }),
          media: {
            transports: ["webrtc-sdp-v1"],
            audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
            supportsInputRouteSelection: true,
            supportsOutputRouteSelection: true,
          },
          idempotencyKey: uuidv4(),
        };
        setAttachment({ environmentId: runtime.environmentId, focus });
        await runtime.controller.start(sessionInput);
        const routeId = preferredAudioRouteIdRef.current;
        if (routeId !== null) {
          const routes = await runtime.controller.getAudioRoutes().catch(() => []);
          const preferredRoute = routes.find((route) => route.id === routeId);
          if (preferredRoute !== undefined && !preferredRoute.selected) {
            await runtime.controller.setAudioRoute(preferredRoute.id).catch(() => undefined);
          }
        }
      } catch (cause) {
        releaseTraditionalAudio?.();
        if (
          !takeover &&
          conversation.type === "continue" &&
          errorReason(cause) === "takeover-required"
        ) {
          Alert.alert(
            "Continue on this device?",
            "This conversation is active on another device.",
            [
              {
                text: "Cancel",
                style: "cancel",
                onPress: () => void runtime.controller.stop(),
              },
              {
                text: "Take Over",
                onPress: () => void start(conversation, true),
              },
            ],
            { cancelable: false },
          );
          return;
        }
        if (
          conversation.type === "continue" &&
          errorReason(cause) === "voice_conversation_not_found"
        ) {
          await runtime.controller.stop();
          Alert.alert(
            "Conversation no longer available",
            "It may have been deleted on another device. The conversation list has been refreshed.",
          );
          setBrowserVisible(true);
          return;
        }
        Alert.alert("Voice conversation failed", errorMessage(cause));
      } finally {
        startInFlightRef.current = false;
      }
    },
    [interruptTraditionalAudio, props.focus],
  );

  const resume = useCallback(async (): Promise<boolean> => {
    const runtime = runtimeRef.current;
    if (
      resumeInFlightRef.current ||
      startInFlightRef.current ||
      snapshot.phase !== "idle" ||
      runtime === null
    )
      return false;
    resumeInFlightRef.current = true;
    startInFlightRef.current = true;
    setResumePending(true);
    try {
      const releaseTraditionalAudio = await interruptTraditionalAudio();
      try {
        const selection = await loadResumeSelection(runtime.client);
        await start(selection, false, releaseTraditionalAudio, true);
        return runtime.controller.getSnapshot().phase === "active";
      } catch (cause) {
        releaseTraditionalAudio();
        throw cause;
      }
    } catch (cause) {
      Alert.alert("Voice conversation unavailable", errorMessage(cause));
      return false;
    } finally {
      startInFlightRef.current = false;
      resumeInFlightRef.current = false;
      setResumePending(false);
    }
  }, [interruptTraditionalAudio, snapshot.phase, start]);
  resumeRef.current = resume;

  useEffect(() => {
    if (
      native === null ||
      nativeProvisioning === null ||
      controllerEnvironmentId === null ||
      conversationConnection === null ||
      !nativeReadinessInputsReady ||
      !nativeRealtimeOwner.checked ||
      nativeOwnerOriginUnavailable ||
      (!isLoadingSavedConnection && !controllerEnvironmentAvailable) ||
      nativeRealtimeOwner.sessionId !== null
    )
      return;
    const readiness = nativeReadiness;
    let disposed = false;
    let registeredGeneration: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const epoch = nativeOperationsRef.current.begin();
    const provisioningEpoch = ++nativeProvisioningEpochRef.current;
    activeNativeEpochRef.current = epoch;

    const completeCommand = (event: T3VoiceCommandEvent, outcome: "success" | "failure") =>
      completeNativeVoiceCommandSafely(
        () =>
          nativeOperationsRef.current.run(epoch, () =>
            native.completeVoiceCommandAsync({
              commandId: event.commandId,
              controllerGeneration: event.controllerGeneration,
              outcome,
            }),
          ),
        () => nativeCommandsRef.current.release(event.commandId),
      );

    const runCommand = (event: T3VoiceCommandEvent) => {
      if (
        disposed ||
        !nativeOperationsRef.current.isCurrent(epoch) ||
        !nativeControllerGenerationRef.current.accepts(event)
      )
        return;
      if (readiness.mode === "realtime") {
        const runtime = runtimeRef.current;
        if (runtime === null || runtime.controller.getSnapshot().phase !== "idle") {
          void completeCommand(event, "failure");
          return;
        }
        void completeNativeVoiceCommandAttempt(event, resumeRef.current, (input) =>
          completeCommand(event, input.outcome),
        ).catch(() => undefined);
        return;
      }
      if (
        backgroundTargetEnvironmentId === null ||
        backgroundTargetThreadId === null ||
        controllerEnvironmentId === null ||
        backgroundTargetEnvironmentId !== String(controllerEnvironmentId)
      ) {
        void completeCommand(event, "failure");
        return;
      }
      const command = {
        ...event,
        environmentId: controllerEnvironmentId,
        threadId: ThreadId.make(backgroundTargetThreadId),
      };
      try {
        nativeThreadCommandRef.current = command;
        nativeThreadCompletionsRef.current.begin(command.commandId);
        nativeThreadTimeoutsRef.current.set(
          command.commandId,
          scheduleNativeVoiceCommandFailure(command.commandId, 10_000, (commandId) => {
            void completeNativeThreadCommandRef.current(commandId, "failure");
          }),
        );
        setNativeThreadCommand(command);
        navigation.navigate("Thread", {
          environmentId: backgroundTargetEnvironmentId,
          threadId: backgroundTargetThreadId,
        });
      } catch {
        void completeNativeThreadCommandRef.current(event.commandId, "failure");
      }
    };
    const foregroundCommands = new NativeVoiceForegroundCommandGate<T3VoiceCommandEvent>(
      300,
      runCommand,
    );
    foregroundCommands.setActive(AppState.currentState === "active");
    const acceptCommand = (event: T3VoiceCommandEvent) => {
      if (
        disposed ||
        !nativeOperationsRef.current.isCurrent(epoch) ||
        !nativeControllerGenerationRef.current.accepts(event) ||
        !nativeCommandsRef.current.claim(event.commandId)
      )
        return;
      foregroundCommands.enqueue(event, readiness.mode);
    };
    const subscription = native.addListener("voiceCommand", acceptCommand);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      foregroundCommands.setActive(state === "active");
    });
    const disabledSubscription = native.addListener("readinessDisabled", (event) => {
      if (!nativeOperationsRef.current.isCurrent(epoch)) return;
      const currentGeneration = nativeReadinessGenerationRef.current;
      if (!isNextNativeReadinessGeneration(currentGeneration, event.readinessGeneration)) {
        return;
      }
      void nativeOperationsRef.current
        .run(epoch, async () => {
          await savePreferencesPatch({ voiceBackgroundControlsEnabled: false });
          nativeOperationsRef.current.assertCurrent(epoch);
          savePreferences({ voiceBackgroundControlsEnabled: false });
          nativeReadinessGenerationRef.current = event.readinessGeneration;
          await native.acknowledgeReadinessDisabledAsync({
            readinessGeneration: event.readinessGeneration,
          });
        })
        .catch((cause) => {
          if (disposed || readinessAlertVisibleRef.current) return;
          readinessAlertVisibleRef.current = true;
          Alert.alert(
            "Background voice controls not disabled",
            `The preference could not be saved. ${errorMessage(cause)}`,
            [
              {
                text: "Retry",
                onPress: () => {
                  readinessAlertVisibleRef.current = false;
                  setReadinessRetry((current) => current + 1);
                },
              },
            ],
            { cancelable: false },
          );
        });
    });

    void nativeOperationsRef.current
      .run(epoch, async () => {
        const pendingDisable = await reconcilePendingNativeReadinessDisable({
          getPending: () => native.getPendingReadinessDisabledAsync(),
          persistDisabled: async (event) => {
            await savePreferencesPatch({ voiceBackgroundControlsEnabled: false });
            nativeOperationsRef.current.assertCurrent(epoch);
            nativeReadinessGenerationRef.current = event.readinessGeneration;
            savePreferences({ voiceBackgroundControlsEnabled: false });
          },
          acknowledge: (event) =>
            native.acknowledgeReadinessDisabledAsync({
              readinessGeneration: event.readinessGeneration,
            }),
        });
        nativeOperationsRef.current.assertCurrent(epoch);
        const readinessToPersist =
          pendingDisable === null ? readiness : { ...readiness, enabled: false };
        if (!readinessToPersist.enabled || prepared === null) {
          await nativeProvisioning.disable(provisioningEpoch, {
            client: conversationConnection.client,
            environmentOrigin: conversationConnection.environmentOrigin,
          });
          nativeOperationsRef.current.assertCurrent(epoch);
          nativeGrantRefreshRequestedRef.current = false;
          nativeGrantRefreshScheduleRef.current = null;
          return;
        }
        const attachedFocus = attachmentRef.current?.focus ?? null;
        const resolvedTarget = await resolveNativeVoiceRuntimeTarget({
          client: conversationConnection!.client,
          mode: readinessToPersist.mode,
          environmentId: controllerEnvironmentId,
          activeConversationId: snapshot.session?.conversationId ?? null,
          focus: snapshot.session === null ? focusRef.current : attachedFocus,
          threadTarget: preferences?.voiceThreadTarget,
          threads: threadShellsRef.current,
          autoRearm: readinessToPersist.autoRearm,
        });
        nativeOperationsRef.current.assertCurrent(epoch);
        const exactReadiness = {
          ...readinessToPersist,
          targetId:
            resolvedTarget.target.mode === "realtime"
              ? String(resolvedTarget.target.conversation.conversationId)
              : `${controllerEnvironmentId}/${resolvedTarget.target.threadId}`,
        };
        const provisioned = await nativeProvisioning.provision(conversationConnection.client, {
          epoch: provisioningEpoch,
          readiness: exactReadiness,
          environmentOrigin: new URL(prepared.httpBaseUrl).origin,
          operation:
            resolvedTarget.target.mode === "realtime" ? "realtime-start" : "thread-turn-start",
          resolvedTarget,
          refreshRequested: nativeGrantRefreshRequestedRef.current,
          resolvePendingRevocationEndpoint: resolveNativeRevocationEndpoint,
          retireUnresolvableRevocation: true,
        });
        nativeOperationsRef.current.assertCurrent(epoch);
        nativeReconciliationBackoffRef.current.reset();
        if (nativeGrantRefreshRequestedRef.current) {
          nativeGrantRefreshRequestedRef.current = false;
          nativeGrantRefreshScheduleRef.current = null;
        }
        const expiresAtEpochMillis = Date.parse(provisioned.expiresAt);
        const refreshKey = `${provisioned.runtimeId}:${provisioned.readinessGeneration}:${expiresAtEpochMillis}`;
        const existingSchedule = nativeGrantRefreshScheduleRef.current;
        const schedule =
          existingSchedule?.key === refreshKey
            ? existingSchedule
            : {
                key: refreshKey,
                refreshAtEpochMillis: nativeVoiceRuntimeRefreshAt(expiresAtEpochMillis, Date.now()),
              };
        nativeGrantRefreshScheduleRef.current = schedule;
        const scheduleRefresh = () => {
          if (disposed) return;
          const remaining = schedule.refreshAtEpochMillis - Date.now();
          if (remaining > 0) {
            refreshTimer = setTimeout(scheduleRefresh, Math.min(remaining, 2_147_000_000));
            return;
          }
          nativeGrantRefreshRequestedRef.current = true;
          setReadinessRetry((current) => current + 1);
        };
        scheduleRefresh();
        nativeReadinessGenerationRef.current = provisioned.readinessGeneration;
        if (disposed) return;
        const generation = nativeControllerGenerationRef.current.register(
          provisioned.readinessGeneration,
        );
        registeredGeneration = generation;
        await native.registerVoiceControllerAsync({ controllerGeneration: generation });
        nativeOperationsRef.current.assertCurrent(epoch);
        const pending = await native.getPendingVoiceCommandAsync();
        nativeOperationsRef.current.assertCurrent(epoch);
        if (pending !== null) acceptCommand(pending);
      })
      .catch((cause) => {
        if (cause instanceof NativeVoiceRuntimeReplacementDeferredError) {
          if (!disposed) scheduleNativeReconciliation(cause);
          return;
        }
        if (disposed || readinessAlertVisibleRef.current) return;
        readinessAlertVisibleRef.current = true;
        Alert.alert(
          "Background voice controls unavailable",
          errorMessage(cause),
          [
            {
              text: "Disable",
              style: "destructive",
              onPress: () => {
                readinessAlertVisibleRef.current = false;
                savePreferences({ voiceBackgroundControlsEnabled: false });
              },
            },
            {
              text: "Retry",
              onPress: () => {
                readinessAlertVisibleRef.current = false;
                setReadinessRetry((current) => current + 1);
              },
            },
          ],
          { cancelable: false },
        );
      });

    return () => {
      disposed = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      foregroundCommands.dispose();
      const pendingThreadCommand = nativeThreadCommandRef.current;
      if (
        pendingThreadCommand !== null &&
        nativeThreadCompletionsRef.current.claim(pendingThreadCommand.commandId)
      ) {
        nativeThreadTimeoutsRef.current.get(pendingThreadCommand.commandId)?.();
        nativeThreadTimeoutsRef.current.delete(pendingThreadCommand.commandId);
        nativeThreadCommandRef.current = null;
        setNativeThreadCommand((current) =>
          current?.commandId === pendingThreadCommand.commandId ? null : current,
        );
        void completeNativeVoiceCommandSafely(
          () =>
            native.completeVoiceCommandAsync({
              commandId: pendingThreadCommand.commandId,
              controllerGeneration: pendingThreadCommand.controllerGeneration,
              outcome: "failure",
            }),
          () => nativeCommandsRef.current.release(pendingThreadCommand.commandId),
        );
      }
      nativeOperationsRef.current.invalidate(epoch);
      nativeCommandsRef.current.clear();
      nativeThreadCompletionsRef.current.clear();
      for (const cancel of nativeThreadTimeoutsRef.current.values()) cancel();
      nativeThreadTimeoutsRef.current.clear();
      nativeThreadCommandRef.current = null;
      if (activeNativeEpochRef.current === epoch) activeNativeEpochRef.current = null;
      subscription.remove();
      appStateSubscription.remove();
      disabledSubscription.remove();
      setNativeThreadCommand(null);
      if (registeredGeneration === null) return;
      nativeControllerGenerationRef.current.invalidate(registeredGeneration);
      void nativeOperationsRef.current.runCleanup(() =>
        native.unregisterVoiceControllerAsync({
          controllerGeneration: registeredGeneration!,
        }),
      );
    };
  }, [
    attachment?.focus?.environmentId,
    attachment?.focus?.projectId,
    attachment?.focus?.threadId,
    backgroundTargetEnvironmentId,
    backgroundTargetThreadId,
    controllerEnvironmentId,
    controllerEnvironmentAvailable,
    conversationConnection,
    isLoadingSavedConnection,
    native,
    nativeProvisioning,
    nativeReadiness,
    nativeReadinessInputsReady,
    nativeRealtimeOwner.checked,
    nativeRealtimeOwner.sessionId,
    nativeOwnerOriginUnavailable,
    navigation,
    prepared,
    preferences?.voiceThreadTarget,
    props.focus?.environmentId,
    props.focus?.projectId,
    props.focus?.threadId,
    readinessRetry,
    resolveNativeRevocationEndpoint,
    scheduleNativeReconciliation,
    savePreferences,
    snapshot.session?.conversationId,
  ]);

  const completeNativeThreadCommand = useCallback(
    async (commandId: string, outcome: "success" | "failure") => {
      const command = nativeThreadCommandRef.current;
      if (
        native === null ||
        command?.commandId !== commandId ||
        !nativeThreadCompletionsRef.current.claim(commandId)
      )
        return;
      nativeThreadTimeoutsRef.current.get(commandId)?.();
      nativeThreadTimeoutsRef.current.delete(commandId);
      nativeThreadCommandRef.current = null;
      setNativeThreadCommand((current) => (current?.commandId === commandId ? null : current));
      await completeNativeVoiceCommandSafely(
        () =>
          native.completeVoiceCommandAsync({
            commandId,
            controllerGeneration: command.controllerGeneration,
            outcome,
          }),
        () => nativeCommandsRef.current.release(commandId),
      );
    },
    [native],
  );
  completeNativeThreadCommandRef.current = completeNativeThreadCommand;

  const browseHistory = useCallback(() => {
    if (
      conversationClient === null ||
      snapshot.phase !== "idle" ||
      startInFlightRef.current ||
      resumeInFlightRef.current
    )
      return;
    setBrowserVisible(true);
  }, [conversationClient, snapshot.phase]);

  const startNew = useCallback(() => {
    if (snapshot.phase !== "idle" || startInFlightRef.current || resumeInFlightRef.current) return;
    void start(newVoiceConversationSelection());
  }, [snapshot.phase, start]);

  const resumeConversation = useCallback(
    (conversationId: VoiceConversationId) => {
      if (snapshot.phase !== "idle" || startInFlightRef.current || resumeInFlightRef.current)
        return;
      void start(continueVoiceConversationSelection(conversationId));
    },
    [snapshot.phase, start],
  );

  const toggleMuted = useCallback(() => {
    const controller = runtimeRef.current?.controller;
    if (controller === undefined || snapshot.native === null) return;
    void controller
      .setMuted(!snapshot.native.realtimeMuted)
      .catch((cause) => Alert.alert("Microphone unavailable", errorMessage(cause)));
  }, [snapshot.native]);

  const chooseAudioRoute = useCallback(() => {
    const controller = runtimeRef.current?.controller;
    if (controller === undefined) return;
    setAudioRoutePicker({ routes: null, selectingRouteId: null, error: null });
    void controller
      .getAudioRoutes()
      .then((routes) =>
        setAudioRoutePicker((current) =>
          current === null ? null : { routes, selectingRouteId: null, error: null },
        ),
      )
      .catch((cause) =>
        setAudioRoutePicker((current) =>
          current === null
            ? null
            : {
                routes: [],
                selectingRouteId: null,
                error: errorMessage(cause),
              },
        ),
      );
  }, []);

  const selectAudioRoute = useCallback(
    (route: T3VoiceAudioRoute) => {
      const controller = runtimeRef.current?.controller;
      if (controller === undefined) return;
      if (route.selected) {
        savePreferences({ voiceAudioRouteId: route.id });
        return;
      }
      setAudioRoutePicker((current) =>
        current === null ? null : { ...current, selectingRouteId: route.id, error: null },
      );
      void controller
        .setAudioRoute(route.id)
        .then((routes) => {
          savePreferences({ voiceAudioRouteId: route.id });
          setAudioRoutePicker((current) =>
            current === null ? null : { routes, selectingRouteId: null, error: null },
          );
        })
        .catch((cause) =>
          setAudioRoutePicker((current) =>
            current === null
              ? null
              : {
                  ...current,
                  selectingRouteId: null,
                  error: errorMessage(cause),
                },
          ),
        );
    },
    [savePreferences],
  );

  const stop = useCallback(async () => {
    if (
      snapshot.phase === "error" &&
      typeof snapshot.native?.activeRealtimeSessionId !== "string"
    ) {
      setSnapshot(INITIAL_SNAPSHOT);
      setAttachment(null);
      return;
    }
    await runtimeRef.current?.controller.stop();
  }, [snapshot.native?.activeRealtimeSessionId, snapshot.phase]);

  const retryAttachment = useCallback(() => {
    const controller = runtimeRef.current?.controller;
    if (controller === undefined || typeof snapshot.native?.activeRealtimeSessionId !== "string")
      return;
    void controller.reconcileNativeRuntime().catch(() => undefined);
  }, [snapshot.native?.activeRealtimeSessionId]);

  const registerTraditionalAudioInterruption = useCallback(
    (interrupt: () => void | (() => void) | Promise<void | (() => void)>) => {
      traditionalAudioInterruptionsRef.current.add(interrupt);
      return () => traditionalAudioInterruptionsRef.current.delete(interrupt);
    },
    [],
  );

  const decideConfirmation = useCallback(
    (confirmation: PendingVoiceConfirmation, decision: "approve" | "reject") => {
      const runtime = runtimeRef.current;
      if (runtime === null || confirmation.deciding) return;
      setConfirmations((current) =>
        current.map((item) =>
          item.confirmationId === confirmation.confirmationId
            ? { ...item, deciding: true, error: null }
            : item,
        ),
      );
      void runtime.controller
        .decideConfirmation(confirmation.confirmationId, decision)
        .then(() =>
          setConfirmations((current) =>
            current.filter((item) => item.confirmationId !== confirmation.confirmationId),
          ),
        )
        .catch((cause) =>
          setConfirmations((current) =>
            current.map((item) =>
              item.confirmationId === confirmation.confirmationId
                ? { ...item, deciding: false, error: errorMessage(cause) }
                : item,
            ),
          ),
        );
    },
    [],
  );

  const pendingConfirmation = confirmations[0] ?? null;
  useEffect(() => {
    if (pendingConfirmation === null || pendingConfirmation.deciding) return;
    Alert.alert(
      "Confirm voice action",
      pendingConfirmation.error === null
        ? pendingConfirmation.event.summary
        : `${pendingConfirmation.event.summary}\n\n${pendingConfirmation.error}`,
      [
        {
          text: "Reject",
          style: "cancel",
          onPress: () => decideConfirmation(pendingConfirmation, "reject"),
        },
        {
          text: pendingConfirmation.error === null ? "Approve" : "Retry",
          onPress: () => decideConfirmation(pendingConfirmation, "approve"),
        },
      ],
      { cancelable: false },
    );
  }, [decideConfirmation, pendingConfirmation]);

  const contextValue = useMemo<MasterVoiceContextValue>(
    () => ({
      phase: snapshot.phase,
      stop,
      registerTraditionalAudioInterruption,
      threadVoiceHandoff,
      nativeThreadCommand,
      completeNativeThreadCommand,
      settleThreadVoiceHandoff: async (actionId, outcome) => {
        if (native === null) throw new Error("The native voice runtime is unavailable");
        await native.acknowledgeThreadVoiceHandoffAsync({ actionId, outcome });
        settledThreadVoiceHandoffIdRef.current = actionId;
        setThreadVoiceHandoff((current) => (current?.actionId === actionId ? null : current));
        if (acceptedThreadVoiceHandoffIdRef.current === actionId) {
          acceptedThreadVoiceHandoffIdRef.current = null;
        }
      },
    }),
    [
      completeNativeThreadCommand,
      native,
      nativeThreadCommand,
      registerTraditionalAudioInterruption,
      snapshot.phase,
      stop,
      threadVoiceHandoff,
    ],
  );

  return (
    <MasterVoiceContext.Provider value={contextValue}>
      <View className="flex-1">
        {props.children}
        <MasterVoiceCallBar
          historyAvailable={conversationClient !== null}
          callAvailable={availableEnvironmentId === controllerEnvironmentId && native !== null}
          snapshot={snapshot}
          attachment={attachment}
          transcript={transcript}
          onMute={toggleMuted}
          onRoute={chooseAudioRoute}
          onTranscript={() => setTranscriptVisible(true)}
          onResume={resume}
          resumePending={resumePending}
          onHistory={browseHistory}
          onRetryAttachment={retryAttachment}
          onStop={() => void stop()}
        />
      </View>
      <VoiceConversationBrowser
        visible={browserVisible}
        client={conversationClient}
        onClose={() => setBrowserVisible(false)}
        onNew={startNew}
        onResume={resumeConversation}
      />
      <VoiceTranscriptModal
        visible={transcriptVisible}
        turns={transcript}
        onClose={() => setTranscriptVisible(false)}
      />
      <VoiceAudioRoutePicker
        state={audioRoutePicker}
        onClose={() => setAudioRoutePicker(null)}
        onSelect={selectAudioRoute}
      />
    </MasterVoiceContext.Provider>
  );
}

export function useMasterVoice(): MasterVoiceContextValue {
  const context = use(MasterVoiceContext);
  if (context === null) throw new Error("useMasterVoice must be used inside MasterVoiceProvider");
  return context;
}

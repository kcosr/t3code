import {
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
import type { T3VoiceAudioRoute } from "@t3tools/mobile-voice-native";
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
import { Alert, View } from "react-native";
import { useNavigation } from "@react-navigation/native";

import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import { uuidv4 } from "../../lib/uuid";
import { usePreparedConnection } from "../../state/session";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  acknowledgeClientActionWithRetry,
  clientActionAcknowledgementInput,
} from "./clientActionAcknowledgement";
import {
  MasterVoiceCallBar,
  VoiceAudioRoutePicker,
  VoiceTranscriptModal,
  type MasterVoiceTranscriptTurn,
  type VoiceAudioRoutePickerState,
} from "./MasterVoiceOverlays";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import { VoiceConversationBrowser, type VoiceConversationClient } from "./VoiceConversationBrowser";
import {
  continueVoiceConversationSelection,
  durableVoiceConversations,
  masterVoiceEnvironmentId,
  newVoiceConversationSelection,
  reconcileMasterVoiceFocus,
  resumeVoiceConversationSelection,
  type ActiveMasterVoiceAttachment,
  type MasterVoiceFocus,
} from "./masterVoiceState";
import {
  RealtimeVoiceController,
  type RealtimeVoiceControllerSnapshot,
} from "./realtimeVoiceController";

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
  readonly client: VoiceHttpClient;
}

interface MasterVoiceContextValue {
  readonly phase: RealtimeVoiceControllerSnapshot["phase"];
  readonly stop: () => Promise<void>;
  readonly registerTraditionalAudioInterruption: (
    interrupt: () => void | (() => void) | Promise<void | (() => void)>,
  ) => () => void;
}

const INITIAL_SNAPSHOT: RealtimeVoiceControllerSnapshot = {
  phase: "idle",
  session: null,
  native: null,
  error: null,
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
  const [transcript, setTranscript] = useState<ReadonlyArray<MasterVoiceTranscriptTurn>>([]);
  const [confirmations, setConfirmations] = useState<ReadonlyArray<PendingVoiceConfirmation>>([]);
  const runtimeRef = useRef<MasterVoiceRuntime | null>(null);
  const startInFlightRef = useRef(false);
  const resumeInFlightRef = useRef(false);
  const focusUpdateGenerationRef = useRef(0);
  const focusUpdateTailRef = useRef(Promise.resolve());
  const attachmentRef = useRef(attachment);
  const focusRef = useRef(props.focus);
  const pendingClientActionsRef = useRef(
    new Map<string, Extract<VoiceSessionEvent, { readonly type: "client-action" }>>(),
  );
  const traditionalAudioInterruptionsRef = useRef(
    new Set<() => void | (() => void) | Promise<void | (() => void)>>(),
  );
  attachmentRef.current = attachment;
  focusRef.current = props.focus;

  const preferences = Option.getOrNull(AsyncResult.value(preferencesResult));
  const preferredAudioRouteId = preferences?.voiceAudioRouteId ?? null;
  const preferredAudioRouteIdRef = useRef(preferredAudioRouteId);
  preferredAudioRouteIdRef.current = preferredAudioRouteId;

  const controllerEnvironmentId = masterVoiceEnvironmentId(
    attachment?.environmentId ?? null,
    props.focus,
    props.environmentId,
  );
  const prepared = Option.getOrNull(usePreparedConnection(controllerEnvironmentId));
  const conversationClient: VoiceConversationClient | null =
    conversationConnection?.environmentId === controllerEnvironmentId
      ? conversationConnection.client
      : null;

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

  const handleSessionEvents = useCallback(
    (events: ReadonlyArray<VoiceSessionEvent>) => {
      for (const event of events) {
        if (event.type === "transcript" && event.final) {
          setTranscript((current) =>
            [...current, { role: event.role, text: event.text }].slice(-100),
          );
        } else if (event.type === "confirmation-required") {
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
          try {
            setBrowserVisible(false);
            setTranscriptVisible(false);
            const runtimeEnvironmentId = runtimeRef.current?.environmentId;
            if (runtimeEnvironmentId === undefined) {
              void acknowledgeClientAction(event, "failed", "Voice environment is unavailable");
              continue;
            }
            navigation.navigate("Thread", {
              environmentId: String(runtimeEnvironmentId),
              threadId: String(event.threadId),
            });
          } catch (cause) {
            void acknowledgeClientAction(event, "failed", errorMessage(cause));
          }
        }
      }
    },
    [acknowledgeClientAction, navigation],
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
      native === null
    )
      return;

    const client = conversationConnection.client;
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
      const controller = new RealtimeVoiceController(native, client, {
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
      });
      try {
        await controller.reconcileNativeRuntime();
      } catch (cause) {
        await controller.dispose();
        throw cause;
      }
      if (disposed) {
        await controller.dispose();
        return;
      }
      const runtime = {
        environmentId: controllerEnvironmentId,
        client,
        controller,
      };
      runtimeRef.current = runtime;
      setAvailableEnvironmentId(controllerEnvironmentId);
    })().catch(() => {
      if (!disposed) setAvailableEnvironmentId(null);
    });

    return () => {
      disposed = true;
      setAvailableEnvironmentId(null);
      const runtime = runtimeRef.current;
      if (runtime?.environmentId !== controllerEnvironmentId) return;
      runtimeRef.current = null;
      void runtime.controller.dispose();
    };
  }, [
    controllerEnvironmentId,
    conversationConnection,
    handleSessionEvents,
    native,
    savePreferences,
  ]);

  useEffect(() => {
    const current = attachmentRef.current;
    const reconciliation = reconcileMasterVoiceFocus(current, props.focus);
    if (reconciliation.type === "stop") {
      focusUpdateGenerationRef.current += 1;
      void runtimeRef.current?.controller.stop();
      return;
    }
    if (reconciliation.type !== "update") return;

    const generation = ++focusUpdateGenerationRef.current;
    const runtime = runtimeRef.current;
    const nextAttachment = reconciliation.attachment;
    if (runtime === null || runtime.environmentId !== nextAttachment.environmentId) return;
    focusUpdateTailRef.current = focusUpdateTailRef.current
      .then(async () => {
        if (generation !== focusUpdateGenerationRef.current) return;
        await runtime.controller.updateFocus(
          nextAttachment.focus!.projectId,
          nextAttachment.focus!.threadId,
        );
        if (
          generation !== focusUpdateGenerationRef.current ||
          runtimeRef.current !== runtime ||
          runtime.controller.getSnapshot().phase !== "active"
        )
          return;
        setAttachment(nextAttachment);
        const actions = [...pendingClientActionsRef.current.values()].filter(
          (candidate) =>
            candidate.projectId === nextAttachment.focus?.projectId &&
            candidate.threadId === nextAttachment.focus?.threadId,
        );
        await Promise.all(actions.map((action) => acknowledgeClientAction(action, "succeeded")));
      })
      .catch(async (cause) => {
        if (generation !== focusUpdateGenerationRef.current) return;
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
  }, [acknowledgeClientAction, props.focus]);

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

  const resume = useCallback(() => {
    const runtime = runtimeRef.current;
    if (
      resumeInFlightRef.current ||
      startInFlightRef.current ||
      snapshot.phase !== "idle" ||
      runtime === null
    )
      return;
    resumeInFlightRef.current = true;
    startInFlightRef.current = true;
    setResumePending(true);
    void interruptTraditionalAudio()
      .then(async (releaseTraditionalAudio) => {
        try {
          const selection = await loadResumeSelection(runtime.client);
          await start(selection, false, releaseTraditionalAudio, true);
        } catch (cause) {
          releaseTraditionalAudio();
          throw cause;
        }
      })
      .catch((cause) => Alert.alert("Voice conversation unavailable", errorMessage(cause)))
      .finally(() => {
        startInFlightRef.current = false;
        resumeInFlightRef.current = false;
        setResumePending(false);
      });
  }, [interruptTraditionalAudio, snapshot.phase, start]);

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
    if (snapshot.phase === "error") {
      setSnapshot(INITIAL_SNAPSHOT);
      setAttachment(null);
      return;
    }
    await runtimeRef.current?.controller.stop();
  }, [snapshot.phase]);

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
    () => ({ phase: snapshot.phase, stop, registerTraditionalAudioInterruption }),
    [registerTraditionalAudioInterruption, snapshot.phase, stop],
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

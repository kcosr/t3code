import type {
  EnvironmentId,
  VoiceConfirmationId,
  VoiceConversationSelection,
  VoiceConversationSummary,
  VoiceSessionCreateInput,
  VoiceSessionEvent,
} from "@t3tools/contracts";
import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import type { T3VoiceAudioRoute } from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import { uuidv4 } from "../../lib/uuid";
import { usePreparedConnection } from "../../state/session";
import {
  MasterVoiceCallBar,
  VoiceAudioRoutePicker,
  VoiceConversationPicker,
  VoiceTranscriptModal,
  type MasterVoiceTranscriptTurn,
  type VoiceAudioRoutePickerState,
} from "./MasterVoiceOverlays";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import {
  durableVoiceConversations,
  masterVoiceEnvironmentId,
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

interface MasterVoiceContextValue {
  readonly phase: RealtimeVoiceControllerSnapshot["phase"];
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

export function MasterVoiceProvider(props: {
  readonly children: ReactNode;
  readonly focus: MasterVoiceFocus | null;
}) {
  const native = getT3VoiceNativeModule();
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const [attachment, setAttachment] = useState<ActiveMasterVoiceAttachment | null>(null);
  const [availableEnvironmentId, setAvailableEnvironmentId] = useState<EnvironmentId | null>(null);
  const [pickerConversations, setPickerConversations] =
    useState<ReadonlyArray<VoiceConversationSummary> | null>(null);
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
  attachmentRef.current = attachment;

  const controllerEnvironmentId = masterVoiceEnvironmentId(
    attachment?.environmentId ?? null,
    props.focus,
  );
  const prepared = Option.getOrNull(usePreparedConnection(controllerEnvironmentId));

  const handleSessionEvents = useCallback((events: ReadonlyArray<VoiceSessionEvent>) => {
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
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    setAvailableEnvironmentId(null);
    if (controllerEnvironmentId === null || prepared === null || native === null) return;

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
          if (disposed) return;
          setSnapshot(next);
          if (next.phase === "idle") {
            setAttachment(null);
            setConfirmations([]);
          }
          if (next.phase !== "active") setAudioRoutePicker(null);
        },
        onSessionEvents: handleSessionEvents,
      });
      const runtime = { environmentId: controllerEnvironmentId, client, controller };
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
  }, [controllerEnvironmentId, handleSessionEvents, native, prepared]);

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
          nextAttachment.focus.projectId,
          nextAttachment.focus.threadId,
        );
        if (
          generation !== focusUpdateGenerationRef.current ||
          runtimeRef.current !== runtime ||
          runtime.controller.getSnapshot().phase !== "active"
        )
          return;
        setAttachment(nextAttachment);
      })
      .catch(async (cause) => {
        if (generation !== focusUpdateGenerationRef.current) return;
        await runtime.controller.stop();
        Alert.alert(
          "Voice conversation ended",
          `Could not update thread focus. ${errorMessage(cause)}`,
        );
      });
  }, [props.focus]);

  const start = useCallback(
    async (conversation: VoiceConversationSelection, takeover = false) => {
      const focus = props.focus;
      const runtime = runtimeRef.current;
      if (
        startInFlightRef.current ||
        focus === null ||
        runtime === null ||
        runtime.environmentId !== focus.environmentId
      )
        return;
      startInFlightRef.current = true;
      setPickerConversations(null);
      setTranscript([]);
      const sessionInput: VoiceSessionCreateInput = {
        mode: "realtime-agent",
        conversation:
          conversation.type === "continue" ? { ...conversation, takeover } : conversation,
        projectId: focus.projectId,
        threadId: focus.threadId,
        media: {
          transports: ["webrtc-sdp-v1"],
          audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
          supportsInputRouteSelection: true,
          supportsOutputRouteSelection: true,
        },
        idempotencyKey: uuidv4(),
      };
      setAttachment({ environmentId: focus.environmentId, focus });
      try {
        await runtime.controller.start(sessionInput);
      } catch (cause) {
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
              { text: "Take Over", onPress: () => void start(conversation, true) },
            ],
            { cancelable: false },
          );
          return;
        }
        Alert.alert("Voice conversation failed", errorMessage(cause));
      } finally {
        startInFlightRef.current = false;
      }
    },
    [props.focus],
  );

  const resume = useCallback(() => {
    const runtime = runtimeRef.current;
    if (
      resumeInFlightRef.current ||
      startInFlightRef.current ||
      snapshot.phase !== "idle" ||
      props.focus === null ||
      runtime === null
    )
      return;
    resumeInFlightRef.current = true;
    setResumePending(true);
    void Effect.runPromise(runtime.client.listConversations())
      .then((conversations) => start(resumeVoiceConversationSelection(conversations)))
      .catch((cause) => Alert.alert("Voice conversation unavailable", errorMessage(cause)))
      .finally(() => {
        resumeInFlightRef.current = false;
        setResumePending(false);
      });
  }, [props.focus, snapshot.phase, start]);

  const browseHistory = useCallback(() => {
    const runtime = runtimeRef.current;
    if (runtime === null || snapshot.phase !== "idle" || props.focus === null) return;
    void Effect.runPromise(runtime.client.listConversations())
      .then((conversations) => setPickerConversations(durableVoiceConversations(conversations)))
      .catch((cause) => Alert.alert("Voice conversations unavailable", errorMessage(cause)));
  }, [props.focus, snapshot.phase]);

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
            : { routes: [], selectingRouteId: null, error: errorMessage(cause) },
        ),
      );
  }, []);

  const selectAudioRoute = useCallback((route: T3VoiceAudioRoute) => {
    const controller = runtimeRef.current?.controller;
    if (controller === undefined || route.selected) return;
    setAudioRoutePicker((current) =>
      current === null ? null : { ...current, selectingRouteId: route.id, error: null },
    );
    void controller
      .setAudioRoute(route.id)
      .then((routes) =>
        setAudioRoutePicker((current) =>
          current === null ? null : { routes, selectingRouteId: null, error: null },
        ),
      )
      .catch((cause) =>
        setAudioRoutePicker((current) =>
          current === null
            ? null
            : { ...current, selectingRouteId: null, error: errorMessage(cause) },
        ),
      );
  }, []);

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
    () => ({ phase: snapshot.phase }),
    [snapshot.phase],
  );

  return (
    <MasterVoiceContext.Provider value={contextValue}>
      <View className="flex-1">
        {props.children}
        <MasterVoiceCallBar
          available={
            props.focus !== null &&
            availableEnvironmentId === props.focus.environmentId &&
            native !== null
          }
          snapshot={snapshot}
          attachment={attachment}
          transcript={transcript}
          onMute={toggleMuted}
          onRoute={chooseAudioRoute}
          onTranscript={() => setTranscriptVisible(true)}
          onResume={resume}
          resumePending={resumePending}
          onHistory={browseHistory}
          onStop={() => {
            if (snapshot.phase === "error") {
              setSnapshot(INITIAL_SNAPSHOT);
              setAttachment(null);
              return;
            }
            void runtimeRef.current?.controller.stop();
          }}
        />
      </View>
      <VoiceConversationPicker
        visible={pickerConversations !== null}
        conversations={pickerConversations ?? []}
        onCancel={() => setPickerConversations(null)}
        onContinue={(conversation) =>
          void start({
            type: "continue",
            conversationId: conversation.conversationId,
            takeover: false,
          })
        }
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

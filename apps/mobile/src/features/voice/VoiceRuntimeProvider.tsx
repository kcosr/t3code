import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  admittedClientActionFocusState,
  bindVoiceConversationBrowser,
  canOfferThreadVoiceSwitch,
  continueVoiceConversationSelection,
  createVoiceRuntimeRetryCoordinator,
  isThreadVoiceStartAvailable,
  voiceRuntimeEnvironmentId,
  newVoiceConversationSelection,
  prepareVoiceRuntimeAttachment,
  reconcileVoiceAudioRoutePickerState,
  settleVoiceAudioRoutePickerSelection,
  stopVoiceRuntimeStrict,
  ThreadReviewHydrationTracker,
  threadTranscriptSubmissionDisposition,
  threadVoiceStartForFocus,
  voiceRuntimeCommandEnvironmentMatches,
  voiceRuntimeSnapshotEnvironmentId,
  type ActiveVoiceRuntimeAttachment,
  type AdmittedClientActionFocus,
  type VoiceRuntimeFocus,
  type ThreadReviewIdentity,
  type ThreadTranscriptSubmissionDisposition,
  type VoiceAudioRoute,
  type VoiceHttpClient,
  type VoiceRealtimeContext,
  type VoiceRealtimeTarget,
  type VoiceRuntimeAdapter,
  type VoiceRuntimeSnapshot,
  type VoiceAudioRoutePickerState,
} from "@t3tools/client-runtime/voice";
import {
  type EnvironmentId,
  type ThreadId,
  type VoiceConversationId,
  type VoiceConversationSelection,
} from "@t3tools/contracts";
import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
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

import { useThreadShells } from "../../state/entities";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { usePreparedConnection } from "../../state/session";
import {
  useComposerDraftContentEmpty,
  useComposerDraftsReady,
} from "../../state/use-composer-drafts";
import { makeAndroidVoiceRuntimeAdapter } from "./androidVoiceRuntimeAdapter";
import { ExclusiveTransition } from "./exclusiveTransition";
import {
  RealtimeVoiceCallBar,
  VoiceAudioRoutePicker,
  VoiceTranscriptModal,
  type RealtimeVoiceTranscriptTurn,
} from "./VoiceRuntimeOverlays";
import { VoiceConversationBrowser, type VoiceConversationClient } from "./VoiceConversationBrowser";
import { loadResumeSelection } from "./voiceConversationResume";
import { makeMobileVoiceClient } from "./mobileVoiceClient";
import { useVoiceCapabilityAvailability } from "./useVoiceCapabilityAvailability";
import { resolveVoicePreferences } from "./voicePreferences";

interface NativeRuntimeConnection {
  readonly environmentId: EnvironmentId;
  readonly adapter: VoiceRuntimeAdapter;
}

interface VoiceConversationConnection {
  readonly environmentId: EnvironmentId;
  readonly client: VoiceHttpClient;
}

interface VoiceRuntimeContextValue {
  readonly snapshot: VoiceRuntimeSnapshot;
  readonly controlsAvailable: boolean;
  readonly threadStartAvailable: boolean;
  readonly startThread: () => Promise<void>;
  readonly finishThreadRecording: () => Promise<void>;
  readonly threadReviewHydrationTracker: ThreadReviewHydrationTracker;
  readonly updateThreadReviewTranscript: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly transcript: string;
    readonly review: ThreadReviewIdentity;
  }) => Promise<boolean>;
  readonly submitThreadTranscript: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly transcript: string;
    readonly review: ThreadReviewIdentity | null;
  }) => Promise<"submitted" | Exclude<ThreadTranscriptSubmissionDisposition, "submit-native">>;
  readonly stop: () => Promise<void>;
  readonly registerTraditionalAudioInterruption: (
    interrupt: () => void | (() => void) | Promise<void | (() => void)>,
  ) => () => void;
}

const INITIAL_SNAPSHOT: VoiceRuntimeSnapshot = {
  mode: "idle",
  generation: 0,
  sequence: -1,
};

const VoiceRuntimeContext = createContext<VoiceRuntimeContextValue | null>(null);
const EMPTY_REALTIME_TRANSCRIPT: ReadonlyArray<RealtimeVoiceTranscriptTurn> = [];

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function VoiceRuntimeProvider(props: {
  readonly children: ReactNode;
  readonly environmentId: EnvironmentId | null;
  readonly focus: VoiceRuntimeFocus | null;
}) {
  const navigation = useNavigation();
  const native = getT3VoiceNativeModule();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const threadShells = useThreadShells();
  const [snapshot, setSnapshot] = useState<VoiceRuntimeSnapshot>(INITIAL_SNAPSHOT);
  const [runtimeEnvironmentId, setRuntimeEnvironmentId] = useState<EnvironmentId | null>(null);
  const [conversationConnection, setConversationConnection] =
    useState<VoiceConversationConnection | null>(null);
  const [subscribedEnvironmentId, setSubscribedEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [browserVisible, setBrowserVisible] = useState(false);
  const [audioRoutePicker, setAudioRoutePicker] = useState<VoiceAudioRoutePickerState | null>(null);
  const [transcriptVisible, setTranscriptVisible] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const runtimeRef = useRef<NativeRuntimeConnection | null>(null);
  const controllerEnvironmentIdRef = useRef<EnvironmentId | null>(null);
  const snapshotRef = useRef(snapshot);
  const lastRealtimeTargetRef = useRef<VoiceRealtimeTarget | null>(null);
  const voiceStartTransitionRef = useRef(new ExclusiveTransition());
  const threadReviewHydrationTracker = useMemo(() => new ThreadReviewHydrationTracker(), []);
  const resumeAbortRef = useRef<AbortController | null>(null);
  const handledFailureSequenceRef = useRef<number | null>(null);
  const handledClientActionsRef = useRef(new Set<string>());
  const admittedClientActionFocusRef = useRef<AdmittedClientActionFocus | null>(null);
  const promptedConfirmationsRef = useRef(new Set<string>());
  const lastPreferredRouteAttemptRef = useRef<string | null>(null);
  const traditionalAudioInterruptionsRef = useRef(
    new Set<() => void | (() => void) | Promise<void | (() => void)>>(),
  );

  const storedPreferences = Option.getOrNull(AsyncResult.value(preferencesResult));
  const preferencesReady = AsyncResult.isSuccess(preferencesResult);
  const voicePreferences = useMemo(
    () => resolveVoicePreferences(storedPreferences ?? {}),
    [storedPreferences],
  );
  const preferredAudioRouteId = storedPreferences?.voiceAudioRouteId ?? null;
  const playThreadResponses = storedPreferences?.threadSpeechEnabled === true;

  const composerDraftsReady = useComposerDraftsReady();

  const acceptSnapshot = useCallback((next: VoiceRuntimeSnapshot) => {
    if (next.sequence < snapshotRef.current.sequence) return;
    snapshotRef.current = next;
    if (next.mode === "realtime") lastRealtimeTargetRef.current = next.target;
    const environmentId = voiceRuntimeSnapshotEnvironmentId(next);
    if (environmentId !== null) setRuntimeEnvironmentId(environmentId);
    if (next.mode === "idle") setRuntimeEnvironmentId(null);
    setSnapshot(next);
  }, []);

  useEffect(() => {
    if (native === null) return;
    const retry = createVoiceRuntimeRetryCoordinator();
    void retry
      .run(() => native.getRuntimeSnapshotAsync())
      .then((current) => {
        if (current === null || current.sequence < snapshotRef.current.sequence) return;
        const environmentId = voiceRuntimeSnapshotEnvironmentId(current);
        if (environmentId !== null) setRuntimeEnvironmentId(environmentId);
        else if (current.mode === "idle") setRuntimeEnvironmentId(null);
      })
      .catch(() => undefined);
    return retry.cancel;
  }, [native]);

  const controllerEnvironmentId = voiceRuntimeEnvironmentId(
    voiceRuntimeSnapshotEnvironmentId(snapshot) ?? runtimeEnvironmentId,
    props.focus,
    props.environmentId,
  );
  controllerEnvironmentIdRef.current = controllerEnvironmentId;
  const controlsAvailable =
    controllerEnvironmentId !== null && subscribedEnvironmentId === controllerEnvironmentId;
  const prepared = Option.getOrNull(usePreparedConnection(controllerEnvironmentId));
  const preparedRef = useRef<PreparedConnection | null>(prepared);
  preparedRef.current = prepared;
  const realtimeAvailable = useVoiceCapabilityAvailability(prepared, "agent.realtime");
  const browserConnection =
    conversationConnection?.environmentId === controllerEnvironmentId
      ? conversationConnection
      : null;
  const conversationClient: VoiceConversationClient | null = browserConnection?.client ?? null;

  useEffect(
    () => () => {
      resumeAbortRef.current?.abort();
    },
    [controllerEnvironmentId, conversationClient],
  );

  useEffect(() => {
    let disposed = false;
    setConversationConnection(null);
    if (controllerEnvironmentId === null || prepared === null) return;

    void makeMobileVoiceClient(prepared)
      .then((client) => {
        if (!disposed)
          setConversationConnection({ environmentId: controllerEnvironmentId, client });
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      setConversationConnection(null);
    };
  }, [controllerEnvironmentId, prepared]);

  useEffect(() => {
    if (controllerEnvironmentId === null || native === null) return;
    const adapter = makeAndroidVoiceRuntimeAdapter({
      native,
      environmentId: controllerEnvironmentId,
      getPrepared: () => {
        const current = preparedRef.current;
        return current?.environmentId === controllerEnvironmentId ? current : null;
      },
    });
    const runtime = { environmentId: controllerEnvironmentId, adapter };
    let disposed = false;
    const retry = createVoiceRuntimeRetryCoordinator(undefined, (cause) => {
      if (!disposed) Alert.alert("Voice controls unavailable", errorMessage(cause));
    });
    let detach: (() => void) | null = null;

    void retry
      .run(() =>
        prepareVoiceRuntimeAttachment({
          runtime,
          listener: acceptSnapshot,
          isDisposed: () => disposed || retry.isCancelled(),
        }),
      )
      .then((attachment) => {
        if (attachment === null) return;
        detach = attachment.detach;
        runtimeRef.current = attachment.runtime;
        setSubscribedEnvironmentId(controllerEnvironmentId);
      })
      .catch((cause) => {
        if (!disposed) {
          if (runtimeRef.current === runtime) runtimeRef.current = null;
          setSubscribedEnvironmentId(null);
          Alert.alert("Voice controls unavailable", errorMessage(cause));
        }
      });

    return () => {
      disposed = true;
      retry.cancel();
      detach?.();
      setSubscribedEnvironmentId(null);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [acceptSnapshot, controllerEnvironmentId, native]);

  useEffect(() => {
    if (snapshot.mode !== "realtime") {
      lastPreferredRouteAttemptRef.current = null;
    }
  }, [snapshot.mode]);

  const visibleFocus = props.focus?.environmentId === controllerEnvironmentId ? props.focus : null;
  const visibleDraftKey =
    visibleFocus === null
      ? null
      : scopedThreadKey(visibleFocus.environmentId, visibleFocus.threadId);
  const composerContentEmpty = useComposerDraftContentEmpty(visibleDraftKey);
  const canSwitchRealtimeToThread = canOfferThreadVoiceSwitch({
    preferencesReady,
    composerDraftsReady,
    composerContentEmpty,
    interactionRequired: visibleFocus?.interactionRequired ?? false,
    activeThreadBusy: visibleFocus?.activeThreadBusy ?? true,
  });
  const threadSwitch = useMemo(
    () =>
      canSwitchRealtimeToThread
        ? threadVoiceStartForFocus(visibleFocus, voicePreferences, playThreadResponses)
        : null,
    [canSwitchRealtimeToThread, playThreadResponses, visibleFocus, voicePreferences],
  );
  const realtimeContext = useMemo<VoiceRealtimeContext>(
    () => ({
      focus:
        visibleFocus === null
          ? null
          : { projectId: visibleFocus.projectId, threadId: visibleFocus.threadId },
      threadSwitch,
    }),
    [threadSwitch, visibleFocus],
  );
  const threadStartAvailable =
    threadSwitch !== null && isThreadVoiceStartAvailable(snapshot, prepared !== null);
  const realtimeContextKey = JSON.stringify(realtimeContext);
  const nativeRealtimeContextKey =
    snapshot.mode === "realtime"
      ? JSON.stringify({ focus: snapshot.target.focus, threadSwitch: snapshot.target.threadSwitch })
      : null;

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
    [],
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
      nativeRealtimeContextKey === realtimeContextKey
    ) {
      return;
    }
    void runtime.adapter
      .updateRealtimeContext(realtimeContext)
      .catch((cause) => Alert.alert("Voice focus unavailable", errorMessage(cause)));
  }, [
    acknowledgeAdmittedClientAction,
    nativeRealtimeContextKey,
    realtimeContext,
    realtimeContextKey,
    snapshot,
    visibleFocus,
  ]);

  const interruptTraditionalAudio = useCallback(async () => {
    const releases: Array<void | (() => void)> = [];
    try {
      for (const interrupt of traditionalAudioInterruptionsRef.current) {
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

  const performRealtimeStart = useCallback(
    async (
      runtime: NativeRuntimeConnection,
      target: VoiceRealtimeTarget,
      isCancelled: () => boolean = () => false,
    ) => {
      const runtimeStillMatchesTarget = () =>
        !isCancelled() &&
        runtimeRef.current === runtime &&
        voiceRuntimeCommandEnvironmentMatches(
          target.environmentId,
          runtime.environmentId,
          controllerEnvironmentIdRef.current,
        );
      let releaseTraditionalAudio: (() => void) | null = null;
      try {
        releaseTraditionalAudio = await interruptTraditionalAudio();
        if (!runtimeStillMatchesTarget()) {
          releaseTraditionalAudio();
          return;
        }
        const current = snapshotRef.current;
        if (current.mode === "failed") await runtime.adapter.stop();
        if (!runtimeStillMatchesTarget()) {
          releaseTraditionalAudio();
          return;
        }
        lastRealtimeTargetRef.current = target;
        handledFailureSequenceRef.current = null;
        if (current.mode === "thread") {
          await runtime.adapter.switchThreadToRealtime(target);
        } else {
          await runtime.adapter.startRealtime(target);
        }
      } catch (cause) {
        releaseTraditionalAudio?.();
        throw cause;
      }
    },
    [interruptTraditionalAudio],
  );

  const startRealtime = useCallback(
    async (target: VoiceRealtimeTarget) => {
      const runtime = runtimeRef.current;
      const current = snapshotRef.current;
      if (
        runtime === null ||
        !voiceRuntimeCommandEnvironmentMatches(
          target.environmentId,
          runtime.environmentId,
          controllerEnvironmentIdRef.current,
        ) ||
        voiceStartTransitionRef.current.active ||
        (current.mode !== "idle" && current.mode !== "failed" && current.mode !== "thread")
      ) {
        return;
      }
      await voiceStartTransitionRef.current
        .run(() => performRealtimeStart(runtime, target))
        .catch((cause) => Alert.alert("Voice conversation failed", errorMessage(cause)));
    },
    [performRealtimeStart],
  );

  useEffect(() => {
    if (snapshot.mode !== "failed" || handledFailureSequenceRef.current === snapshot.sequence) {
      return;
    }
    handledFailureSequenceRef.current = snapshot.sequence;
    const target = lastRealtimeTargetRef.current;
    if (
      snapshot.operation === "realtime" &&
      snapshot.failure.code === "takeover-required" &&
      target?.conversation.type === "continue" &&
      !target.conversation.takeover
    ) {
      const takeoverConversation: VoiceConversationSelection = {
        ...target.conversation,
        takeover: true,
      };
      const takeoverTarget: VoiceRealtimeTarget = {
        ...target,
        conversation: takeoverConversation,
      };
      const expectedEnvironmentId = target.environmentId;
      Alert.alert(
        "Take over active voice session?",
        "An existing voice session is already active for this conversation. Taking over stops it and starts a new session here.",
        [
          {
            text: "Cancel",
            style: "cancel",
            onPress: () => {
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
    if (
      snapshot.operation === "realtime" &&
      snapshot.failure.code === "voice_conversation_not_found"
    ) {
      void runtimeRef.current?.adapter
        .stop()
        .catch((cause) => Alert.alert("Could not stop voice", errorMessage(cause)));
      Alert.alert(
        "Conversation no longer available",
        "It may have been deleted on another device. The conversation list has been refreshed.",
      );
      setBrowserVisible(true);
      return;
    }
    Alert.alert("Voice session failed", snapshot.failure.message);
  }, [snapshot, startRealtime]);

  useEffect(() => {
    if (
      snapshot.mode !== "realtime" ||
      snapshot.phase !== "connected" ||
      preferredAudioRouteId === null
    ) {
      return;
    }
    const preferred = snapshot.audioRoutes.find((route) => route.id === preferredAudioRouteId);
    if (preferred === undefined || preferred.selected) return;
    const attemptKey = `${snapshot.generation}:${preferred.id}`;
    if (lastPreferredRouteAttemptRef.current === attemptKey) return;
    lastPreferredRouteAttemptRef.current = attemptKey;
    void runtimeRef.current?.adapter.setRealtimeAudioRoute(preferred.id).catch(() => undefined);
  }, [preferredAudioRouteId, snapshot]);

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
        setBrowserVisible(false);
        setTranscriptVisible(false);
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
        const admittedFocus = admittedClientActionFocusRef.current;
        if (
          admittedFocus !== null &&
          admittedClientActionFocusState(admittedFocus, visibleFocus) === "admitted"
        ) {
          acknowledgeAdmittedClientAction(admittedFocus);
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
  }, [acknowledgeAdmittedClientAction, navigation, snapshot, visibleFocus]);

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
  }, [snapshot]);

  const resume = useCallback(() => {
    const runtime = runtimeRef.current;
    const current = snapshotRef.current;
    if (
      runtime === null ||
      conversationClient === null ||
      conversationConnection?.environmentId !== runtime.environmentId ||
      voiceStartTransitionRef.current.active ||
      (current.mode !== "idle" && current.mode !== "thread" && current.mode !== "failed")
    ) {
      return;
    }
    const targetEnvironmentId = runtime.environmentId;
    const targetContext = realtimeContext;
    const abort = new AbortController();
    resumeAbortRef.current?.abort();
    resumeAbortRef.current = abort;
    setResumePending(true);
    let loadingSelection = true;
    void voiceStartTransitionRef.current
      .run(async () => {
        const conversation = await loadResumeSelection(conversationClient, abort.signal);
        if (conversation === null || abort.signal.aborted) return;
        loadingSelection = false;
        await performRealtimeStart(
          runtime,
          {
            environmentId: targetEnvironmentId,
            conversation,
            ...targetContext,
          },
          () => abort.signal.aborted,
        );
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          Alert.alert(
            loadingSelection ? "Voice conversation unavailable" : "Voice conversation failed",
            errorMessage(cause),
          );
        }
      })
      .finally(() => {
        if (resumeAbortRef.current === abort) {
          resumeAbortRef.current = null;
          setResumePending(false);
        }
      });
  }, [
    conversationClient,
    conversationConnection?.environmentId,
    performRealtimeStart,
    realtimeContext,
  ]);

  const startThread = useCallback(async () => {
    const runtime = runtimeRef.current;
    const input = threadSwitch;
    if (
      runtime === null ||
      input === null ||
      !voiceRuntimeCommandEnvironmentMatches(
        input.target.environmentId,
        runtime.environmentId,
        controllerEnvironmentIdRef.current,
      )
    ) {
      throw new Error("Open a Thread before starting Thread voice");
    }
    const runtimeStillMatchesTarget = () =>
      runtimeRef.current === runtime &&
      voiceRuntimeCommandEnvironmentMatches(
        input.target.environmentId,
        runtime.environmentId,
        controllerEnvironmentIdRef.current,
      );
    await voiceStartTransitionRef.current.run(async () => {
      let releaseTraditionalAudio: (() => void) | null = null;
      try {
        releaseTraditionalAudio = await interruptTraditionalAudio();
        if (!runtimeStillMatchesTarget()) {
          releaseTraditionalAudio();
          return;
        }
        const current = snapshotRef.current;
        if (current.mode === "realtime") {
          await runtime.adapter.switchRealtimeToThread(input);
        } else {
          if (current.mode === "failed") await runtime.adapter.stop();
          if (!runtimeStillMatchesTarget()) {
            releaseTraditionalAudio();
            return;
          }
          await runtime.adapter.startThread(input);
        }
      } catch (cause) {
        releaseTraditionalAudio?.();
        throw cause;
      }
    });
  }, [interruptTraditionalAudio, threadSwitch]);

  const finishThreadRecording = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (runtime === null) throw new Error("Native voice controls are unavailable");
    await runtime.adapter.finishThreadRecording();
  }, []);

  const updateThreadReviewTranscript = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly transcript: string;
      readonly review: ThreadReviewIdentity;
    }) => {
      if (
        threadTranscriptSubmissionDisposition(snapshotRef.current, input, input.review) !==
        "submit-native"
      ) {
        return false;
      }
      const runtime = runtimeRef.current;
      if (
        runtime === null ||
        !voiceRuntimeCommandEnvironmentMatches(
          input.environmentId,
          runtime.environmentId,
          controllerEnvironmentIdRef.current,
        )
      ) {
        return false;
      }
      await runtime.adapter.updateThreadReviewTranscript(input.review, input.transcript);
      return true;
    },
    [],
  );

  const submitThreadTranscript = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly transcript: string;
      readonly review: ThreadReviewIdentity | null;
    }) => {
      const disposition = threadTranscriptSubmissionDisposition(
        snapshotRef.current,
        input,
        input.review,
      );
      if (disposition !== "submit-native") return disposition;
      if (input.review === null) return "native-owned";
      const runtime = runtimeRef.current;
      if (
        runtime === null ||
        !voiceRuntimeCommandEnvironmentMatches(
          input.environmentId,
          runtime.environmentId,
          controllerEnvironmentIdRef.current,
        )
      ) {
        return "native-owned";
      }
      await runtime.adapter.submitThreadTranscript(input.review, input.transcript);
      return "submitted";
    },
    [],
  );

  const stop = useCallback(async () => {
    await stopVoiceRuntimeStrict(runtimeRef.current);
  }, []);

  const registerTraditionalAudioInterruption = useCallback(
    (interrupt: () => void | (() => void) | Promise<void | (() => void)>) => {
      traditionalAudioInterruptionsRef.current.add(interrupt);
      return () => traditionalAudioInterruptionsRef.current.delete(interrupt);
    },
    [],
  );

  const chooseAudioRoute = useCallback(() => {
    if (!controlsAvailable || snapshotRef.current.mode !== "realtime") return;
    setAudioRoutePicker({
      selectingRouteId: null,
      error: null,
    });
  }, [controlsAvailable]);

  const selectAudioRoute = useCallback(
    (route: VoiceAudioRoute) => {
      if (route.selected) {
        savePreferences({ voiceAudioRouteId: route.id });
        return;
      }
      setAudioRoutePicker((current) =>
        current === null ? null : { ...current, selectingRouteId: route.id, error: null },
      );
      const runtime = runtimeRef.current;
      if (runtime === null) {
        setAudioRoutePicker((current) =>
          current === null
            ? null
            : { ...current, selectingRouteId: null, error: "Voice controls are reconnecting." },
        );
        return;
      }
      void runtime.adapter
        .setRealtimeAudioRoute(route.id)
        .then(() => {
          savePreferences({ voiceAudioRouteId: route.id });
          setAudioRoutePicker((current) => settleVoiceAudioRoutePickerSelection(current, route.id));
        })
        .catch((cause) =>
          setAudioRoutePicker((current) =>
            settleVoiceAudioRoutePickerSelection(current, route.id, errorMessage(cause)),
          ),
        );
    },
    [savePreferences],
  );

  const realtimeAudioRoutes = snapshot.mode === "realtime" ? snapshot.audioRoutes : null;
  useEffect(() => {
    setAudioRoutePicker((current) =>
      reconcileVoiceAudioRoutePickerState(current, {
        controlsAvailable,
        routes: realtimeAudioRoutes,
      }),
    );
  }, [controlsAvailable, realtimeAudioRoutes]);

  const toggleMuted = useCallback(() => {
    if (snapshotRef.current.mode !== "realtime") return;
    const runtime = runtimeRef.current;
    if (runtime === null) {
      Alert.alert("Voice controls unavailable", "Voice is still reconnecting to Android.");
      return;
    }
    void runtime.adapter
      .setRealtimeMuted(!snapshotRef.current.muted)
      .catch((cause) => Alert.alert("Microphone unavailable", errorMessage(cause)));
  }, []);

  const attachment = useMemo<ActiveVoiceRuntimeAttachment | null>(() => {
    const environmentId = voiceRuntimeSnapshotEnvironmentId(snapshot);
    if (environmentId === null || snapshot.mode === "failed" || snapshot.mode === "idle")
      return null;
    const focus =
      snapshot.mode === "realtime" || snapshot.mode === "switching-to-realtime"
        ? snapshot.target.focus
        : { projectId: snapshot.target.projectId, threadId: snapshot.target.threadId };
    if (focus === null) return { environmentId, focus: null };
    const shell = threadShells.find(
      (thread) => thread.environmentId === environmentId && thread.id === focus.threadId,
    );
    if (shell === undefined) return { environmentId, focus: null };
    const threadTarget =
      snapshot.mode === "realtime" || snapshot.mode === "switching-to-realtime"
        ? snapshot.target.threadSwitch?.target
        : snapshot.target;
    return {
      environmentId,
      focus: {
        environmentId,
        projectId: focus.projectId,
        threadId: focus.threadId,
        threadTitle: shell.title,
        modelSelection: threadTarget?.modelSelection ?? shell.modelSelection,
        runtimeMode: threadTarget?.runtimeMode ?? shell.runtimeMode,
        interactionMode: threadTarget?.interactionMode ?? shell.interactionMode ?? "default",
        interactionRequired:
          shell.hasPendingApprovals === true || shell.hasPendingUserInput === true,
        activeThreadBusy:
          shell.session?.status === "starting" || shell.session?.status === "running",
      },
    };
  }, [snapshot, threadShells]);

  const transcript = useMemo<ReadonlyArray<RealtimeVoiceTranscriptTurn>>(() => {
    if (snapshot.mode === "realtime") return snapshot.transcript;
    return EMPTY_REALTIME_TRANSCRIPT;
  }, [snapshot]);
  const contextValue = useMemo<VoiceRuntimeContextValue>(
    () => ({
      snapshot,
      controlsAvailable,
      threadStartAvailable,
      startThread,
      finishThreadRecording,
      threadReviewHydrationTracker,
      updateThreadReviewTranscript,
      submitThreadTranscript,
      stop,
      registerTraditionalAudioInterruption,
    }),
    [
      finishThreadRecording,
      controlsAvailable,
      registerTraditionalAudioInterruption,
      snapshot,
      startThread,
      stop,
      submitThreadTranscript,
      threadReviewHydrationTracker,
      threadStartAvailable,
      updateThreadReviewTranscript,
    ],
  );
  const browserBinding = useMemo(
    () =>
      browserConnection === null
        ? null
        : bindVoiceConversationBrowser(browserConnection.environmentId, realtimeContext),
    [browserConnection, realtimeContext],
  );

  return (
    <VoiceRuntimeContext.Provider value={contextValue}>
      <View className="flex-1">
        {props.children}
        <RealtimeVoiceCallBar
          historyAvailable={conversationClient !== null}
          callAvailable={
            native !== null &&
            realtimeAvailable &&
            subscribedEnvironmentId === controllerEnvironmentId
          }
          snapshot={snapshot}
          controlsAvailable={controlsAvailable}
          attachment={attachment}
          transcript={transcript}
          onMute={toggleMuted}
          onRoute={chooseAudioRoute}
          onTranscript={() => setTranscriptVisible(true)}
          onResume={resume}
          resumePending={resumePending}
          onHistory={() => setBrowserVisible(true)}
          onStop={() => {
            void stop().catch((cause) => Alert.alert("Could not stop voice", errorMessage(cause)));
          }}
        />
      </View>
      {browserConnection !== null && browserBinding !== null ? (
        <VoiceConversationBrowser
          key={browserBinding.mountKey}
          visible={browserVisible}
          client={browserConnection.client}
          onClose={() => setBrowserVisible(false)}
          onNew={() => {
            setBrowserVisible(false);
            void startRealtime(browserBinding.targetFor(newVoiceConversationSelection()));
          }}
          onResume={(conversationId: VoiceConversationId) => {
            setBrowserVisible(false);
            void startRealtime(
              browserBinding.targetFor(continueVoiceConversationSelection(conversationId)),
            );
          }}
        />
      ) : null}
      <VoiceTranscriptModal
        visible={transcriptVisible}
        turns={transcript}
        onClose={() => setTranscriptVisible(false)}
      />
      <VoiceAudioRoutePicker
        state={audioRoutePicker}
        routes={realtimeAudioRoutes}
        onClose={() => setAudioRoutePicker(null)}
        onSelect={selectAudioRoute}
      />
    </VoiceRuntimeContext.Provider>
  );
}

export function useVoiceRuntime(): VoiceRuntimeContextValue {
  const context = use(VoiceRuntimeContext);
  if (context === null) throw new Error("useVoiceRuntime must be used inside VoiceRuntimeProvider");
  return context;
}

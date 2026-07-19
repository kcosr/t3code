import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { VoiceRuntimeSnapshot, VoiceThreadSettings } from "@t3tools/client-runtime/voice";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type VoiceCapabilities,
  type VoiceConversationSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useNavigate } from "@tanstack/react-router";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";
import { environmentThreads, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { AsyncResult } from "effect/unstable/reactivity";
import { loadWebVoiceThreadSettings, saveWebVoiceThreadSettings } from "./defaultThreadSettings";
import type { VoiceMultiTabLockSnapshot } from "./multiTabLock";
import { makeWebVoiceHttpClient } from "./webVoiceHttpClient";
import {
  makeWebVoiceRuntime,
  type WebThreadTurnWaitResult,
  type WebVoiceRuntime,
} from "./webVoiceRuntime";

export interface VoiceRuntimeContextValue {
  readonly runtime: WebVoiceRuntime;
  readonly snapshot: VoiceRuntimeSnapshot;
  readonly multiTab: VoiceMultiTabLockSnapshot;
  readonly threadSettings: VoiceThreadSettings;
  readonly setThreadSettings: (settings: VoiceThreadSettings) => void;
  readonly capabilitiesByEnvironment: ReadonlyMap<EnvironmentId, VoiceCapabilities | null>;
  readonly refreshCapabilities: (environmentId: EnvironmentId) => Promise<void>;
  readonly listConversations: (
    environmentId: EnvironmentId,
  ) => Promise<ReadonlyArray<VoiceConversationSummary>>;
}

const VoiceRuntimeContext = createContext<VoiceRuntimeContextValue | null>(null);

export function useVoiceRuntime(): VoiceRuntimeContextValue {
  const value = useContext(VoiceRuntimeContext);
  if (value === null) {
    throw new Error("useVoiceRuntime must be used within VoiceRuntimeProvider");
  }
  return value;
}

export function useOptionalVoiceRuntime(): VoiceRuntimeContextValue | null {
  return useContext(VoiceRuntimeContext);
}

function waitForThreadTurnIdle(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: import("@t3tools/contracts").ThreadId;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<WebThreadTurnWaitResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (input.signal?.aborted) {
        cleanup();
        resolve({ status: "failed", message: "Thread wait aborted" });
        return;
      }
      if (Date.now() - started >= input.timeoutMs) {
        cleanup();
        resolve({ status: "timeout" });
        return;
      }
      try {
        const threadAtom = environmentThreads.stateAtom(input.environmentId, input.threadId);
        const asyncState = appAtomRegistry.get(threadAtom);
        if (!AsyncResult.isSuccess(asyncState)) {
          return;
        }
        const thread = Option.getOrNull(asyncState.value.data);
        if (thread == null) {
          return;
        }
        const session = thread.session;
        if (session?.status === "running" && session.activeTurnId != null) {
          const attentionActivity = thread.activities.find(
            (activity) =>
              activity.tone === "approval" ||
              activity.kind.includes("approval") ||
              activity.kind.includes("user-input") ||
              activity.kind.includes("user_input"),
          );
          if (attentionActivity != null) {
            cleanup();
            resolve({
              status: "attention",
              kind:
                attentionActivity.kind.includes("user-input") ||
                attentionActivity.kind.includes("user_input")
                  ? "user-input-required"
                  : "approval-required",
            });
            return;
          }
          return;
        }
        const messages = thread.messages ?? [];
        let assistantText: string | null = null;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i]!;
          if (message.role === "assistant" && message.text.trim().length > 0) {
            assistantText = message.text;
            break;
          }
        }
        cleanup();
        resolve({ status: "completed", assistantText });
      } catch {
        // Atom not ready yet
      }
    };
    const interval = setInterval(tick, 250);
    const onAbort = () => {
      cleanup();
      resolve({ status: "failed", message: "Thread wait aborted" });
    };
    const cleanup = () => {
      clearInterval(interval);
      input.signal?.removeEventListener("abort", onAbort);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    tick();
  });
}

export function VoiceRuntimeProvider(props: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [snapshot, setSnapshot] = useState<VoiceRuntimeSnapshot>({
    mode: "idle",
    generation: 0,
    sequence: 0,
  });
  const [multiTab, setMultiTab] = useState<VoiceMultiTabLockSnapshot>({
    role: "leader",
    leaderTabId: null,
    ownerEnvironmentId: null,
  });
  const [threadSettings, setThreadSettingsState] = useState<VoiceThreadSettings>(() =>
    loadWebVoiceThreadSettings(),
  );
  const [capabilitiesByEnvironment, setCapabilitiesByEnvironment] = useState<
    Map<EnvironmentId, VoiceCapabilities | null>
  >(() => new Map());

  const startThreadTurnRef = useRef(startThreadTurn);
  startThreadTurnRef.current = startThreadTurn;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const runtimeRef = useRef<WebVoiceRuntime | null>(null);
  if (runtimeRef.current === null) {
    runtimeRef.current = makeWebVoiceRuntime({
      getPrepared: (environmentId) => readPreparedConnection(environmentId),
      advertiseSwitchToThread: true,
      dispatchThreadTurn: async (input) => {
        const result = await startThreadTurnRef.current({
          environmentId: input.environmentId,
          input: {
            threadId: input.threadId,
            message: {
              messageId: input.messageId,
              role: "user",
              text: input.text,
              attachments: [],
            },
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            commandId: CommandId.make(String(input.commandId)),
          },
        });
        if (result._tag === "Failure") {
          throw new Error("Failed to dispatch Thread turn from voice");
        }
      },
      waitForThreadTurn: (input) =>
        waitForThreadTurnIdle({
          environmentId: input.environmentId,
          threadId: input.threadId,
          timeoutMs: input.timeoutMs,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }),
      onActivateThread: async ({ environmentId, threadId }) => {
        await navigateRef.current({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
      },
      createMessageId: () =>
        MessageId.make(`msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    });
  }
  const runtime = runtimeRef.current;

  useEffect(() => {
    let detach: (() => void) | undefined;
    let detachMulti: (() => void) | undefined;
    void runtime
      .subscribe((next) => setSnapshot(next))
      .then((fn) => {
        detach = fn;
      });
    detachMulti = runtime.subscribeMultiTab(setMultiTab);
    return () => {
      detach?.();
      detachMulti?.();
    };
  }, [runtime]);

  useEffect(() => {
    const onPageHide = () => {
      void runtime.stop();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [runtime]);

  const setThreadSettings = useCallback((settings: VoiceThreadSettings) => {
    setThreadSettingsState(settings);
    saveWebVoiceThreadSettings(settings);
  }, []);

  const refreshCapabilities = useCallback(async (environmentId: EnvironmentId) => {
    const prepared = readPreparedConnection(environmentId);
    if (prepared === null) {
      setCapabilitiesByEnvironment((prev) => {
        const next = new Map(prev);
        next.set(environmentId, null);
        return next;
      });
      return;
    }
    try {
      const client = await makeWebVoiceHttpClient(prepared);
      const capabilities = await Effect.runPromise(client.capabilities());
      setCapabilitiesByEnvironment((prev) => {
        const next = new Map(prev);
        next.set(environmentId, capabilities);
        return next;
      });
    } catch {
      setCapabilitiesByEnvironment((prev) => {
        const next = new Map(prev);
        next.set(environmentId, null);
        return next;
      });
    }
  }, []);

  const listConversations = useCallback(async (environmentId: EnvironmentId) => {
    const prepared = readPreparedConnection(environmentId);
    if (prepared === null) return [];
    const client = await makeWebVoiceHttpClient(prepared);
    const page = await Effect.runPromise(client.listConversations({ limit: 50 }));
    return page.conversations;
  }, []);

  const value = useMemo<VoiceRuntimeContextValue>(
    () => ({
      runtime,
      snapshot,
      multiTab,
      threadSettings,
      setThreadSettings,
      capabilitiesByEnvironment,
      refreshCapabilities,
      listConversations,
    }),
    [
      runtime,
      snapshot,
      multiTab,
      threadSettings,
      setThreadSettings,
      capabilitiesByEnvironment,
      refreshCapabilities,
      listConversations,
    ],
  );

  return (
    <VoiceRuntimeContext.Provider value={value}>{props.children}</VoiceRuntimeContext.Provider>
  );
}

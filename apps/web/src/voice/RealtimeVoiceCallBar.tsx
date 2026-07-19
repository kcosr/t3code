import { realtimeVoiceBarPhase } from "@t3tools/client-runtime/voice";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Mic, MicOff, PhoneOff, History, Play, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useOptionalVoiceRuntime } from "./VoiceRuntimeContext";

export function RealtimeVoiceCallBar(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly className?: string;
}) {
  const voice = useOptionalVoiceRuntime();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<
    ReadonlyArray<{ id: string; title: string | null; conversationId: string }>
  >([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.environmentId == null || voice == null) return;
    void voice.refreshCapabilities(props.environmentId);
  }, [props.environmentId, voice]);

  const startOrResume = useCallback(async () => {
    if (voice == null || props.environmentId == null) return;
    setBusy(true);
    try {
      if (voice.multiTab.role !== "leader" && voice.multiTab.leaderTabId != null) {
        const taken = await voice.runtime.requestMultiTabTakeover();
        if (!taken) return;
      }
      await voice.runtime.startRealtime({
        environmentId: props.environmentId,
        conversation: { type: "new", retention: "durable" },
        focus:
          props.projectId != null && props.threadId != null
            ? { projectId: props.projectId, threadId: props.threadId }
            : null,
        threadSettings: voice.threadSettings,
      });
    } finally {
      setBusy(false);
    }
  }, [voice, props.environmentId, props.projectId, props.threadId]);

  const openHistory = useCallback(async () => {
    if (voice == null || props.environmentId == null) return;
    setHistoryOpen(true);
    const conversations = await voice.listConversations(props.environmentId);
    setHistory(
      conversations.map((item) => ({
        id: item.conversationId,
        title: item.title ?? null,
        conversationId: item.conversationId,
      })),
    );
  }, [voice, props.environmentId]);

  if (voice == null) return null;

  const capabilities =
    props.environmentId != null
      ? voice.capabilitiesByEnvironment.get(props.environmentId)
      : undefined;
  const realtimeReady =
    capabilities?.capabilities.some(
      (item: { capability: string; state: string }) =>
        item.capability === "agent.realtime" && item.state === "ready",
    ) === true;

  const barPhase = realtimeVoiceBarPhase(voice.snapshot);
  const transcript = voice.snapshot.mode === "realtime" ? voice.snapshot.transcript : [];
  const muted = voice.snapshot.mode === "realtime" ? voice.snapshot.muted : false;
  const confirmation =
    voice.snapshot.mode === "realtime" ? (voice.snapshot.pendingConfirmations[0] ?? null) : null;
  const clientAction =
    voice.snapshot.mode === "realtime" ? (voice.snapshot.pendingClientActions[0] ?? null) : null;

  if (barPhase === "idle" && !realtimeReady && voice.multiTab.role === "leader") {
    return null;
  }

  return (
    <div
      className={cn(
        "border-t border-border bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        props.className,
      )}
    >
      {voice.multiTab.role !== "leader" && voice.multiTab.leaderTabId != null ? (
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Voice is active in another tab.</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void voice.runtime.requestMultiTabTakeover().then(() => startOrResume())}
          >
            Take over
          </Button>
        </div>
      ) : null}

      {confirmation != null ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{confirmation.summary}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void voice.runtime.decideRealtimeConfirmation(confirmation.confirmationId, "reject")
            }
          >
            Reject
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void voice.runtime.decideRealtimeConfirmation(confirmation.confirmationId, "approve")
            }
          >
            Approve
          </Button>
        </div>
      ) : null}

      {clientAction != null ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">Realtime wants to open a thread.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void voice.runtime.completeRealtimeClientAction(clientAction.actionId, "failed")
            }
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void voice.runtime.completeRealtimeClientAction(clientAction.actionId, "succeeded")
            }
          >
            Open
          </Button>
        </div>
      ) : null}

      {voice.snapshot.mode === "failed" ? (
        <div className="mb-2 flex items-center justify-between gap-2 text-sm text-destructive">
          <span className="min-w-0 flex-1">{voice.snapshot.failure.message}</span>
          <Button size="sm" variant="outline" onClick={() => void voice.runtime.stop()}>
            Dismiss
          </Button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {barPhase === "idle"
              ? "Voice conversation"
              : barPhase === "starting"
                ? "Connecting Realtime…"
                : barPhase === "stopping"
                  ? "Ending Realtime…"
                  : barPhase === "error"
                    ? "Realtime failed"
                    : "Realtime active"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {barPhase === "active"
              ? (transcript.at(-1)?.text ?? "Listening…")
              : realtimeReady
                ? "Start or resume a Realtime voice call"
                : "Realtime voice is not ready on this environment"}
          </div>
        </div>

        {barPhase === "idle" || barPhase === "error" ? (
          <>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Browse voice conversations"
              disabled={!realtimeReady || busy || props.environmentId == null}
              onClick={() => void openHistory()}
            >
              <History className="size-4" />
            </Button>
            <Button
              size="sm"
              disabled={!realtimeReady || busy || props.environmentId == null}
              onClick={() => void startOrResume()}
            >
              <Play className="size-3.5" />
              Start
            </Button>
          </>
        ) : (
          <>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => void voice.runtime.setRealtimeMuted(!muted)}
            >
              {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Open transcript"
              onClick={() => setTranscriptOpen((open) => !open)}
            >
              <MessageSquareText className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void voice.runtime.stop()}
            >
              <PhoneOff className="size-3.5" />
              Stop
            </Button>
          </>
        )}
      </div>

      {transcriptOpen && transcript.length > 0 ? (
        <div className="mt-2 max-h-40 space-y-2 overflow-y-auto rounded-md border border-border p-2 text-sm">
          {transcript.map((turn, index) => (
            <div key={`${turn.role}-${index}`}>
              <div className="text-xs font-medium text-muted-foreground">
                {turn.role === "user" ? "You" : "T3"}
              </div>
              <div>{turn.text}</div>
            </div>
          ))}
        </div>
      ) : null}

      {historyOpen ? (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium">Conversations</span>
            <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(false)}>
              Close
            </Button>
          </div>
          {history.length === 0 ? (
            <div className="text-muted-foreground">No saved conversations</div>
          ) : (
            history.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  if (voice == null || props.environmentId == null) return;
                  setHistoryOpen(false);
                  void voice.runtime.startRealtime({
                    environmentId: props.environmentId,
                    conversation: {
                      type: "continue",
                      conversationId: item.conversationId as never,
                      takeover: true,
                    },
                    focus:
                      props.projectId != null && props.threadId != null
                        ? { projectId: props.projectId, threadId: props.threadId }
                        : null,
                    threadSettings: voice.threadSettings,
                  });
                }}
              >
                {item.title ?? item.conversationId}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

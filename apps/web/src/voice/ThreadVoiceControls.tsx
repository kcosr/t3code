import {
  canStartThreadVoiceFromComposer,
  threadVoiceControlState,
} from "@t3tools/client-runtime/voice";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { AudioLines, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { useOptionalVoiceRuntime } from "./VoiceRuntimeContext";

export function ThreadVoiceControls(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly composerEmpty: boolean;
  readonly hasAttachments: boolean;
  readonly interactionRequired: boolean;
  readonly activeThreadBusy: boolean;
  readonly onDictationInsert: (text: string) => void;
  /** When true, show the one-shot dictation mic even if threadId is null (drafts). */
  readonly allowDictationWithoutThread?: boolean;
  /** When false, hide Auto Listen (e.g. drafts). Defaults to true when threadId is set. */
  readonly autoListenEnabled?: boolean;
}) {
  const voice = useOptionalVoiceRuntime();
  const [dictating, setDictating] = useState(false);
  const [reviewDraft, setReviewDraft] = useState("");

  const refreshCapabilities = voice?.refreshCapabilities;
  useEffect(() => {
    if (props.environmentId == null || refreshCapabilities == null) return;
    void refreshCapabilities(props.environmentId);
  }, [props.environmentId, refreshCapabilities]);

  useEffect(() => {
    if (voice?.snapshot.mode === "thread" && voice.snapshot.phase === "reviewing") {
      setReviewDraft(voice.snapshot.transcript ?? "");
    }
  }, [voice?.snapshot]);

  const capabilities =
    props.environmentId != null && voice != null
      ? voice.capabilitiesByEnvironment.get(props.environmentId)
      : undefined;
  const sttReady =
    capabilities?.capabilities.some(
      (item: { capability: string; state: string }) =>
        item.capability === "transcription.request" && item.state === "ready",
    ) === true;

  const control =
    voice != null && props.environmentId != null && props.threadId != null
      ? threadVoiceControlState(voice.snapshot, {
          environmentId: props.environmentId,
          threadId: props.threadId,
        })
      : null;

  const canStartAutoListen =
    voice != null &&
    props.environmentId != null &&
    props.projectId != null &&
    props.threadId != null &&
    props.modelSelection != null &&
    sttReady &&
    canStartThreadVoiceFromComposer({
      preferencesReady: true,
      composerDraftsReady: true,
      composerContentEmpty: props.composerEmpty && !props.hasAttachments,
      interactionRequired: props.interactionRequired,
      activeThreadBusy: props.activeThreadBusy,
    });

  const toggleAutoListen = useCallback(async () => {
    if (
      voice == null ||
      props.environmentId == null ||
      props.projectId == null ||
      props.threadId == null
    ) {
      return;
    }
    if (control?.command === "stop") {
      await voice.runtime.stop();
      return;
    }
    if (!canStartAutoListen || props.modelSelection == null) return;
    if (voice.multiTab.role !== "leader" && voice.multiTab.leaderTabId != null) {
      await voice.runtime.requestMultiTabTakeover();
    }
    await voice.runtime.startThread({
      target: {
        environmentId: props.environmentId,
        projectId: props.projectId,
        threadId: props.threadId,
        modelSelection: props.modelSelection,
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
      },
      settings: voice.threadSettings,
    });
  }, [voice, props, control, canStartAutoListen]);

  const runDictation = useCallback(async () => {
    if (voice == null || props.environmentId == null || dictating || !sttReady) return;
    setDictating(true);
    try {
      if (voice.multiTab.role !== "leader" && voice.multiTab.leaderTabId != null) {
        await voice.runtime.requestMultiTabTakeover();
      }
      // Runtime owns exclusive media gate + multi-tab lock for one-shot STT.
      const text = await voice.runtime.dictate(props.environmentId);
      if (text != null && text.length > 0) {
        props.onDictationInsert(text);
      }
    } catch {
      // Dictation failures are non-fatal for the composer; leave draft unchanged.
    } finally {
      setDictating(false);
    }
  }, [voice, props, dictating, sttReady]);

  const allowDictation = props.allowDictationWithoutThread === true || props.threadId != null;
  const showAutoListen = props.autoListenEnabled !== false && props.threadId != null;

  if (voice == null || props.environmentId == null) {
    return null;
  }
  if (!allowDictation && !showAutoListen) {
    return null;
  }

  const reviewing =
    voice.snapshot.mode === "thread" &&
    voice.snapshot.phase === "reviewing" &&
    voice.snapshot.reviewId != null &&
    props.threadId != null &&
    voice.snapshot.target.threadId === props.threadId;

  return (
    <div className="flex flex-col gap-2">
      {reviewing ? (
        <div className="rounded-md border border-border bg-muted/30 p-2">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Review transcript</div>
          <textarea
            className="mb-2 min-h-16 w-full rounded-md border border-border bg-background p-2 text-sm"
            value={reviewDraft}
            onChange={(event) => {
              setReviewDraft(event.target.value);
              if (voice.snapshot.mode === "thread" && voice.snapshot.reviewId != null) {
                void voice.runtime.updateThreadReviewTranscript(
                  { generation: voice.snapshot.generation, reviewId: voice.snapshot.reviewId },
                  event.target.value,
                );
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => void voice.runtime.stop()}>
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (voice.snapshot.mode !== "thread" || voice.snapshot.reviewId == null) return;
                void voice.runtime.submitThreadTranscript(
                  { generation: voice.snapshot.generation, reviewId: voice.snapshot.reviewId },
                  reviewDraft,
                );
              }}
            >
              Submit
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        {allowDictation ? (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Dictate into composer"
            disabled={!sttReady || dictating || props.interactionRequired}
            onClick={() => void runDictation()}
            title={sttReady ? "Dictate into draft" : "Transcription not ready"}
          >
            <Mic className="size-4" />
          </Button>
        ) : null}
        {showAutoListen ? (
          <Button
            size="icon-sm"
            variant={control?.active ? "default" : "outline"}
            aria-label={control?.accessibilityLabel ?? "Start Auto Listen"}
            disabled={
              control?.command === "start"
                ? !canStartAutoListen || control.blockedByAnotherTarget
                : false
            }
            onClick={() => void toggleAutoListen()}
            title={control?.accessibilityLabel ?? "Auto Listen"}
          >
            {control?.active ? <Square className="size-3.5" /> : <AudioLines className="size-4" />}
          </Button>
        ) : null}
        {voice.snapshot.mode === "thread" ? (
          <span className="text-xs text-muted-foreground capitalize">{voice.snapshot.phase}</span>
        ) : null}
      </div>
    </div>
  );
}

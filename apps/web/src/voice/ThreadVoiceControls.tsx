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
import { encodeMonoPcmToAacMp4 } from "./mp4Encode";
import { requestMicrophoneStream, startAudioCapture, waitForEndpoint } from "./audioCapture";
import { makeWebVoiceHttpClient } from "./webVoiceHttpClient";
import { readPreparedConnection } from "../state/session";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { VoiceRequestId } from "@t3tools/contracts";

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
}) {
  const voice = useOptionalVoiceRuntime();
  const [dictating, setDictating] = useState(false);
  const [reviewDraft, setReviewDraft] = useState("");

  useEffect(() => {
    if (props.environmentId == null || voice == null) return;
    void voice.refreshCapabilities(props.environmentId);
  }, [props.environmentId, voice]);

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
    if (voice == null || props.environmentId == null || dictating) return;
    const prepared = readPreparedConnection(props.environmentId);
    if (prepared === null || !sttReady) return;
    setDictating(true);
    try {
      if (voice.snapshot.mode !== "idle") {
        await voice.runtime.stop();
      }
      const stream = await requestMicrophoneStream();
      const capture = await startAudioCapture(stream);
      try {
        await waitForEndpoint({
          capture,
          config: voice.threadSettings.endpointDetection,
        });
      } catch {
        capture.stop();
        return;
      }
      const pcm = capture.getPcmMono();
      const sampleRate = capture.sampleRate;
      capture.stop();
      if (pcm.length < 1600) return;
      const encoded = await encodeMonoPcmToAacMp4({ pcm, sampleRate });
      const client = await makeWebVoiceHttpClient(prepared);
      const requestId = VoiceRequestId.make(
        `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      );
      const ticket = await Effect.runPromise(
        client.createMediaTicket({ operation: "transcription-upload", requestId }),
      );
      let text = "";
      await Stream.runForEach(
        client.transcribe({
          audio: { kind: "blob", value: encoded.blob, filename: "dictation.mp4" },
          metadata: { requestId, format: "audio/mp4" },
          ticket,
        }),
        (event) =>
          Effect.sync(() => {
            if (event.type === "delta") text += event.text;
            else if (event.type === "final") text = event.result.text;
          }),
      ).pipe(Effect.runPromise);
      const trimmed = text.trim();
      if (trimmed.length > 0) props.onDictationInsert(trimmed);
    } finally {
      setDictating(false);
    }
  }, [voice, props, dictating, sttReady]);

  if (voice == null || props.environmentId == null || props.threadId == null) {
    return null;
  }

  const reviewing =
    voice.snapshot.mode === "thread" &&
    voice.snapshot.phase === "reviewing" &&
    voice.snapshot.reviewId != null;

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
        {voice.snapshot.mode === "thread" ? (
          <span className="text-xs text-muted-foreground capitalize">{voice.snapshot.phase}</span>
        ) : null}
      </div>
    </div>
  );
}

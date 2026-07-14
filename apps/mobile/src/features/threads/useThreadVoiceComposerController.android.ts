import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  VoiceModeSessionId,
  VoiceTurnClientOperationId,
  type VoiceRuntimeDraftContext,
} from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { applyVoiceArtifact } from "../../state/use-composer-drafts";
import { useMasterVoice } from "../voice/MasterVoiceProvider";
import {
  voiceStopIntent,
  voiceWaveformIntent,
  type VoiceWaveformIntentInput,
} from "../voice/canonicalVoiceViewModel";
import type { ThreadVoiceComposerControllerInput } from "./threadVoiceComposerControllerTypes";
import { consumeAndroidVoiceDraftArtifact } from "./androidVoiceDraftArtifactController";

export function useThreadVoiceComposerController(input: ThreadVoiceComposerControllerInput) {
  const { props, dictation } = input;
  const master = useMasterVoice();
  if (master.executionModel !== "autonomous") {
    throw new Error("The Android Thread voice controller requires the autonomous runtime.");
  }
  const composerRevisionRef = useRef(uuidv4());
  const draftArtifactApplicationsRef = useRef(new Set<string>());
  const operation = master.snapshot?.operation ?? null;
  const autoListenActive = operation?.kind === "thread-turn" && master.voice?.active === true;
  const realtimeInUse = operation?.kind === "realtime" && master.voice?.active === true;
  const canStartAutoListen =
    dictation.available &&
    props.draftMessage.trim().length === 0 &&
    props.draftAttachments.length === 0 &&
    !props.interactionRequired;
  const autoListenState = useMemo(
    () => ({
      phase:
        operation?.kind === "thread-turn"
          ? operation.phase.phase
          : master.voice?.uiPhase === "failed"
            ? "paused"
            : "idle",
    }),
    [master.voice?.uiPhase, operation],
  );

  useEffect(() => {
    const artifact = master.draftArtifact;
    if (
      artifact === null ||
      artifact.handle.target.environmentId !== props.environmentId ||
      artifact.handle.target.projectId !== props.selectedThread.projectId ||
      artifact.handle.target.threadId !== props.selectedThread.id
    ) {
      return;
    }
    const artifactId = artifact.handle.artifactId;
    if (draftArtifactApplicationsRef.current.has(artifactId)) return;
    draftArtifactApplicationsRef.current.add(artifactId);
    void consumeAndroidVoiceDraftArtifact({
      artifact,
      draftKey: scopedThreadKey(props.environmentId, props.selectedThread.id),
      now: Date.now(),
      dependencies: {
        apply: applyVoiceArtifact,
        acknowledge: master.completeDraftArtifact,
      },
    })
      .then(() => {
        composerRevisionRef.current = uuidv4();
      })
      .catch((cause: unknown) => {
        console.warn("[voice-runtime] could not apply draft artifact", {
          artifactId,
          cause: cause instanceof Error ? cause.message : "Unknown draft persistence failure.",
        });
      })
      .finally(() => {
        draftArtifactApplicationsRef.current.delete(artifactId);
      });
  }, [
    master.completeDraftArtifact,
    master.draftArtifact,
    props.environmentId,
    props.selectedThread.id,
    props.selectedThread.projectId,
  ]);

  const stopNativeMode = useCallback(async () => {
    if (master.snapshot === null) return;
    const intent = voiceStopIntent(
      master.snapshot,
      master.snapshot.operation.kind === "realtime" ? "drain" : "immediate",
    );
    if (intent !== null) await master.dispatch(intent);
  }, [master]);

  const toggleDictation = useCallback(async () => {
    if (dictation.phase === "recording") {
      await dictation.stop();
      return;
    }
    if (master.voice?.active === true) await stopNativeMode();
    await props.speechPlayback.interrupt();
    await dictation.start();
  }, [dictation, master.voice?.active, props.speechPlayback, stopNativeMode]);

  const toggleAutoListenOperation = useCallback(async () => {
    const current = master.snapshot;
    const draftContext: VoiceRuntimeDraftContext = {
      environmentId: props.environmentId,
      projectId: props.selectedThread.projectId,
      threadId: props.selectedThread.id,
      composerRevision: composerRevisionRef.current,
    };
    const start: VoiceWaveformIntentInput = {
      modeSessionId: VoiceModeSessionId.make(uuidv4()),
      turnClientOperationId: VoiceTurnClientOperationId.make(uuidv4()),
      submissionPolicy: "auto-submit",
      draftContext,
      interruptionPolicy: "drain-conflicting",
    };
    if (current !== null && current.operation.kind === "thread-turn") {
      const intent = voiceWaveformIntent(current, start);
      if (intent !== null) await master.dispatch(intent);
      return;
    }
    await dictation.cancelForRealtime();
    if (current?.operation.kind === "realtime") await master.stop();
    const provisioned = await master.ensureMode("thread");
    const intent = voiceWaveformIntent(provisioned, start);
    if (intent !== null) await master.dispatch(intent);
  }, [dictation, master, props.environmentId, props.selectedThread]);

  const submitAutoListenReview = useCallback(
    async () => ({ handled: false, submitted: false }) as const,
    [],
  );

  return {
    realtimeInUse,
    autoListenState,
    autoListenActive,
    canStartAutoListen,
    toggleDictation,
    toggleAutoListenOperation,
    submitAutoListenReview,
  } as const;
}

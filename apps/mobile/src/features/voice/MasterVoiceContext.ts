import type { VoiceRuntimeCommandRequest } from "@t3tools/client-runtime/voice";
import type {
  EnvironmentId,
  ThreadId,
  VoiceDraftArtifact,
  VoiceRuntimePresentationAction,
  VoiceRuntimeSnapshot,
} from "@t3tools/contracts";
import type {
  T3VoiceCommandEvent,
  T3VoiceThreadVoiceHandoffEvent,
} from "@t3tools/mobile-voice-native";
import { createContext, use } from "react";

import type { CanonicalVoiceViewModel } from "./canonicalVoiceViewModel";
import type { RealtimeVoiceControllerSnapshot } from "./realtimeVoiceController";

export interface AutonomousMasterVoiceContextValue {
  readonly executionModel: "autonomous";
  readonly snapshot: VoiceRuntimeSnapshot | null;
  readonly voice: CanonicalVoiceViewModel | null;
  readonly presentationAction: VoiceRuntimePresentationAction | null;
  readonly draftArtifact: VoiceDraftArtifact | null;
  readonly dispatch: (request: VoiceRuntimeCommandRequest) => Promise<void>;
  readonly ensureMode: (mode: "realtime" | "thread") => Promise<VoiceRuntimeSnapshot>;
  readonly completePresentationAction: (
    actionId: VoiceRuntimePresentationAction["actionId"],
    outcome: "succeeded" | "failed",
    message?: string,
  ) => void;
  readonly completeDraftArtifact: (
    artifactId: VoiceDraftArtifact["handle"]["artifactId"],
    outcome: "appended" | "discarded",
  ) => boolean;
  readonly stop: () => Promise<void>;
  readonly active: boolean;
  readonly suppressAutomaticThreadSpeech: boolean;
  readonly nativeAssistantMessageIds: ReadonlySet<string>;
}

export interface UiAttachedMasterVoiceContextValue {
  readonly executionModel: "ui-attached";
  readonly phase: RealtimeVoiceControllerSnapshot["phase"];
  readonly stop: () => Promise<void>;
  readonly active: boolean;
  readonly suppressAutomaticThreadSpeech: boolean;
  readonly nativeAssistantMessageIds: ReadonlySet<string>;
  readonly registerTraditionalAudioInterruption: (
    interrupt: () => void | (() => void) | Promise<void | (() => void)>,
  ) => () => void;
  readonly threadVoiceHandoff:
    | (T3VoiceThreadVoiceHandoffEvent & {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly acceptedAtEpochMillis: number;
      })
    | null;
  readonly settleThreadVoiceHandoff: (
    actionId: string,
    outcome: "adopted" | "failed",
  ) => Promise<void>;
  readonly beginThreadVoiceHandoffAdoption: (actionId: string) => (() => void) | null;
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

export type MasterVoiceContextValue =
  | AutonomousMasterVoiceContextValue
  | UiAttachedMasterVoiceContextValue;

export const MasterVoiceContext = createContext<MasterVoiceContextValue | null>(null);

export function useMasterVoice(): MasterVoiceContextValue {
  const context = use(MasterVoiceContext);
  if (context === null) throw new Error("useMasterVoice must be used inside MasterVoiceProvider");
  return context;
}

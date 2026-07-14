import type { ReturnTypeOfComposerDictation } from "../voice/useComposerDictation";
import type { ResolvedVoicePreferences } from "../voice/voicePreferences";
import type { ThreadComposerProps } from "./ThreadComposer";

export interface ThreadVoiceComposerControllerInput {
  readonly props: ThreadComposerProps;
  readonly dictation: ReturnTypeOfComposerDictation;
  readonly voicePreferences: ResolvedVoicePreferences;
  readonly spokenResponsesEnabled: boolean;
  readonly persistedTargetGeneration: number;
}

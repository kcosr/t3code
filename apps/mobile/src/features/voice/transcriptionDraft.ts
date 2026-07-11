import type { VoiceTranscriptionStreamEvent } from "@t3tools/contracts";

export interface TranscriptionDraftState {
  readonly prefix: string;
  readonly transcript: string;
}

export const beginTranscriptionDraft = (draft: string): TranscriptionDraftState => ({
  prefix: draft.length === 0 || /\s$/.test(draft) ? draft : `${draft} `,
  transcript: "",
});

export const applyTranscriptionEvent = (
  state: TranscriptionDraftState,
  event: VoiceTranscriptionStreamEvent,
): TranscriptionDraftState => ({
  ...state,
  transcript: event.type === "delta" ? state.transcript + event.text : event.result.text,
});

export const renderTranscriptionDraft = (state: TranscriptionDraftState): string =>
  `${state.prefix}${state.transcript}`;

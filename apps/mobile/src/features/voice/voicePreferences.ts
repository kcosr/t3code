import type { Preferences } from "../../persistence/mobile-preferences";
import {
  clampVoicePreference,
  VOICE_END_SILENCE_MAX_MS,
  VOICE_END_SILENCE_MIN_MS,
  VOICE_MAXIMUM_UTTERANCE_MAX_MS,
  VOICE_MAXIMUM_UTTERANCE_MIN_MS,
  VOICE_NO_SPEECH_MAX_MS,
  VOICE_NO_SPEECH_MIN_MS,
  VOICE_REARM_GUARD_MAX_MS,
  VOICE_REARM_GUARD_MIN_MS,
  VOICE_RESPONSE_TIMEOUT_MAX_MS,
  VOICE_RESPONSE_TIMEOUT_MIN_MS,
  VOICE_SUBMISSION_TIMEOUT_MAX_MS,
  VOICE_SUBMISSION_TIMEOUT_MIN_MS,
  VOICE_TRANSCRIPTION_TIMEOUT_MAX_MS,
  VOICE_TRANSCRIPTION_TIMEOUT_MIN_MS,
} from "../../lib/voicePreferenceBounds";

export * from "../../lib/voicePreferenceBounds";

export const VOICE_END_SILENCE_DEFAULT_MS = 2_200;

export const VOICE_NO_SPEECH_DEFAULT_MS = 30_000;

export const VOICE_MAXIMUM_UTTERANCE_DEFAULT_MS = VOICE_MAXIMUM_UTTERANCE_MAX_MS;

export const VOICE_REARM_GUARD_DEFAULT_MS = 750;

export const VOICE_TRANSCRIPTION_TIMEOUT_DEFAULT_MS = 10 * 60_000;
export const VOICE_SUBMISSION_TIMEOUT_DEFAULT_MS = 30_000;
export const VOICE_RESPONSE_TIMEOUT_DEFAULT_MS = 10 * 60_000;

export interface ResolvedVoicePreferences {
  readonly autoListenEnabled: boolean;
  readonly autoSubmitEnabled: boolean;
  readonly endSilenceMs: number;
  readonly noSpeechTimeoutMs: number | null;
  readonly maximumUtteranceMs: number;
  readonly postPlaybackGuardMs: number;
  readonly transcriptionTimeoutMs: number;
  readonly submissionTimeoutMs: number;
  readonly responseTimeoutMs: number;
}

const clampRounded = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => clampVoicePreference(value ?? fallback, minimum, maximum);

export function resolveVoicePreferences(preferences: Preferences): ResolvedVoicePreferences {
  return {
    autoListenEnabled: preferences.voiceAutoListenEnabled === true,
    autoSubmitEnabled: preferences.voiceAutoSubmitEnabled !== false,
    endSilenceMs: clampRounded(
      preferences.voiceEndSilenceMs,
      VOICE_END_SILENCE_DEFAULT_MS,
      VOICE_END_SILENCE_MIN_MS,
      VOICE_END_SILENCE_MAX_MS,
    ),
    noSpeechTimeoutMs:
      preferences.voiceNoSpeechTimeoutMs === null ||
      preferences.voiceNoSpeechTimeoutMs === undefined
        ? null
        : clampRounded(
            preferences.voiceNoSpeechTimeoutMs,
            VOICE_NO_SPEECH_DEFAULT_MS,
            VOICE_NO_SPEECH_MIN_MS,
            VOICE_NO_SPEECH_MAX_MS,
          ),
    maximumUtteranceMs: clampRounded(
      preferences.voiceMaximumUtteranceMs,
      VOICE_MAXIMUM_UTTERANCE_DEFAULT_MS,
      VOICE_MAXIMUM_UTTERANCE_MIN_MS,
      VOICE_MAXIMUM_UTTERANCE_MAX_MS,
    ),
    postPlaybackGuardMs: clampRounded(
      preferences.voicePostPlaybackGuardMs,
      VOICE_REARM_GUARD_DEFAULT_MS,
      VOICE_REARM_GUARD_MIN_MS,
      VOICE_REARM_GUARD_MAX_MS,
    ),
    transcriptionTimeoutMs: clampRounded(
      preferences.voiceTranscriptionTimeoutMs,
      VOICE_TRANSCRIPTION_TIMEOUT_DEFAULT_MS,
      VOICE_TRANSCRIPTION_TIMEOUT_MIN_MS,
      VOICE_TRANSCRIPTION_TIMEOUT_MAX_MS,
    ),
    submissionTimeoutMs: clampRounded(
      preferences.voiceSubmissionTimeoutMs,
      VOICE_SUBMISSION_TIMEOUT_DEFAULT_MS,
      VOICE_SUBMISSION_TIMEOUT_MIN_MS,
      VOICE_SUBMISSION_TIMEOUT_MAX_MS,
    ),
    responseTimeoutMs: clampRounded(
      preferences.voiceResponseTimeoutMs,
      VOICE_RESPONSE_TIMEOUT_DEFAULT_MS,
      VOICE_RESPONSE_TIMEOUT_MIN_MS,
      VOICE_RESPONSE_TIMEOUT_MAX_MS,
    ),
  };
}

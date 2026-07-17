export const VOICE_END_SILENCE_MIN_MS = 500;
export const VOICE_END_SILENCE_MAX_MS = 10_000;
export const VOICE_END_SILENCE_STEP_MS = 100;

export const VOICE_NO_SPEECH_MIN_MS = 10_000;
export const VOICE_NO_SPEECH_MAX_MS = 120_000;

export const VOICE_MAXIMUM_UTTERANCE_MIN_MS = 60_000;
export const VOICE_MAXIMUM_UTTERANCE_MAX_MS = 30 * 60_000;

export const VOICE_REARM_GUARD_MIN_MS = 250;
export const VOICE_REARM_GUARD_MAX_MS = 3_000;

export const VOICE_TRANSCRIPTION_TIMEOUT_MIN_MS = 60_000;
export const VOICE_TRANSCRIPTION_TIMEOUT_MAX_MS = 30 * 60_000;
export const VOICE_SUBMISSION_TIMEOUT_MIN_MS = 10_000;
export const VOICE_SUBMISSION_TIMEOUT_MAX_MS = 120_000;
export const VOICE_RESPONSE_TIMEOUT_MIN_MS = 60_000;
export const VOICE_RESPONSE_TIMEOUT_MAX_MS = 30 * 60_000;

export const clampVoicePreference = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));

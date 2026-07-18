import { describe, expect, it } from "vite-plus/test";

import {
  resolveVoicePreferences,
  VOICE_END_SILENCE_DEFAULT_MS,
  VOICE_MAXIMUM_UTTERANCE_DEFAULT_MS,
  VOICE_REARM_GUARD_DEFAULT_MS,
  VOICE_RESPONSE_TIMEOUT_DEFAULT_MS,
  VOICE_SUBMISSION_TIMEOUT_DEFAULT_MS,
  VOICE_TRANSCRIPTION_TIMEOUT_DEFAULT_MS,
} from "./voicePreferences";

describe("resolveVoicePreferences", () => {
  it("uses opt-in Auto Listen with long-form recording defaults", () => {
    expect(resolveVoicePreferences({})).toEqual({
      autoListenEnabled: false,
      autoSubmitEnabled: true,
      endSilenceMs: VOICE_END_SILENCE_DEFAULT_MS,
      noSpeechTimeoutMs: null,
      maximumUtteranceMs: VOICE_MAXIMUM_UTTERANCE_DEFAULT_MS,
      postPlaybackGuardMs: VOICE_REARM_GUARD_DEFAULT_MS,
      transcriptionTimeoutMs: VOICE_TRANSCRIPTION_TIMEOUT_DEFAULT_MS,
      submissionTimeoutMs: VOICE_SUBMISSION_TIMEOUT_DEFAULT_MS,
      responseTimeoutMs: VOICE_RESPONSE_TIMEOUT_DEFAULT_MS,
    });
  });

  it("clamps persisted timings and preserves a disabled start timeout", () => {
    expect(
      resolveVoicePreferences({
        voiceAutoListenEnabled: true,
        voiceAutoSubmitEnabled: false,
        voiceEndSilenceMs: 100,
        voiceNoSpeechTimeoutMs: null,
        voiceMaximumUtteranceMs: 99_000_000,
        voicePostPlaybackGuardMs: 99_000,
        voiceResponseTimeoutMs: 1,
      }),
    ).toEqual({
      autoListenEnabled: true,
      autoSubmitEnabled: false,
      endSilenceMs: 500,
      noSpeechTimeoutMs: null,
      maximumUtteranceMs: 30 * 60_000,
      postPlaybackGuardMs: 2_000,
      transcriptionTimeoutMs: VOICE_TRANSCRIPTION_TIMEOUT_DEFAULT_MS,
      submissionTimeoutMs: VOICE_SUBMISSION_TIMEOUT_DEFAULT_MS,
      responseTimeoutMs: 60_000,
    });
  });
});

import type { VoiceThreadSettings } from "@t3tools/client-runtime/voice";

export const DEFAULT_WEB_VOICE_THREAD_SETTINGS: VoiceThreadSettings = {
  submission: "review",
  playResponses: true,
  autoRearm: false,
  endpointDetection: {
    endSilenceMs: 900,
    noSpeechTimeoutMs: 8_000,
    maximumUtteranceMs: 60_000,
  },
  rearmDelayMs: 750,
  transcriptionTimeoutMs: 45_000,
  submissionTimeoutMs: 30_000,
  responseTimeoutMs: 180_000,
};

const STORAGE_KEY = "t3code:web-voice-thread-settings";

export function loadWebVoiceThreadSettings(): VoiceThreadSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_WEB_VOICE_THREAD_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VoiceThreadSettings>;
    return {
      ...DEFAULT_WEB_VOICE_THREAD_SETTINGS,
      ...parsed,
      endpointDetection: {
        ...DEFAULT_WEB_VOICE_THREAD_SETTINGS.endpointDetection,
        ...(parsed.endpointDetection ?? {}),
      },
    };
  } catch {
    return DEFAULT_WEB_VOICE_THREAD_SETTINGS;
  }
}

export function saveWebVoiceThreadSettings(settings: VoiceThreadSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota / private mode
  }
}

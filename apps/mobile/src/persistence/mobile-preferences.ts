import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileDatabase from "./mobile-database";
import * as MobileSecureStorage from "./mobile-secure-storage";
import { MobileStorageDecodeError, MobileStorageEncodeError } from "./mobile-storage";
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
} from "../lib/voicePreferenceBounds";

const PREFERENCES_KEY = "t3code.preferences";
const PREFERENCES_FALLBACK_KEY = "t3code.preferences.fallback";

export interface Preferences {
  readonly liveActivitiesEnabled?: boolean;
  readonly threadSpeechEnabled?: boolean;
  readonly voiceAudioRouteId?: string;
  readonly voiceAutoListenEnabled?: boolean;
  readonly voiceAutoSubmitEnabled?: boolean;
  readonly voiceCuesEnabled?: boolean;
  readonly voiceEndSilenceMs?: number;
  readonly voiceNoSpeechTimeoutMs?: number | null;
  readonly voiceMaximumUtteranceMs?: number;
  readonly voicePostPlaybackGuardMs?: number;
  readonly voiceTranscriptionTimeoutMs?: number;
  readonly voiceSubmissionTimeoutMs?: number;
  readonly voiceResponseTimeoutMs?: number;
  readonly voiceMode?: "off" | "realtime" | "thread";
  readonly voiceNotificationControlsEnabled?: boolean;
  readonly voiceNotificationDefaultMode?: "realtime" | "thread";
  readonly voiceThreadTarget?: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly generation: number;
  } | null;
  readonly baseFontSize?: number;
  readonly terminalFontSize?: number | null;
  readonly markdownFontSize?: number;
  readonly codeFontSize?: number | null;
  readonly codeWordBreak?: boolean;
  readonly connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
  readonly collapsedProjectGroups?: readonly string[];
}

export class MobilePreferencesLoadError extends Schema.TaggedErrorClass<MobilePreferencesLoadError>()(
  "MobilePreferencesLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load mobile preferences.";
  }
}

export class MobilePreferencesSaveError extends Schema.TaggedErrorClass<MobilePreferencesSaveError>()(
  "MobilePreferencesSaveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save mobile preferences.";
  }
}

interface PreferencesFallback {
  readonly payload: string;
  readonly updatedAt: number;
  readonly preferences: Preferences;
}

export class MobilePreferencesStore extends Context.Service<
  MobilePreferencesStore,
  {
    readonly load: Effect.Effect<Preferences, MobilePreferencesLoadError>;
    readonly savePatch: (
      patch: Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
    readonly update: (
      transform: (current: Preferences) => Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
  }
>()("@t3tools/mobile/persistence/MobilePreferencesStore") {}

function sanitizePreferences(parsed: Preferences): Preferences {
  const preferences: {
    liveActivitiesEnabled?: boolean;
    threadSpeechEnabled?: boolean;
    voiceAudioRouteId?: string;
    voiceAutoListenEnabled?: boolean;
    voiceAutoSubmitEnabled?: boolean;
    voiceCuesEnabled?: boolean;
    voiceEndSilenceMs?: number;
    voiceNoSpeechTimeoutMs?: number | null;
    voiceMaximumUtteranceMs?: number;
    voicePostPlaybackGuardMs?: number;
    voiceTranscriptionTimeoutMs?: number;
    voiceSubmissionTimeoutMs?: number;
    voiceResponseTimeoutMs?: number;
    voiceMode?: "off" | "realtime" | "thread";
    voiceNotificationControlsEnabled?: boolean;
    voiceNotificationDefaultMode?: "realtime" | "thread";
    voiceThreadTarget?: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly generation: number;
    };
    baseFontSize?: number;
    terminalFontSize?: number | null;
    markdownFontSize?: number;
    codeFontSize?: number | null;
    codeWordBreak?: boolean;
    connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
    collapsedProjectGroups?: readonly string[];
  } = {};

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (typeof parsed.threadSpeechEnabled === "boolean") {
    preferences.threadSpeechEnabled = parsed.threadSpeechEnabled;
  }
  if (typeof parsed.voiceAudioRouteId === "string" && parsed.voiceAudioRouteId.length > 0) {
    preferences.voiceAudioRouteId = parsed.voiceAudioRouteId;
  }
  if (typeof parsed.voiceAutoListenEnabled === "boolean") {
    preferences.voiceAutoListenEnabled = parsed.voiceAutoListenEnabled;
  }
  if (typeof parsed.voiceAutoSubmitEnabled === "boolean") {
    preferences.voiceAutoSubmitEnabled = parsed.voiceAutoSubmitEnabled;
  }
  if (typeof parsed.voiceCuesEnabled === "boolean") {
    preferences.voiceCuesEnabled = parsed.voiceCuesEnabled;
  }
  if (Number.isFinite(parsed.voiceEndSilenceMs)) {
    preferences.voiceEndSilenceMs = clampVoicePreference(
      parsed.voiceEndSilenceMs!,
      VOICE_END_SILENCE_MIN_MS,
      VOICE_END_SILENCE_MAX_MS,
    );
  }
  if (parsed.voiceNoSpeechTimeoutMs === null || Number.isFinite(parsed.voiceNoSpeechTimeoutMs)) {
    preferences.voiceNoSpeechTimeoutMs =
      parsed.voiceNoSpeechTimeoutMs === null
        ? null
        : clampVoicePreference(
            parsed.voiceNoSpeechTimeoutMs!,
            VOICE_NO_SPEECH_MIN_MS,
            VOICE_NO_SPEECH_MAX_MS,
          );
  }
  if (Number.isFinite(parsed.voiceMaximumUtteranceMs)) {
    preferences.voiceMaximumUtteranceMs = clampVoicePreference(
      parsed.voiceMaximumUtteranceMs!,
      VOICE_MAXIMUM_UTTERANCE_MIN_MS,
      VOICE_MAXIMUM_UTTERANCE_MAX_MS,
    );
  }
  if (Number.isFinite(parsed.voicePostPlaybackGuardMs)) {
    preferences.voicePostPlaybackGuardMs = clampVoicePreference(
      parsed.voicePostPlaybackGuardMs!,
      VOICE_REARM_GUARD_MIN_MS,
      VOICE_REARM_GUARD_MAX_MS,
    );
  }
  if (Number.isFinite(parsed.voiceTranscriptionTimeoutMs)) {
    preferences.voiceTranscriptionTimeoutMs = clampVoicePreference(
      parsed.voiceTranscriptionTimeoutMs!,
      VOICE_TRANSCRIPTION_TIMEOUT_MIN_MS,
      VOICE_TRANSCRIPTION_TIMEOUT_MAX_MS,
    );
  }
  if (Number.isFinite(parsed.voiceSubmissionTimeoutMs)) {
    preferences.voiceSubmissionTimeoutMs = clampVoicePreference(
      parsed.voiceSubmissionTimeoutMs!,
      VOICE_SUBMISSION_TIMEOUT_MIN_MS,
      VOICE_SUBMISSION_TIMEOUT_MAX_MS,
    );
  }
  if (Number.isFinite(parsed.voiceResponseTimeoutMs)) {
    preferences.voiceResponseTimeoutMs = clampVoicePreference(
      parsed.voiceResponseTimeoutMs!,
      VOICE_RESPONSE_TIMEOUT_MIN_MS,
      VOICE_RESPONSE_TIMEOUT_MAX_MS,
    );
  }
  if (
    parsed.voiceMode === "off" ||
    parsed.voiceMode === "realtime" ||
    parsed.voiceMode === "thread"
  ) {
    preferences.voiceMode = parsed.voiceMode;
  }
  if (typeof parsed.voiceNotificationControlsEnabled === "boolean") {
    preferences.voiceNotificationControlsEnabled = parsed.voiceNotificationControlsEnabled;
  }
  if (
    parsed.voiceNotificationDefaultMode === "realtime" ||
    parsed.voiceNotificationDefaultMode === "thread"
  ) {
    preferences.voiceNotificationDefaultMode = parsed.voiceNotificationDefaultMode;
  }
  const voiceThreadTarget = parsed.voiceThreadTarget;
  if (
    typeof voiceThreadTarget === "object" &&
    voiceThreadTarget !== null &&
    typeof voiceThreadTarget.environmentId === "string" &&
    voiceThreadTarget.environmentId.length > 0 &&
    typeof voiceThreadTarget.threadId === "string" &&
    voiceThreadTarget.threadId.length > 0 &&
    Number.isSafeInteger(voiceThreadTarget.generation) &&
    voiceThreadTarget.generation > 0
  ) {
    preferences.voiceThreadTarget = voiceThreadTarget;
  }
  if (typeof parsed.baseFontSize === "number") preferences.baseFontSize = parsed.baseFontSize;
  if (typeof parsed.terminalFontSize === "number" || parsed.terminalFontSize === null) {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }
  if (typeof parsed.markdownFontSize === "number") {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }
  if (typeof parsed.codeFontSize === "number" || parsed.codeFontSize === null) {
    preferences.codeFontSize = parsed.codeFontSize;
  }
  if (typeof parsed.codeWordBreak === "boolean") preferences.codeWordBreak = parsed.codeWordBreak;
  if (Array.isArray(parsed.connectOnboardingOptOutAccounts)) {
    preferences.connectOnboardingOptOutAccounts = parsed.connectOnboardingOptOutAccounts.filter(
      (account): account is string => typeof account === "string",
    );
  }
  if (Array.isArray(parsed.collapsedProjectGroups)) {
    preferences.collapsedProjectGroups = parsed.collapsedProjectGroups.filter(
      (key): key is string => typeof key === "string",
    );
  }
  return preferences;
}

export const make = Effect.fn("MobilePreferencesStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
  const lock = yield* Semaphore.make(1);
  const lastUpdatedAt = yield* Ref.make(0);

  const parsePayload = (raw: string | null): Preferences | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_KEY, cause }),
      );
      return null;
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Preferences)
      : null;
  };

  const parseFallback = (raw: string | null): PreferencesFallback | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_FALLBACK_KEY, cause }),
      );
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("payload" in parsed) ||
      typeof parsed.payload !== "string" ||
      !("updatedAt" in parsed) ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    const preferences = parsePayload(parsed.payload);
    return preferences === null
      ? null
      : { payload: parsed.payload, updatedAt: parsed.updatedAt, preferences };
  };

  const encode = Effect.fn("MobilePreferencesStore.encode")(function* (
    key: string,
    value: unknown,
  ) {
    return yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
  });

  const nextUpdatedAt = Ref.modify(lastUpdatedAt, (last) => {
    const next = Math.max(Date.now(), last + 1);
    return [next, next] as const;
  });

  const saveJson = Effect.fn("MobilePreferencesStore.saveJson")(function* (
    payload: string,
    updatedAt?: number,
  ) {
    const timestamp = updatedAt ?? (yield* nextUpdatedAt);
    yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, timestamp));
    const databaseResult = yield* Effect.result(database.savePreferencesJson(payload, timestamp));
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; saving preferences to secure storage.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
      const fallback = yield* encode(PREFERENCES_FALLBACK_KEY, {
        payload,
        updatedAt: timestamp,
      });
      yield* secureStorage.setItem(PREFERENCES_FALLBACK_KEY, fallback);
      return;
    }
    yield* secureStorage
      .removeItem(PREFERENCES_FALLBACK_KEY)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove the mobile preferences fallback.").pipe(
            Effect.annotateLogs({ error }),
          ),
        ),
      );
  });

  const loadUnlocked = Effect.gen(function* () {
    const databaseResult = yield* Effect.result(database.loadPreferencesJson);
    const databaseAvailable = databaseResult._tag === "Success";
    const storedJson = databaseAvailable
      ? databaseResult.success
      : Option.none<MobileDatabase.StoredPreferencesJson>();
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; loading fallback preferences.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
    }

    const fallbackResult = yield* Effect.result(secureStorage.getItem(PREFERENCES_FALLBACK_KEY));
    let fallbackJson: string | null = null;
    if (fallbackResult._tag === "Success") {
      fallbackJson = fallbackResult.success;
    } else if (Option.isNone(storedJson)) {
      return yield* fallbackResult.failure;
    } else {
      yield* Effect.logWarning("Could not inspect the mobile preferences fallback.").pipe(
        Effect.annotateLogs({ error: fallbackResult.failure }),
      );
    }

    const fallback = parseFallback(fallbackJson);
    const storedPreferences = Option.isSome(storedJson)
      ? parsePayload(storedJson.value.payload)
      : null;
    const fallbackIsNewer =
      fallback !== null &&
      (storedPreferences === null ||
        (Option.isSome(storedJson) && fallback.updatedAt > storedJson.value.updatedAt));

    let parsed: Preferences | null = null;
    if (fallbackIsNewer) {
      parsed = fallback.preferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, fallback.updatedAt));
      if (databaseAvailable) yield* saveJson(fallback.payload, fallback.updatedAt);
    } else if (storedPreferences !== null && Option.isSome(storedJson)) {
      parsed = storedPreferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, storedJson.value.updatedAt));
      if (fallbackJson !== null) {
        yield* secureStorage
          .removeItem(PREFERENCES_FALLBACK_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove a stale mobile preferences fallback.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    if (parsed === null) {
      const legacyJson = yield* secureStorage.getItem(PREFERENCES_KEY);
      const legacyPreferences = parsePayload(legacyJson);
      parsed = legacyPreferences;
      if (legacyJson !== null && legacyPreferences !== null && databaseAvailable) {
        yield* saveJson(legacyJson);
        yield* secureStorage
          .removeItem(PREFERENCES_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove migrated mobile preferences.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    return parsed === null ? {} : sanitizePreferences(parsed);
  });

  const load = lock
    .withPermits(1)(loadUnlocked)
    .pipe(Effect.mapError((cause) => new MobilePreferencesLoadError({ cause })));

  const update = Effect.fn("MobilePreferencesStore.update")((transform) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadUnlocked;
          const patch = yield* Effect.try({
            try: () => transform(current),
            catch: (cause) => new MobilePreferencesSaveError({ cause }),
          });
          const next: Preferences = { ...current, ...patch };
          const payload = yield* encode(PREFERENCES_KEY, next);
          yield* saveJson(payload);
          return next;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof MobilePreferencesSaveError
            ? cause
            : new MobilePreferencesSaveError({ cause }),
        ),
      ),
  );

  return MobilePreferencesStore.of({
    load,
    update,
    savePatch: (patch) => update(() => patch),
  });
});

export const layer = Layer.effect(MobilePreferencesStore, make());

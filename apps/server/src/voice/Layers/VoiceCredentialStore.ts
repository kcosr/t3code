import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { VoiceError } from "../Errors.ts";
import {
  VoiceCredentialStore,
  type VoiceCredentialStoreShape,
} from "../Services/VoiceCredentialStore.ts";

const OPENAI_VOICE_API_KEY_SECRET = "voice-openai-api-key";
const OPENAI_VOICE_API_KEY_UPDATED_AT_SECRET = "voice-openai-api-key-updated-at";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const mapSecretError = (operation: string) => (cause: ServerSecretStore.SecretStoreError) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation,
    detail: "Voice credential storage is unavailable",
    retryable: true,
    cause,
  });

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const getOpenAiApiKey = secrets
    .get(OPENAI_VOICE_API_KEY_SECRET)
    .pipe(
      Effect.map(Option.map((bytes) => decoder.decode(bytes))),
      Effect.mapError(mapSecretError("credentials.read")),
    );

  const status = Effect.all({
    key: secrets.get(OPENAI_VOICE_API_KEY_SECRET),
    updatedAt: secrets.get(OPENAI_VOICE_API_KEY_UPDATED_AT_SECRET),
  }).pipe(
    Effect.map(({ key, updatedAt }) => ({
      configured: Option.isSome(key),
      updatedAt: Option.match(updatedAt, {
        onNone: () => null,
        onSome: (bytes) => decoder.decode(bytes),
      }),
    })),
    Effect.mapError(mapSecretError("credentials.status")),
  );

  const setOpenAiApiKey: VoiceCredentialStoreShape["setOpenAiApiKey"] = (apiKey) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* secrets.set(OPENAI_VOICE_API_KEY_SECRET, encoder.encode(apiKey));
      yield* secrets.set(OPENAI_VOICE_API_KEY_UPDATED_AT_SECRET, encoder.encode(updatedAt));
      return { configured: true, updatedAt };
    }).pipe(Effect.mapError(mapSecretError("credentials.write")));

  const clearOpenAiApiKey = Effect.all(
    [
      secrets.remove(OPENAI_VOICE_API_KEY_SECRET),
      secrets.remove(OPENAI_VOICE_API_KEY_UPDATED_AT_SECRET),
    ],
    { discard: true },
  ).pipe(Effect.mapError(mapSecretError("credentials.clear")));

  return {
    status,
    getOpenAiApiKey,
    setOpenAiApiKey,
    clearOpenAiApiKey,
  } satisfies VoiceCredentialStoreShape;
});

export const VoiceCredentialStoreLive = Layer.effect(VoiceCredentialStore, make);

import type { VoiceCredentialProviderId } from "@t3tools/contracts";
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

const PROVIDER_SECRET_KEYS = {
  openai: {
    token: "voice-openai-api-key",
    updatedAt: "voice-openai-api-key-updated-at",
  },
  "openai-speech-server": {
    token: "voice-openai-speech-server-token",
    updatedAt: "voice-openai-speech-server-token-updated-at",
  },
} as const satisfies Record<
  VoiceCredentialProviderId,
  { readonly token: string; readonly updatedAt: string }
>;

const PROVIDER_IDS = Object.keys(PROVIDER_SECRET_KEYS) as Array<VoiceCredentialProviderId>;

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

  const status: VoiceCredentialStoreShape["status"] = (providerId) =>
    Effect.all({
      key: secrets.get(PROVIDER_SECRET_KEYS[providerId].token),
      updatedAt: secrets.get(PROVIDER_SECRET_KEYS[providerId].updatedAt),
    }).pipe(
      Effect.map(({ key, updatedAt }) => ({
        providerId,
        configured: Option.isSome(key),
        updatedAt: Option.match(updatedAt, {
          onNone: () => null,
          onSome: (bytes) => decoder.decode(bytes),
        }),
      })),
      Effect.mapError(mapSecretError("credentials.status")),
    );

  const listStatus = Effect.forEach(PROVIDER_IDS, (providerId) => status(providerId), {
    concurrency: "unbounded",
  }).pipe(Effect.map((credentials) => ({ credentials })));

  const get: VoiceCredentialStoreShape["get"] = (providerId) =>
    secrets
      .get(PROVIDER_SECRET_KEYS[providerId].token)
      .pipe(
        Effect.map(Option.map((bytes) => decoder.decode(bytes))),
        Effect.mapError(mapSecretError("credentials.read")),
      );

  const set: VoiceCredentialStoreShape["set"] = (providerId, token) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* secrets.set(PROVIDER_SECRET_KEYS[providerId].token, encoder.encode(token));
      yield* secrets.set(PROVIDER_SECRET_KEYS[providerId].updatedAt, encoder.encode(updatedAt));
      return { providerId, configured: true, updatedAt };
    }).pipe(Effect.mapError(mapSecretError("credentials.write")));

  const clear: VoiceCredentialStoreShape["clear"] = (providerId) =>
    Effect.gen(function* () {
      yield* secrets.remove(PROVIDER_SECRET_KEYS[providerId].token);
      yield* secrets.remove(PROVIDER_SECRET_KEYS[providerId].updatedAt);
      return { providerId, configured: false, updatedAt: null };
    }).pipe(Effect.mapError(mapSecretError("credentials.clear")));

  return {
    listStatus,
    status,
    get,
    set,
    clear,
  } satisfies VoiceCredentialStoreShape;
});

export const VoiceCredentialStoreLive = Layer.effect(VoiceCredentialStore, make);

import type { VoiceSpeechPreset } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ServerSettingsService } from "../../../serverSettings.ts";
import { VoiceError } from "../../Errors.ts";
import { VoiceCredentialStore } from "../../Services/VoiceCredentialStore.ts";
import type {
  SpeechSynthesizer,
  Transcriber,
  VoiceProviderAdapter,
} from "../../Services/VoiceProvider.ts";
import {
  logOpenAiCompatibleHttpFailure,
  mapOpenAiCompatibleHttpFailure,
  mapTranscriptionSseToVoiceEvents,
  requireCompatiblePcmResponse,
  requireOkHttpResponse,
  sanitizedUpstreamRequestId,
} from "../openaiCompatible/http.ts";

const PROVIDER_ID = "openai-speech-server" as const;
const UPSTREAM_MODEL = "default";

export class OpenAiSpeechServerVoiceProvider extends Context.Service<
  OpenAiSpeechServerVoiceProvider,
  VoiceProviderAdapter
>()("t3/voice/Providers/OpenAiSpeechServer/OpenAiSpeechServerVoiceProvider") {}

const requireToken = (credentials: VoiceCredentialStore["Service"]) =>
  credentials.get(PROVIDER_ID).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new VoiceError({
              reason: "not-configured",
              operation: "openai-speech-server.credentials",
              detail: "OpenAI-compatible speech server credential is not configured",
              retryable: false,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const requireBaseUrl = (baseUrl: string) => {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return Effect.fail(
      new VoiceError({
        reason: "not-configured",
        operation: "openai-speech-server.config",
        detail: "OpenAI-compatible speech server base URL is not configured",
        retryable: false,
      }),
    );
  }
  try {
    // Validate absolute URL shape without accepting relative paths.
    void new URL(trimmed);
  } catch {
    return Effect.fail(
      new VoiceError({
        reason: "not-configured",
        operation: "openai-speech-server.config",
        detail: "OpenAI-compatible speech server base URL is invalid",
        retryable: false,
      }),
    );
  }
  return Effect.succeed(trimmed);
};

const resolvePreset = (
  preset: VoiceSpeechPreset | string,
  speechPresets: {
    readonly default: { readonly voice: string; readonly speed: number };
    readonly warm: { readonly voice: string; readonly speed: number };
  },
) => {
  if (preset === "default" || preset === "warm") {
    return speechPresets[preset];
  }
  return undefined;
};

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const credentials = yield* VoiceCredentialStore;
  const settingsService = yield* ServerSettingsService;

  const readSpeechServerSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.voice.openaiSpeechServer),
    Effect.mapError(
      (cause) =>
        new VoiceError({
          reason: "provider-unavailable",
          operation: "openai-speech-server.settings",
          detail: "Voice settings are unavailable",
          retryable: true,
          cause,
        }),
    ),
  );

  const transcriber: Transcriber = {
    transcribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const config = yield* readSpeechServerSettings;
          const baseUrl = yield* requireBaseUrl(config.baseUrl);
          const token = yield* requireToken(credentials);
          const data = new FormData();
          data.append("file", new File([input.bytes], "utterance.m4a", { type: input.mediaType }));
          data.append("model", UPSTREAM_MODEL);
          data.append("stream", "true");
          if (input.language !== undefined) data.append("language", input.language);
          if (input.vocabulary !== undefined && input.vocabulary.length > 0) {
            data.append("prompt", input.vocabulary.join(", "));
          }
          const request = HttpClientRequest.post(`${baseUrl}/v1/audio/transcriptions`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeader("accept", "text/event-stream"),
            HttpClientRequest.setBody(HttpBody.formData(data)),
          );
          const response = yield* client.execute(request).pipe(
            Effect.timeout(`${config.connectTimeoutSeconds} seconds`),
            Effect.tapError((cause) =>
              logOpenAiCompatibleHttpFailure("openai-speech-server.transcribe", cause, {
                requestId: input.requestId,
              }),
            ),
            Effect.mapError(mapOpenAiCompatibleHttpFailure("openai-speech-server.transcribe")),
          );
          const upstreamRequestId = sanitizedUpstreamRequestId(response.headers);
          if (upstreamRequestId !== undefined) {
            yield* Effect.logInfo("Voice transcription upstream accepted", {
              requestId: input.requestId,
              upstreamRequestId,
              providerId: PROVIDER_ID,
            });
          }
          yield* requireOkHttpResponse(response, "openai-speech-server.transcribe");
          return mapTranscriptionSseToVoiceEvents(
            response,
            input.requestId,
            input.language,
            "openai-speech-server.transcribe",
          );
        }),
      ),
  };

  const speechSynthesizer: SpeechSynthesizer = {
    prepare: (input) =>
      Effect.gen(function* () {
        const config = yield* readSpeechServerSettings;
        const baseUrl = yield* requireBaseUrl(config.baseUrl);
        const token = yield* requireToken(credentials);
        const preset = resolvePreset(input.preset, config.speechPresets);
        if (preset === undefined) {
          return yield* new VoiceError({
            reason: "unsupported-media",
            operation: "openai-speech-server.synthesize",
            detail: `Unknown server voice preset: ${input.preset}`,
            retryable: false,
          });
        }
        const request = yield* HttpClientRequest.post(`${baseUrl}/v1/audio/speech`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("accept", "audio/pcm"),
          HttpClientRequest.bodyJson({
            model: UPSTREAM_MODEL,
            voice: preset.voice,
            input: input.text,
            response_format: "pcm",
            speed: preset.speed,
            stream_format: "audio",
          }),
          Effect.mapError(
            mapOpenAiCompatibleHttpFailure("openai-speech-server.synthesize.request"),
          ),
        );
        const response = yield* client.execute(request).pipe(
          Effect.timeout(`${config.connectTimeoutSeconds} seconds`),
          Effect.tapError((cause) =>
            logOpenAiCompatibleHttpFailure("openai-speech-server.synthesize", cause, {
              requestId: input.requestId,
            }),
          ),
          Effect.mapError(mapOpenAiCompatibleHttpFailure("openai-speech-server.synthesize")),
        );
        const upstreamRequestId = sanitizedUpstreamRequestId(response.headers);
        if (upstreamRequestId !== undefined) {
          yield* Effect.logInfo("Voice speech upstream accepted", {
            requestId: input.requestId,
            upstreamRequestId,
            providerId: PROVIDER_ID,
          });
        }
        yield* requireCompatiblePcmResponse(response, "openai-speech-server.synthesize");
        return response.stream.pipe(
          Stream.tapError((cause) =>
            logOpenAiCompatibleHttpFailure("openai-speech-server.synthesize", cause, {
              requestId: input.requestId,
            }),
          ),
          Stream.mapError(mapOpenAiCompatibleHttpFailure("openai-speech-server.synthesize")),
        );
      }),
  };

  return {
    id: PROVIDER_ID,
    capabilities: new Set(["transcription.request", "speech.streaming"]),
    transcriber,
    speechSynthesizer,
  } satisfies VoiceProviderAdapter;
});

export type OpenAiSpeechServerReadiness = "ready" | "not-configured" | "unavailable";

export const checkOpenAiSpeechServerHealth: Effect.Effect<
  OpenAiSpeechServerReadiness,
  never,
  HttpClient.HttpClient | ServerSettingsService | VoiceCredentialStore
> = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settingsService = yield* ServerSettingsService;
  const credentials = yield* VoiceCredentialStore;
  const settingsResult = yield* settingsService.getSettings.pipe(Effect.result);
  if (settingsResult._tag === "Failure") {
    return "unavailable" as const;
  }
  const config = settingsResult.success.voice.openaiSpeechServer;
  if (config.baseUrl.trim().length === 0) {
    return "not-configured" as const;
  }
  const tokenResult = yield* credentials.get(PROVIDER_ID).pipe(Effect.result);
  if (tokenResult._tag === "Failure") {
    return "unavailable" as const;
  }
  if (Option.isNone(tokenResult.success)) {
    return "not-configured" as const;
  }
  const baseUrlResult = yield* requireBaseUrl(config.baseUrl).pipe(Effect.result);
  if (baseUrlResult._tag === "Failure") {
    return "not-configured" as const;
  }
  const baseUrl = baseUrlResult.success;
  const responseResult = yield* client
    .execute(HttpClientRequest.get(`${baseUrl}/health/ready`))
    .pipe(Effect.timeout(`${config.connectTimeoutSeconds} seconds`), Effect.result);
  if (responseResult._tag === "Failure") {
    return "unavailable" as const;
  }
  const response = responseResult.success;
  if (response.status < 200 || response.status >= 300) {
    return "unavailable" as const;
  }
  return "ready" as const;
});

export const OpenAiSpeechServerVoiceProviderLive = Layer.effect(
  OpenAiSpeechServerVoiceProvider,
  make,
);

export const __testing = {
  make,
  checkOpenAiSpeechServerHealth,
  PROVIDER_ID,
  UPSTREAM_MODEL,
};

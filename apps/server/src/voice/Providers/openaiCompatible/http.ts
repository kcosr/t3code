import type { VoiceRequestId, VoiceTranscriptionStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { VoiceError } from "../../Errors.ts";

const isVoiceError = Schema.is(VoiceError);

export const OpenAiCompatibleTranscriptionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("transcript.text.delta"),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript.text.done"),
    text: Schema.String,
  }),
]);

export const decodeOpenAiCompatibleTranscriptionEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OpenAiCompatibleTranscriptionEvent),
);

export type OpenAiCompatibleTranscriptionEvent = typeof OpenAiCompatibleTranscriptionEvent.Type;

/** True when the upstream content-type describes s16le 24 kHz mono PCM. */
export const isCompatiblePcmContentType = (contentType: string | undefined): boolean => {
  if (contentType === undefined) return false;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized === "audio/pcm" || normalized === "application/octet-stream") {
    return true;
  }
  // Accept explicit PCM media types that also carry rate/encoding parameters.
  if (!normalized.startsWith("audio/")) return false;
  const lower = contentType.toLowerCase();
  const hasPcm = lower.includes("pcm") || lower.includes("l16") || lower.includes("s16le");
  const hasRate =
    lower.includes("rate=24000") || lower.includes("rate=24k") || lower.includes("24000");
  return hasPcm && (hasRate || normalized === "audio/l16");
};

export const mapOpenAiCompatibleHttpStatus = (status: number, operation: string): VoiceError => {
  switch (status) {
    case 401:
    case 403:
      return new VoiceError({
        reason: "not-configured",
        operation,
        detail: "Voice provider credential was rejected",
        retryable: false,
      });
    case 400:
    case 415:
      return new VoiceError({
        reason: "unsupported-media",
        operation,
        detail: "Voice provider rejected the media or request format",
        retryable: false,
      });
    case 413:
      return new VoiceError({
        reason: "payload-too-large",
        operation,
        detail: "Voice provider rejected the payload size",
        retryable: false,
      });
    case 429:
      return new VoiceError({
        reason: "quota-exceeded",
        operation,
        detail: "Voice provider quota was exceeded",
        retryable: true,
      });
    case 503:
    case 504:
      return new VoiceError({
        reason: "provider-unavailable",
        operation,
        detail: "Voice provider is temporarily unavailable",
        retryable: true,
      });
    default:
      return new VoiceError({
        reason: "provider-unavailable",
        operation,
        detail: "Voice provider request failed",
        retryable: status >= 500 || status === 408,
      });
  }
};

export const mapOpenAiCompatibleHttpFailure = (operation: string) => (cause: unknown) => {
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return mapOpenAiCompatibleHttpStatus(cause.response.status, operation);
  }
  if (isVoiceError(cause)) {
    return cause;
  }
  return new VoiceError({
    reason: "provider-unavailable",
    operation,
    detail: "Voice provider request failed",
    retryable: true,
    cause,
  });
};

export const sanitizedUpstreamRequestId = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const raw = headers["x-request-id"] ?? headers["x-openai-request-id"];
  if (typeof raw !== "string") return undefined;
  return /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : undefined;
};

export const logOpenAiCompatibleHttpFailure = (
  operation: string,
  cause: unknown,
  correlation?: { readonly requestId?: string },
) =>
  Effect.logWarning("Voice provider HTTP request failed", {
    operation,
    ...(correlation?.requestId === undefined ? {} : { requestId: correlation.requestId }),
    failureType: HttpClientError.isHttpClientError(cause) ? cause.reason._tag : "unknown",
    ...(HttpClientError.isHttpClientError(cause) && cause.response !== undefined
      ? {
          status: cause.response.status,
          ...(sanitizedUpstreamRequestId(cause.response.headers) === undefined
            ? {}
            : { upstreamRequestId: sanitizedUpstreamRequestId(cause.response.headers) }),
        }
      : {}),
  });

export const requireOkHttpResponse = (
  response: HttpClientResponse.HttpClientResponse,
  operation: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, VoiceError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(mapOpenAiCompatibleHttpStatus(response.status, operation));

export const requireCompatiblePcmResponse = (
  response: HttpClientResponse.HttpClientResponse,
  operation: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, VoiceError> =>
  Effect.gen(function* () {
    yield* requireOkHttpResponse(response, operation);
    const contentType = response.headers["content-type"];
    if (!isCompatiblePcmContentType(contentType)) {
      return yield* new VoiceError({
        reason: "unsupported-media",
        operation,
        detail: "Voice provider returned an incompatible audio content type",
        retryable: false,
      });
    }
    return response;
  });

export const mapTranscriptionSseToVoiceEvents = (
  response: HttpClientResponse.HttpClientResponse,
  requestId: VoiceRequestId,
  language: string | undefined,
  operation: string,
): Stream.Stream<VoiceTranscriptionStreamEvent, VoiceError> =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.filter(({ data }) => data !== "[DONE]"),
    Stream.mapEffect(({ data }) => decodeOpenAiCompatibleTranscriptionEvent(data)),
    Stream.map(
      (data): VoiceTranscriptionStreamEvent =>
        data.type === "transcript.text.delta"
          ? {
              type: "delta",
              requestId,
              text: data.delta,
            }
          : {
              type: "final",
              result: {
                requestId,
                text: data.text,
                ...(language === undefined ? {} : { language }),
              },
            },
    ),
    Stream.filter(
      (event) => event.type === "final" || (event.type === "delta" && event.text.length > 0),
    ),
    Stream.mapError(mapOpenAiCompatibleHttpFailure(operation)),
  );

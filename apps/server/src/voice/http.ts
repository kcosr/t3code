import {
  AuthVoiceUseScope,
  VoiceSpeechRequest,
  VoiceTranscriptionMetadata,
  VoiceTranscriptionStreamEvent,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Multipart from "effect/unstable/http/Multipart";

import { authenticateRawRouteWithScope } from "../auth/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VoiceMediaTicketRegistry } from "./Services/VoiceMediaTicketRegistry.ts";
import { inspectVoiceMp4 } from "./Services/VoiceMp4Inspector.ts";
import {
  boundVoiceByteStream,
  boundVoiceMediaEffect,
  validateVoiceMultipartShape,
  VOICE_MULTIPART_MAX_PARTS,
  VOICE_MULTIPART_METADATA_MAX_BYTES,
  VOICE_MULTIPART_OVERHEAD_BYTES,
  VOICE_SPEECH_FIRST_BYTE_TIMEOUT_SECONDS,
  VOICE_SPEECH_REQUEST_MAX_BYTES,
  VOICE_TRANSCRIPTION_OUTPUT_MAX_BYTES,
  makeVoiceMediaRequestLimiter,
  VoiceMediaPolicyError,
} from "./Services/VoiceMediaPolicy.ts";
import { VoiceProviderRegistry } from "./Services/VoiceProviderRegistry.ts";

const VOICE_TICKET_HEADER = "x-t3-voice-ticket";
const decodeTranscriptionMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceTranscriptionMetadata),
);
const decodeSpeechRequest = Schema.decodeUnknownEffect(VoiceSpeechRequest);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeTranscriptionEvent = Schema.encodeSync(
  Schema.fromJsonString(VoiceTranscriptionStreamEvent),
);
const mediaRequestLimiter = Effect.runSync(makeVoiceMediaRequestLimiter);

class VoiceMediaRequestError extends Data.TaggedError("VoiceMediaRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const decodeBoundedJson = (
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
): Effect.Effect<unknown, VoiceMediaPolicyError | VoiceMediaRequestError> =>
  request.stream.pipe(
    Stream.mapError(
      (cause) => new VoiceMediaRequestError({ message: "Invalid voice speech request", cause }),
    ),
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (observed, chunk) => {
        if (observed.byteLength + chunk.byteLength > maximumBytes) {
          return Effect.fail(new VoiceMediaPolicyError({ reason: "payload-too-large" }));
        }
        const combined = new Uint8Array(observed.byteLength + chunk.byteLength);
        combined.set(observed);
        combined.set(chunk, observed.byteLength);
        return Effect.succeed(combined);
      },
    ),
    Effect.flatMap((bytes) =>
      decodeUnknownJson(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError(
          (cause) => new VoiceMediaRequestError({ message: "Invalid voice speech request", cause }),
        ),
      ),
    ),
  );

const invalidRequest = (message: string, cause?: unknown) =>
  Effect.fail(new VoiceMediaRequestError({ message, ...(cause === undefined ? {} : { cause }) }));

const voiceMediaRequestErrorResponse = (error: VoiceMediaRequestError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { code: "invalid_request", message: error.message },
      { status: 400 },
    ),
  );

const voiceMediaPolicyErrorResponse = (error: VoiceMediaPolicyError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { code: error.reason },
      { status: error.reason === "quota-exceeded" ? 429 : 400 },
    ),
  );

const authenticateVoiceMedia = (operation: "transcription-upload" | "speech-stream") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const ticket = request.headers[VOICE_TICKET_HEADER];
    if (ticket === undefined) {
      yield* authenticateRawRouteWithScope(AuthVoiceUseScope);
      return null;
    }
    const tickets = yield* VoiceMediaTicketRegistry;
    return yield* tickets.consume(ticket, operation);
  });

const ticketAuthorizesRequest = (
  scope: Effect.Success<ReturnType<typeof authenticateVoiceMedia>>,
  requestId: VoiceSpeechRequest["requestId"] | VoiceTranscriptionMetadata["requestId"],
) => scope === null || (scope !== undefined && scope.requestId === requestId);

const decodeTranscriptionMultipart = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const settings = (yield* settingsService.getSettings).voice;
  if (!settings.enabled) {
    return yield* invalidRequest("Voice is disabled on this server");
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parts = yield* request.multipartStream.pipe(
    Stream.runCollect,
    Effect.provide(
      Multipart.limitsServices({
        maxParts: VOICE_MULTIPART_MAX_PARTS,
        maxFieldSize: VOICE_MULTIPART_METADATA_MAX_BYTES,
        maxFileSize: settings.maxUploadBytes,
        maxTotalSize:
          settings.maxUploadBytes +
          VOICE_MULTIPART_METADATA_MAX_BYTES +
          VOICE_MULTIPART_OVERHEAD_BYTES,
      }),
    ),
    Effect.mapError(
      (cause) => new VoiceMediaRequestError({ message: "Invalid multipart voice request", cause }),
    ),
  );
  yield* validateVoiceMultipartShape(
    Array.from(parts, (part) => ({
      kind: Multipart.isFile(part) ? ("file" as const) : ("field" as const),
      key: part.key,
    })),
  );
  const audio = Array.from(parts).find(
    (part): part is Multipart.File => Multipart.isFile(part) && part.key === "audio",
  );
  const metadataPart = Array.from(parts).find(
    (part): part is Multipart.Field => Multipart.isField(part) && part.key === "metadata",
  );
  if (audio === undefined || metadataPart === undefined) {
    return yield* invalidRequest("Voice transcription requires audio and metadata parts");
  }
  const metadata = yield* decodeTranscriptionMetadata(metadataPart.value).pipe(
    Effect.mapError(
      (cause) =>
        new VoiceMediaRequestError({ message: "Invalid voice transcription metadata", cause }),
    ),
  );
  const bytes = yield* audio.contentEffect.pipe(
    Effect.mapError(
      (cause) => new VoiceMediaRequestError({ message: "Invalid voice audio upload", cause }),
    ),
  );
  if (bytes.byteLength > settings.maxUploadBytes) {
    return yield* invalidRequest("Voice transcription payload exceeds the configured limit");
  }
  if (audio.contentType !== "audio/mp4") {
    return yield* invalidRequest("Voice transcription audio type is unsupported");
  }
  const validatedMedia = yield* inspectVoiceMp4(bytes, settings.maxInputDurationSeconds);
  return { metadata, bytes, validatedMedia };
});

const transcriptionRoute = HttpRouter.add(
  "POST",
  "/api/voice/transcriptions",
  Effect.gen(function* () {
    const authorization = yield* authenticateVoiceMedia("transcription-upload");
    if (authorization === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { code: "auth_invalid", reason: "invalid_credential" },
        { status: 401 },
      );
    }
    const settingsService = yield* ServerSettingsService;
    const settings = (yield* settingsService.getSettings).voice;
    const permit = yield* mediaRequestLimiter.acquire(settings.maxConcurrentMediaRequests);
    return yield* Effect.gen(function* () {
      const { metadata, bytes, validatedMedia } = yield* boundVoiceMediaEffect(
        decodeTranscriptionMultipart,
        settings.mediaRequestTimeoutSeconds,
      );
      if (!ticketAuthorizesRequest(authorization, metadata.requestId)) {
        return HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", reason: "invalid_credential" },
          { status: 401 },
        );
      }
      const providers = yield* VoiceProviderRegistry;
      const provider = yield* providers.resolve("transcription.request");
      const transcriber = provider.transcriber;
      if (transcriber === undefined) {
        return yield* invalidRequest("Selected voice provider has no transcriber");
      }
      const body = boundVoiceByteStream(
        transcriber
          .transcribe({
            requestId: metadata.requestId,
            bytes,
            mediaType: validatedMedia.mediaType,
            ...(metadata.language === undefined ? {} : { language: metadata.language }),
            ...(metadata.vocabulary === undefined ? {} : { vocabulary: metadata.vocabulary }),
          })
          .pipe(
            Stream.map((event) => `${encodeTranscriptionEvent(event)}\n`),
            Stream.encodeText,
          ),
        {
          maximumBytes: VOICE_TRANSCRIPTION_OUTPUT_MAX_BYTES,
          firstByteTimeoutSeconds: settings.mediaRequestTimeoutSeconds,
          totalTimeoutSeconds: settings.mediaRequestTimeoutSeconds,
        },
      ).pipe(Stream.ensuring(permit.release));
      return HttpServerResponse.stream(body, {
        contentType: "application/x-ndjson; charset=utf-8",
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }).pipe(Effect.onError(() => permit.release));
  }).pipe(
    Effect.catchTag("VoiceMediaRequestError", voiceMediaRequestErrorResponse),
    Effect.catchTag("VoiceMediaPolicyError", voiceMediaPolicyErrorResponse),
  ),
);

const speechRoute = HttpRouter.add(
  "POST",
  "/api/voice/speech",
  Effect.gen(function* () {
    const authorization = yield* authenticateVoiceMedia("speech-stream");
    if (authorization === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { code: "auth_invalid", reason: "invalid_credential" },
        { status: 401 },
      );
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const settingsService = yield* ServerSettingsService;
    const settings = (yield* settingsService.getSettings).voice;
    if (!settings.enabled) {
      return yield* invalidRequest("Voice is disabled on this server");
    }
    const input = yield* decodeBoundedJson(request, VOICE_SPEECH_REQUEST_MAX_BYTES).pipe(
      Effect.flatMap((value) =>
        decodeSpeechRequest(value).pipe(
          Effect.mapError(
            (cause) =>
              new VoiceMediaRequestError({ message: "Invalid voice speech request", cause }),
          ),
        ),
      ),
    );
    if (new TextEncoder().encode(input.text).byteLength > settings.maxSpeechTextBytes) {
      return yield* invalidRequest("Voice speech text exceeds the configured limit");
    }
    if (!ticketAuthorizesRequest(authorization, input.requestId)) {
      return HttpServerResponse.jsonUnsafe(
        { code: "auth_invalid", reason: "invalid_credential" },
        { status: 401 },
      );
    }
    const providers = yield* VoiceProviderRegistry;
    const provider = yield* providers.resolve("speech.streaming");
    const synthesizer = provider.speechSynthesizer;
    if (synthesizer === undefined) {
      return yield* invalidRequest("Selected voice provider has no speech synthesizer");
    }
    const permit = yield* mediaRequestLimiter.acquire(settings.maxConcurrentMediaRequests);
    return yield* Effect.sync(() => {
      const providerStream = synthesizer.synthesize({
        requestId: input.requestId,
        playbackId: input.playbackId,
        segmentIndex: input.segmentIndex,
        finalSegment: input.finalSegment,
        text: input.text,
        preset: input.preset,
      });
      const body = boundVoiceByteStream(providerStream, {
        maximumBytes: settings.maxSpeechOutputBytes,
        firstByteTimeoutSeconds: Math.min(
          VOICE_SPEECH_FIRST_BYTE_TIMEOUT_SECONDS,
          settings.mediaRequestTimeoutSeconds,
        ),
        totalTimeoutSeconds: settings.mediaRequestTimeoutSeconds,
      }).pipe(Stream.ensuring(permit.release));
      return HttpServerResponse.stream(body, {
        contentType: "audio/pcm",
        headers: {
          "cache-control": "no-store",
          "x-t3-audio-format": "s16le;rate=24000;channels=1",
        },
      });
    }).pipe(Effect.onError(() => permit.release));
  }).pipe(
    Effect.catchTag("VoiceMediaRequestError", voiceMediaRequestErrorResponse),
    Effect.catchTag("VoiceMediaPolicyError", voiceMediaPolicyErrorResponse),
  ),
);

export const voiceMediaRoutesLayer = Layer.mergeAll(transcriptionRoute, speechRoute);

import {
  VoiceNativeThreadTurnCancelInput,
  VoiceNativeThreadTurnCreateInput,
  VoiceNativeThreadTurnEventsAckInput,
  VoiceNativeThreadTurnEventsQuery,
  VoiceNativeThreadTurnOperationId,
  VoiceTranscriptionLanguage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";
import type { VoiceError } from "./Errors.ts";
import { VoiceNativeThreadTurnService } from "./Services/VoiceNativeThreadTurnService.ts";

const VOICE_RUNTIME_HEADER = "x-t3-voice-runtime";
const VOICE_OPERATION_HEADER = "x-t3-voice-operation";
const JSON_LIMIT = 2_048;
const BODY_TIMEOUT = "10 seconds";
const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

const decodeOperationId = Schema.decodeUnknownEffect(VoiceNativeThreadTurnOperationId);
const decodeCreateSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceNativeThreadTurnCreateInput),
);
const decodeCreate = (json: string) => decodeCreateSchema(json, { onExcessProperty: "error" });
const decodeAckSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceNativeThreadTurnEventsAckInput),
);
const decodeAck = (json: string) => decodeAckSchema(json, { onExcessProperty: "error" });
const decodeCancelSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceNativeThreadTurnCancelInput),
);
const decodeCancel = (json: string) => decodeCancelSchema(json, { onExcessProperty: "error" });
const decodeLanguage = Schema.decodeUnknownEffect(VoiceTranscriptionLanguage);

const response = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });
const unauthorized = () => response({ code: "auth_invalid", reason: "invalid_credential" }, 401);
const invalidRequest = (message = "Invalid native thread voice request") =>
  response({ code: "invalid_request", message }, 400);
const payloadTooLarge = () => response({ code: "payload_too_large" }, 413);

const voiceFailure = (error: VoiceError) => {
  const status =
    error.reason === "authorization-revoked"
      ? 401
      : error.reason === "session-not-found" || error.reason === "conversation-not-found"
        ? 404
        : error.reason === "payload-too-large"
          ? 413
          : error.reason === "quota-exceeded"
            ? 429
            : error.reason === "provider-unavailable" ||
                error.reason === "disabled" ||
                error.reason === "not-configured"
              ? 503
              : error.reason === "unsupported-media"
                ? 415
                : 409;
  return response(
    {
      code: "voice_operation_failed",
      reason: error.reason,
      message: error.detail,
      retryable: error.retryable,
    },
    status,
  );
};

const readBounded = (request: HttpServerRequest.HttpServerRequest, maximumBytes: number) => {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximumBytes)
    return Effect.fail("too-large" as const);
  return request.stream.pipe(
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (observed, chunk) => {
        if (observed.byteLength + chunk.byteLength > maximumBytes)
          return Effect.fail("too-large" as const);
        const combined = new Uint8Array(observed.byteLength + chunk.byteLength);
        combined.set(observed);
        combined.set(chunk, observed.byteLength);
        return Effect.succeed(combined);
      },
    ),
    Effect.timeout(BODY_TIMEOUT),
    Effect.mapError((error) => (error === "too-large" ? error : ("invalid" as const))),
  );
};

const decodeJson = <A>(
  request: HttpServerRequest.HttpServerRequest,
  decoder: (json: string) => Effect.Effect<A, Schema.SchemaError>,
) =>
  readBounded(request, JSON_LIMIT).pipe(
    Effect.flatMap((bytes) => decoder(new TextDecoder().decode(bytes))),
    Effect.option,
  );

const withOperation = Effect.fn("voice.native-thread.http.operation")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const context = yield* HttpRouter.RouteContext;
  const token = request.headers[VOICE_OPERATION_HEADER];
  const operationId = yield* decodeOperationId(context.params.operationId).pipe(Effect.option);
  return token === undefined || Option.isNone(operationId)
    ? undefined
    : { request, token, operationId: operationId.value };
});

const createRoute = HttpRouter.add(
  "POST",
  "/api/voice/native/thread-turns",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers[VOICE_RUNTIME_HEADER];
    if (token === undefined) return unauthorized();
    const input = yield* decodeJson(request, decodeCreate);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .create(token, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const audioRoute = HttpRouter.add(
  "PUT",
  "/api/voice/native/thread-turns/:operationId/audio",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const contentType = context.request.headers["content-type"]?.split(";", 1)[0]?.trim();
    if (contentType !== "audio/mp4") return invalidRequest("Content-Type must be audio/mp4");
    const languageHeader = context.request.headers["content-language"];
    const language =
      languageHeader === undefined
        ? Option.none<string>()
        : yield* decodeLanguage(languageHeader).pipe(Effect.option);
    if (languageHeader !== undefined && Option.isNone(language))
      return invalidRequest("Invalid content language");
    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(Effect.result);
    if (Result.isFailure(settings))
      return response({ code: "voice_operation_failed", retryable: true }, 503);
    const maximumBytes = settings.success.voice.maxUploadBytes;
    const audio = yield* readBounded(context.request, maximumBytes).pipe(Effect.result);
    if (Result.isFailure(audio))
      return audio.failure === "too-large" ? payloadTooLarge() : invalidRequest();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .uploadAudio(
        context.token,
        context.operationId,
        audio.success,
        Option.getOrUndefined(language),
      )
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const eventsRoute = HttpRouter.add(
  "GET",
  "/api/voice/native/thread-turns/:operationId/events",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const url = new URL(context.request.url, "http://native.invalid");
    const query = yield* Schema.decodeUnknownEffect(VoiceNativeThreadTurnEventsQuery)(
      {
        afterSequence: Number(url.searchParams.get("afterSequence") ?? "0"),
        waitMilliseconds: Number(url.searchParams.get("waitMilliseconds") ?? "0"),
      },
      { onExcessProperty: "error" },
    ).pipe(Effect.option);
    if (Option.isNone(query)) return invalidRequest();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .events(context.token, context.operationId, query.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const acknowledgeRoute = HttpRouter.add(
  "POST",
  "/api/voice/native/thread-turns/:operationId/events/ack",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const input = yield* decodeJson(context.request, decodeAck);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .acknowledgeEvents(context.token, context.operationId, input.value.acknowledgedSequence)
      .pipe(Effect.result);
    return Result.isFailure(result)
      ? voiceFailure(result.failure)
      : response({ snapshot: result.success });
  }),
);

const speechRoute = HttpRouter.add(
  "GET",
  "/api/voice/native/thread-turns/:operationId/speech/:segmentIndex",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const route = yield* HttpRouter.RouteContext;
    const segmentIndex = Number(route.params.segmentIndex);
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) return invalidRequest();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .speech(context.token, context.operationId, segmentIndex)
      .pipe(Effect.result);
    if (Result.isFailure(result)) return voiceFailure(result.failure);
    return HttpServerResponse.stream(result.success, {
      contentType: "audio/pcm",
      headers: { ...noStore, "x-t3-audio-format": "s16le;rate=24000;channels=1" },
    });
  }),
);

const cancelRoute = HttpRouter.add(
  "POST",
  "/api/voice/native/thread-turns/:operationId/cancel",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const input = yield* decodeJson(context.request, decodeCancel);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .cancel(context.token, context.operationId)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

export const voiceNativeThreadTurnRoutesLayer = Layer.mergeAll(
  createRoute,
  audioRoute,
  eventsRoute,
  acknowledgeRoute,
  speechRoute,
  cancelRoute,
);

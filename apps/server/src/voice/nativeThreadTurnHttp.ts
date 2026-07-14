import {
  VoiceRuntimeThreadTurnCancelInput,
  VoiceRuntimeThreadTurnEventsAckInput,
  VoiceRuntimeThreadTurnEventsQuery,
  VoiceRuntimeThreadTurnDispositionInput,
  VoiceRuntimeThreadTurnCreateInput,
  VoiceThreadTurnOperationId,
  VoiceTranscriptionLanguage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { VoiceError } from "./Errors.ts";
import { VoiceNativeThreadTurnService } from "./Services/VoiceNativeThreadTurnService.ts";

const VOICE_RUNTIME_HEADER = "x-t3-voice-runtime";
const VOICE_OPERATION_HEADER = "x-t3-voice-operation";
const JSON_LIMIT = 2_048;
const noStore = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const decodeOperationId = Schema.decodeUnknownEffect(VoiceThreadTurnOperationId);
const decodeCreateSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceRuntimeThreadTurnCreateInput),
);
const decodeCreate = (json: string) => decodeCreateSchema(json, { onExcessProperty: "error" });
const decodeAckSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceRuntimeThreadTurnEventsAckInput),
);
const decodeAck = (json: string) => decodeAckSchema(json, { onExcessProperty: "error" });
const decodeDispositionSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceRuntimeThreadTurnDispositionInput),
);
const decodeDisposition = (json: string) =>
  decodeDispositionSchema(json, { onExcessProperty: "error" });
const decodeCancelSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceRuntimeThreadTurnCancelInput),
);
const decodeCancel = (json: string) => decodeCancelSchema(json, { onExcessProperty: "error" });
const decodeLanguage = Schema.decodeUnknownEffect(VoiceTranscriptionLanguage);
const decodeEventsQuery = Schema.decodeUnknownEffect(VoiceRuntimeThreadTurnEventsQuery);

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

export const readBounded = (
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
  timeoutSeconds = 10,
) => {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximumBytes)
    return Effect.fail("too-large" as const);
  return request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, byteLength: 0 }),
      (observed, chunk) => {
        if (observed.byteLength + chunk.byteLength > maximumBytes)
          return Effect.fail("too-large" as const);
        observed.chunks.push(chunk);
        return Effect.succeed({
          chunks: observed.chunks,
          byteLength: observed.byteLength + chunk.byteLength,
        });
      },
    ),
    Effect.map(({ chunks, byteLength }) => {
      const combined = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return combined;
    }),
    Effect.timeout(`${timeoutSeconds} seconds`),
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
  "/api/voice/runtime/thread-turns",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers[VOICE_RUNTIME_HEADER];
    if (token === undefined) return unauthorized();
    const service = yield* VoiceNativeThreadTurnService;
    const authorized = yield* service.authorizeCreate(token).pipe(Effect.result);
    if (Result.isFailure(authorized)) return voiceFailure(authorized.failure);
    const input = yield* decodeJson(request, decodeCreate);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* service.create(token, input.value).pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const audioRoute = HttpRouter.add(
  "PUT",
  "/api/voice/runtime/thread-turns/:operationId/audio",
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
    const service = yield* VoiceNativeThreadTurnService;
    const admission = yield* service
      .beginAudioUpload(context.token, context.operationId)
      .pipe(Effect.result);
    if (Result.isFailure(admission)) return voiceFailure(admission.failure);
    const upload = yield* Effect.gen(function* () {
      const audio = yield* readBounded(
        context.request,
        admission.success.maximumBytes,
        admission.success.bodyTimeoutSeconds,
      );
      return yield* admission.success.upload(audio, Option.getOrUndefined(language));
    }).pipe(Effect.ensuring(admission.success.release), Effect.result);
    if (Result.isFailure(upload)) {
      if (upload.failure === "too-large") return payloadTooLarge();
      if (upload.failure === "invalid") return invalidRequest();
      return voiceFailure(upload.failure);
    }
    return response(upload.success);
  }),
);

const dispositionRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/thread-turns/:operationId/disposition",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const input = yield* decodeJson(context.request, decodeDisposition);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .setDraftDisposition(context.token, context.operationId)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const eventsRoute = HttpRouter.add(
  "GET",
  "/api/voice/runtime/thread-turns/:operationId/events",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const url = new URL(context.request.url, "http://native.invalid");
    const query = yield* decodeEventsQuery(
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
  "/api/voice/runtime/thread-turns/:operationId/events/ack",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const service = yield* VoiceNativeThreadTurnService;
    const authorized = yield* service
      .authorizeOperation(context.token, context.operationId)
      .pipe(Effect.result);
    if (Result.isFailure(authorized)) return voiceFailure(authorized.failure);
    const input = yield* decodeJson(context.request, decodeAck);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* service
      .acknowledgeEvents(context.token, context.operationId, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result)
      ? voiceFailure(result.failure)
      : response({ snapshot: result.success });
  }),
);

const speechRoute = HttpRouter.add(
  "GET",
  "/api/voice/runtime/thread-turns/:operationId/speech/:segmentIndex",
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
      headers: {
        ...noStore,
        "x-t3-audio-format": "s16le;rate=24000;channels=1",
      },
    });
  }),
);

const cancelRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/thread-turns/:operationId/cancel",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const service = yield* VoiceNativeThreadTurnService;
    const authorized = yield* service
      .authorizeOperation(context.token, context.operationId)
      .pipe(Effect.result);
    if (Result.isFailure(authorized)) return voiceFailure(authorized.failure);
    const input = yield* decodeJson(context.request, decodeCancel);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* service.cancel(context.token, context.operationId).pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const draftRoute = HttpRouter.add(
  "GET",
  "/api/voice/runtime/thread-turns/:operationId/draft",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .readDraft(context.token, context.operationId)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const consumeDraftRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/thread-turns/:operationId/draft/consume",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .consumeDraft(context.token, context.operationId)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const detachRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/thread-turns/:operationId/detach",
  Effect.gen(function* () {
    const context = yield* withOperation();
    if (context === undefined) return unauthorized();
    const result = yield* (yield* VoiceNativeThreadTurnService)
      .detach(context.token, context.operationId)
      .pipe(Effect.result);
    return Result.isFailure(result)
      ? voiceFailure(result.failure)
      : response({ snapshot: result.success });
  }),
);

export const voiceNativeThreadTurnRoutesLayer = Layer.mergeAll(
  createRoute,
  audioRoute,
  dispositionRoute,
  eventsRoute,
  acknowledgeRoute,
  speechRoute,
  draftRoute,
  consumeDraftRoute,
  detachRoute,
  cancelRoute,
);

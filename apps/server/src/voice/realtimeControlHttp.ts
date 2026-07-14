import {
  VoiceClientActionId,
  VoiceRuntimeRealtimeActionAckInput,
  VoiceRuntimeRealtimeActionsQuery,
  VoiceRuntimeRealtimeCloseInput,
  VoiceRuntimeRealtimeFocusInput,
  VoiceRuntimeRealtimeHandoffExchangeInput,
  VoiceRuntimeRealtimeHandoffCommitInput,
  VoiceRuntimeRealtimeHeartbeatInput,
  VoiceRuntimeRealtimeSessionCreateInput,
  VoiceRuntimeRealtimeWebRtcOfferInput,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { VoiceError } from "./Errors.ts";
import { VoiceRealtimeControlService } from "./Services/VoiceRealtimeControlService.ts";
import { voiceRuntimeProtocolResponse } from "./runtimeProtocolHttp.ts";

const RUNTIME_HEADER = "x-t3-voice-runtime";
const CONTROL_HEADER = "x-t3-voice-control";
const TRANSITION_HEADER = "x-t3-voice-transition";
const JSON_LIMIT = 128 * 1_024;
const noStore = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const response = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });
const unauthorized = () => response({ code: "auth_invalid", reason: "invalid_credential" }, 401);
const invalidRequest = () =>
  response({ code: "invalid_request", message: "Invalid Realtime voice request" }, 400);

const voiceFailure = (error: VoiceError) => {
  const status =
    error.reason === "authorization-revoked"
      ? 401
      : error.reason === "session-not-found" || error.reason === "conversation-not-found"
        ? 404
        : error.reason === "quota-exceeded"
          ? 429
          : error.reason === "provider-unavailable" ||
              error.reason === "disabled" ||
              error.reason === "not-configured"
            ? 503
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

const readBounded = (request: HttpServerRequest.HttpServerRequest) => {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > JSON_LIMIT) return Effect.fail(undefined);
  return request.stream.pipe(
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (observed, chunk) => {
        if (observed.byteLength + chunk.byteLength > JSON_LIMIT) return Effect.fail(undefined);
        const combined = new Uint8Array(observed.byteLength + chunk.byteLength);
        combined.set(observed);
        combined.set(chunk, observed.byteLength);
        return Effect.succeed(combined);
      },
    ),
    Effect.timeout("10 seconds"),
  );
};

const decoder = <A, I>(schema: Schema.Codec<A, I, never>) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (request: HttpServerRequest.HttpServerRequest) =>
    readBounded(request).pipe(
      Effect.flatMap((bytes) =>
        decode(new TextDecoder().decode(bytes), { onExcessProperty: "error" }),
      ),
      Effect.option,
    );
};

const decodeCreate = decoder(VoiceRuntimeRealtimeSessionCreateInput);
const decodeOffer = decoder(VoiceRuntimeRealtimeWebRtcOfferInput);
const decodeHeartbeat = decoder(VoiceRuntimeRealtimeHeartbeatInput);
const decodeAck = decoder(VoiceRuntimeRealtimeActionAckInput);
const decodeFocus = decoder(VoiceRuntimeRealtimeFocusInput);
const decodeHandoff = decoder(VoiceRuntimeRealtimeHandoffExchangeInput);
const decodeHandoffCommit = decoder(VoiceRuntimeRealtimeHandoffCommitInput);
const decodeClose = decoder(VoiceRuntimeRealtimeCloseInput);
const decodeSessionId = Schema.decodeUnknownEffect(VoiceSessionId);
const decodeActionId = Schema.decodeUnknownEffect(VoiceClientActionId);
const decodeActionsQuery = Schema.decodeUnknownEffect(VoiceRuntimeRealtimeActionsQuery);

const routeContext = Effect.fn("voice.runtime-realtime.http.context")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const incompatible = voiceRuntimeProtocolResponse(request);
  if (incompatible !== undefined) return { incompatible };
  const route = yield* HttpRouter.RouteContext;
  const token = request.headers[CONTROL_HEADER];
  const sessionId = yield* decodeSessionId(route.params.sessionId).pipe(Effect.option);
  return token === undefined || Option.isNone(sessionId)
    ? undefined
    : { request, route, token, sessionId: sessionId.value };
});

const createRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const incompatible = voiceRuntimeProtocolResponse(request);
    if (incompatible !== undefined) return incompatible;
    const token = request.headers[RUNTIME_HEADER];
    if (token === undefined) return unauthorized();
    const input = yield* decodeCreate(request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .create(token, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const offerRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions/:sessionId/webrtc-offer",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return unauthorized();
    const input = yield* decodeOffer(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .offer(context.token, context.sessionId, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const heartbeatRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions/:sessionId/heartbeat",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return unauthorized();
    const input = yield* decodeHeartbeat(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .heartbeat(context.token, context.sessionId, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const actionsRoute = HttpRouter.add(
  "GET",
  "/api/voice/runtime/realtime-sessions/:sessionId/actions",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return unauthorized();
    const url = new URL(context.request.url, "http://runtime.invalid");
    const query = yield* decodeActionsQuery(
      {
        runtimeId: url.searchParams.get("runtimeId"),
        runtimeInstanceId: url.searchParams.get("runtimeInstanceId"),
        generation: Number(url.searchParams.get("generation")),
        modeSessionId: url.searchParams.get("modeSessionId"),
        leaseGeneration: Number(url.searchParams.get("leaseGeneration")),
        afterSequence: Number(url.searchParams.get("afterSequence") ?? "0"),
        waitMilliseconds: Number(url.searchParams.get("waitMilliseconds") ?? "0"),
      },
      { onExcessProperty: "error" },
    ).pipe(Effect.option);
    if (Option.isNone(query)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .actions(context.token, context.sessionId, query.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const acknowledgeActionRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions/:sessionId/actions/:actionId/ack",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return unauthorized();
    const actionId = yield* decodeActionId(context.route.params.actionId).pipe(Effect.option);
    const input = yield* decodeAck(context.request);
    if (Option.isNone(actionId) || Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .acknowledgeAction(context.token, context.sessionId, actionId.value, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const focusRoute = HttpRouter.add(
  "PUT",
  "/api/voice/runtime/realtime-sessions/:sessionId/focus",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return unauthorized();
    const input = yield* decodeFocus(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .updateFocus(context.token, context.sessionId, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const handoffRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions/:sessionId/handoffs/:actionId/exchange",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return unauthorized();
    const actionId = yield* decodeActionId(context.route.params.actionId).pipe(Effect.option);
    const input = yield* decodeHandoff(context.request);
    if (Option.isNone(actionId) || Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .exchangeHandoff(context.token, context.sessionId, actionId.value, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const handoffCommitRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions/:sessionId/handoffs/:actionId/commit",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const incompatible = voiceRuntimeProtocolResponse(request);
    if (incompatible !== undefined) return incompatible;
    const route = yield* HttpRouter.RouteContext;
    const token = request.headers[TRANSITION_HEADER];
    const sessionId = yield* decodeSessionId(route.params.sessionId).pipe(Effect.option);
    const actionId = yield* decodeActionId(route.params.actionId).pipe(Effect.option);
    const input = yield* decodeHandoffCommit(request);
    if (
      token === undefined ||
      Option.isNone(sessionId) ||
      Option.isNone(actionId) ||
      Option.isNone(input)
    )
      return token === undefined ? unauthorized() : invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .commitHandoff(token, sessionId.value, actionId.value, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const closeRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions/:sessionId/close",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return unauthorized();
    const input = yield* decodeClose(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .close(context.token, context.sessionId, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

export const voiceRealtimeControlRoutesLayer = Layer.mergeAll(
  createRoute,
  offerRoute,
  heartbeatRoute,
  actionsRoute,
  acknowledgeActionRoute,
  focusRoute,
  handoffRoute,
  handoffCommitRoute,
  closeRoute,
);

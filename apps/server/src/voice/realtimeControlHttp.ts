import {
  AuthVoiceUseScope,
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
import { authenticateRawRouteWithScope } from "../auth/http.ts";
import { VoiceRealtimeControlService } from "./Services/VoiceRealtimeControlService.ts";
import { voiceRuntimeProtocolResponse } from "./runtimeProtocolHttp.ts";

const JSON_LIMIT = 128 * 1_024;
const noStore = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const response = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });
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
  const principal = yield* authenticateRawRouteWithScope(AuthVoiceUseScope);
  const route = yield* HttpRouter.RouteContext;
  const sessionId = yield* decodeSessionId(route.params.sessionId).pipe(Effect.option);
  return Option.isNone(sessionId)
    ? undefined
    : { request, route, principal, sessionId: sessionId.value };
});

const createRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const incompatible = voiceRuntimeProtocolResponse(request);
    if (incompatible !== undefined) return incompatible;
    const principal = yield* authenticateRawRouteWithScope(AuthVoiceUseScope);
    const input = yield* decodeCreate(request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .create({ sessionId: principal.sessionId, scopes: new Set(principal.scopes) }, input.value)
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
    if (context === undefined) return invalidRequest();
    const input = yield* decodeOffer(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .offer(context.principal.sessionId, context.sessionId, input.value)
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
    if (context === undefined) return invalidRequest();
    const input = yield* decodeHeartbeat(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .heartbeat(context.principal.sessionId, context.sessionId, input.value)
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
    if (context === undefined) return invalidRequest();
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
      .actions(context.principal.sessionId, context.sessionId, query.value)
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
    if (context === undefined) return invalidRequest();
    const actionId = yield* decodeActionId(context.route.params.actionId).pipe(Effect.option);
    const input = yield* decodeAck(context.request);
    if (Option.isNone(actionId) || Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .acknowledgeAction(
        context.principal.sessionId,
        context.sessionId,
        actionId.value,
        input.value,
      )
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
    if (context === undefined) return invalidRequest();
    const input = yield* decodeFocus(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .updateFocus(context.principal.sessionId, context.sessionId, input.value)
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
    if (context === undefined) return invalidRequest();
    const actionId = yield* decodeActionId(context.route.params.actionId).pipe(Effect.option);
    const input = yield* decodeHandoff(context.request);
    if (Option.isNone(actionId) || Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .exchangeHandoff(context.principal.sessionId, context.sessionId, actionId.value, input.value)
      .pipe(Effect.result);
    return Result.isFailure(result) ? voiceFailure(result.failure) : response(result.success);
  }),
);

const handoffCommitRoute = HttpRouter.add(
  "POST",
  "/api/voice/runtime/realtime-sessions/:sessionId/handoffs/:actionId/commit",
  Effect.gen(function* () {
    const context = yield* routeContext();
    if (context !== undefined && "incompatible" in context) return context.incompatible;
    if (context === undefined) return invalidRequest();
    const actionId = yield* decodeActionId(context.route.params.actionId).pipe(Effect.option);
    const input = yield* decodeHandoffCommit(context.request);
    if (Option.isNone(actionId) || Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .commitHandoff(context.principal.sessionId, context.sessionId, actionId.value, input.value)
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
    if (context === undefined) return invalidRequest();
    const input = yield* decodeClose(context.request);
    if (Option.isNone(input)) return invalidRequest();
    const result = yield* (yield* VoiceRealtimeControlService)
      .close(context.principal.sessionId, context.sessionId, input.value)
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

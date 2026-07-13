import {
  VoiceClientActionId,
  VoiceNativeHandoffActionAckInput,
  VoiceNativeHeartbeatInput,
  VoiceNativeRealtimeStartInput,
  VoiceSessionLeaseInput,
  VoiceWebRtcOffer,
  VoiceSessionId,
  type VoiceNativeHeartbeatResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { VoiceNativeControlGrantRegistry } from "./Services/VoiceNativeControlGrantRegistry.ts";
import { VoiceNativeRealtimeStartRepository } from "../persistence/Services/VoiceNativeRealtimeStarts.ts";
import { VoiceNativeRuntimeGrantRegistry } from "./Services/VoiceNativeRuntimeGrantRegistry.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";
import { VoiceError } from "./Errors.ts";

const VOICE_CONTROL_HEADER = "x-t3-voice-control";
const VOICE_RUNTIME_HEADER = "x-t3-voice-runtime";
const MAXIMUM_HEARTBEAT_BODY_BYTES = 256;
const MAXIMUM_ACTION_ACK_BODY_BYTES = 512;
const HEARTBEAT_BODY_TIMEOUT = "2 seconds";
const NATIVE_REALTIME_START_CLAIM_MILLIS = 60_000;
const decodeSessionId = Schema.decodeUnknownEffect(VoiceSessionId);
const decodeHeartbeatInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceNativeHeartbeatInput),
);
const decodeActionId = Schema.decodeUnknownEffect(VoiceClientActionId);
const decodeActionAckInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceNativeHandoffActionAckInput),
);
const decodeRealtimeStartInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceNativeRealtimeStartInput),
);
const decodeWebRtcOfferInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceWebRtcOffer),
);
const decodeLeaseInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceSessionLeaseInput),
);

export const protectNativeRealtimeStartCriticalSection = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.uninterruptible);

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    { code: "auth_invalid", reason: "invalid_credential" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );

const invalidRequest = () =>
  HttpServerResponse.jsonUnsafe(
    {
      code: "invalid_request",
      message: "Invalid native voice request",
    },
    { status: 400, headers: { "cache-control": "no-store" } },
  );

const voiceOperationFailure = (error: VoiceError) => {
  const status =
    error.reason === "session-not-found" || error.reason === "conversation-not-found"
      ? 404
      : error.reason === "quota-exceeded"
        ? 429
        : error.reason === "provider-unavailable" ||
            error.reason === "disabled" ||
            error.reason === "not-configured"
          ? 503
          : 409;
  return HttpServerResponse.jsonUnsafe(
    {
      code: "voice_operation_failed",
      reason: error.reason,
      message: error.detail,
      retryable: error.retryable,
    },
    { status, headers: { "cache-control": "no-store" } },
  );
};

const decodeHeartbeatBody = (request: HttpServerRequest.HttpServerRequest) => {
  let observedBytes = 0;
  return request.stream.pipe(
    Stream.takeUntil((chunk) => {
      observedBytes += chunk.byteLength;
      return observedBytes > MAXIMUM_HEARTBEAT_BODY_BYTES;
    }),
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (observed, chunk) => {
        const remaining = MAXIMUM_HEARTBEAT_BODY_BYTES + 1 - observed.byteLength;
        const boundedChunk = chunk.subarray(0, remaining);
        const combined = new Uint8Array(observed.byteLength + boundedChunk.byteLength);
        combined.set(observed);
        combined.set(boundedChunk, observed.byteLength);
        return Effect.succeed(combined);
      },
    ),
    Effect.timeout(HEARTBEAT_BODY_TIMEOUT),
    Effect.filterOrFail(
      (bytes) => bytes.byteLength <= MAXIMUM_HEARTBEAT_BODY_BYTES,
      () => undefined,
    ),
    Effect.flatMap((bytes) =>
      decodeHeartbeatInputJson(new TextDecoder().decode(bytes), {
        onExcessProperty: "error",
      }),
    ),
    Effect.option,
  );
};

const decodeActionAckBody = (request: HttpServerRequest.HttpServerRequest) => {
  let observedBytes = 0;
  return request.stream.pipe(
    Stream.takeUntil((chunk) => {
      observedBytes += chunk.byteLength;
      return observedBytes > MAXIMUM_ACTION_ACK_BODY_BYTES;
    }),
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (observed, chunk) => {
        const remaining = MAXIMUM_ACTION_ACK_BODY_BYTES + 1 - observed.byteLength;
        const boundedChunk = chunk.subarray(0, remaining);
        const combined = new Uint8Array(observed.byteLength + boundedChunk.byteLength);
        combined.set(observed);
        combined.set(boundedChunk, observed.byteLength);
        return Effect.succeed(combined);
      },
    ),
    Effect.timeout(HEARTBEAT_BODY_TIMEOUT),
    Effect.filterOrFail(
      (bytes) => bytes.byteLength <= MAXIMUM_ACTION_ACK_BODY_BYTES,
      () => undefined,
    ),
    Effect.flatMap((bytes) =>
      decodeActionAckInputJson(new TextDecoder().decode(bytes), {
        onExcessProperty: "error",
      }),
    ),
    Effect.option,
  );
};

const decodeJsonBody = <A>(
  request: HttpServerRequest.HttpServerRequest,
  decoder: (input: string) => Effect.Effect<A, Schema.SchemaError>,
  maximumBytes: number,
) => {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return Effect.succeed(Option.none<A>());
  }
  return request.stream.pipe(
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (observed, chunk) => {
        if (observed.byteLength + chunk.byteLength > maximumBytes) return Effect.fail(undefined);
        const combined = new Uint8Array(observed.byteLength + chunk.byteLength);
        combined.set(observed);
        combined.set(chunk, observed.byteLength);
        return Effect.succeed(combined);
      },
    ),
    Effect.timeout(HEARTBEAT_BODY_TIMEOUT),
    Effect.flatMap((bytes) => decoder(new TextDecoder().decode(bytes))),
    Effect.option,
  );
};

const nativeRealtimeStartRoute = HttpRouter.add(
  "POST",
  "/api/voice/native/realtime-sessions",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers[VOICE_RUNTIME_HEADER];
    if (token === undefined) return unauthorized();
    const runtimeGrants = yield* VoiceNativeRuntimeGrantRegistry;
    const grant = yield* runtimeGrants.authorize(token);
    const input = yield* decodeJsonBody(
      request,
      (body) => decodeRealtimeStartInputJson(body, { onExcessProperty: "error" }),
      2_048,
    );
    if (grant === undefined || grant.target.mode !== "realtime") return unauthorized();
    if (input._tag === "None") return invalidRequest();
    if (grant.runtimeId !== input.value.runtimeId || grant.generation !== input.value.generation)
      return unauthorized();
    const current = yield* runtimeGrants.authorize(token);
    if (
      current === undefined ||
      current.runtimeId !== grant.runtimeId ||
      current.generation !== grant.generation ||
      current.authSessionId !== grant.authSessionId
    )
      return unauthorized();
    const idempotencyKey = `native:${grant.authSessionId}:${grant.runtimeId}:${grant.generation}:${NodeCrypto.createHash(
      "sha256",
    )
      .update(input.value.clientOperationId)
      .digest("base64url")}`;
    const focus = grant.target.focus;
    const sessions = yield* VoiceSessionService;
    const principal = {
      sessionId: grant.authSessionId,
      scopes: grant.grantedScopes,
      nativeRuntime: { runtimeId: grant.runtimeId, generation: grant.generation },
    };
    const createInput = {
      mode: "realtime-agent" as const,
      conversation: {
        type: "continue" as const,
        conversationId: grant.target.conversation.conversationId,
        takeover: false,
      },
      ...(focus.type === "none" ? {} : { projectId: focus.projectId }),
      ...(focus.type === "thread" ? { threadId: focus.threadId } : {}),
      media: {
        transports: ["webrtc-sdp-v1" as const],
        audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1" as const],
        supportsInputRouteSelection: true,
        supportsOutputRouteSelection: true,
      },
      idempotencyKey,
    };
    const starts = yield* VoiceNativeRealtimeStartRepository;
    const now = yield* Clock.currentTimeMillis;
    const claim = yield* starts
      .claim({
        operationKey: idempotencyKey,
        authSessionId: grant.authSessionId,
        runtimeId: grant.runtimeId,
        runtimeGeneration: grant.generation,
        clientOperationId: input.value.clientOperationId,
        conversationId: grant.target.conversation.conversationId,
        claimExpiresAt: Math.min(grant.expiresAt, now + NATIVE_REALTIME_START_CLAIM_MILLIS),
        expiresAt: grant.expiresAt,
        now,
      })
      .pipe(Effect.result);
    if (Result.isFailure(claim))
      return voiceOperationFailure(
        new VoiceError({
          reason: "provider-unavailable",
          operation: "native-realtime-start.claim",
          detail: "Native Realtime start storage is unavailable",
          retryable: true,
          cause: claim.failure,
        }),
      );
    if (claim.success.status === "mismatch")
      return voiceOperationFailure(
        new VoiceError({
          reason: "invalid-phase",
          operation: "native-realtime-start.claim",
          detail: "The idempotent native Realtime start cannot be reused",
          retryable: false,
        }),
      );
    if (claim.success.status === "existing" && claim.success.record.failure !== null)
      return voiceOperationFailure(new VoiceError(claim.success.record.failure));
    if (claim.success.status === "existing" && claim.success.record.sessionId === null) {
      const pending = now <= claim.success.record.claimExpiresAt;
      return voiceOperationFailure(
        new VoiceError({
          reason: pending ? "lease-conflict" : "session-not-found",
          operation: "native-realtime-start.claim",
          detail: pending
            ? "The original native Realtime start is still pending"
            : "The original native Realtime start did not create a session",
          retryable: pending,
        }),
      );
    }
    const existingSessionId =
      claim.success.status === "existing"
        ? (claim.success.record.sessionId ?? undefined)
        : undefined;
    const result = yield* Effect.gen(function* () {
      const created = yield* (
        existingSessionId === undefined
          ? sessions.create(principal, createInput)
          : sessions.resumeCreate(principal, createInput, existingSessionId)
      ).pipe(Effect.result);
      if (claim.success.status !== "claimed") return created;
      if (Result.isFailure(created)) {
        const persisted = yield* starts
          .fail(
            idempotencyKey,
            {
              reason: created.failure.reason,
              operation: created.failure.operation,
              detail: created.failure.detail,
              retryable: created.failure.retryable,
            },
            yield* Clock.currentTimeMillis,
          )
          .pipe(Effect.result);
        if (Result.isSuccess(persisted) && persisted.success) return created;
        return Result.fail(
          new VoiceError({
            reason: "provider-unavailable",
            operation: "native-realtime-start.fail",
            detail: "Native Realtime start outcome could not be persisted",
            retryable: true,
          }),
        );
      }
      const boundAt = yield* Clock.currentTimeMillis;
      const bound = yield* starts
        .bindSession(idempotencyKey, created.success.state.sessionId, boundAt)
        .pipe(Effect.result);
      if (Result.isSuccess(bound) && bound.success) return created;
      yield* sessions
        .close(
          grant.authSessionId,
          created.success.state.sessionId,
          created.success.state.leaseGeneration,
        )
        .pipe(Effect.ignore);
      const bindFailure = new VoiceError({
        reason: "provider-unavailable",
        operation: "native-realtime-start.bind",
        detail: "Native Realtime start storage is unavailable",
        retryable: true,
      });
      yield* starts
        .fail(
          idempotencyKey,
          {
            reason: bindFailure.reason,
            operation: bindFailure.operation,
            detail: bindFailure.detail,
            retryable: bindFailure.retryable,
          },
          yield* Clock.currentTimeMillis,
        )
        .pipe(Effect.ignore);
      return Result.fail(bindFailure);
    }).pipe(protectNativeRealtimeStartCriticalSection);
    return Result.isFailure(result)
      ? voiceOperationFailure(result.failure)
      : HttpServerResponse.jsonUnsafe(
          {
            ...result.success,
            transport: {
              ...result.success.transport,
              signalingPath: `/api/voice/native/realtime-sessions/${result.success.state.sessionId}/webrtc-offer`,
            },
          },
          { headers: { "cache-control": "no-store" } },
        );
  }),
);

const nativeRealtimeOfferRoute = HttpRouter.add(
  "POST",
  "/api/voice/native/realtime-sessions/:sessionId/webrtc-offer",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const routeContext = yield* HttpRouter.RouteContext;
    const token = request.headers[VOICE_CONTROL_HEADER];
    if (token === undefined) return unauthorized();
    const grants = yield* VoiceNativeControlGrantRegistry;
    const grant = yield* grants.authorize(token);
    const sessionId = yield* decodeSessionId(routeContext.params.sessionId).pipe(Effect.option);
    const input = yield* decodeJsonBody(
      request,
      (body) => decodeWebRtcOfferInputJson(body, { onExcessProperty: "error" }),
      128 * 1_024,
    );
    if (
      grant === undefined ||
      !grant.capabilities.has("webrtc-signaling") ||
      sessionId._tag === "None" ||
      input._tag === "None" ||
      grant.sessionId !== sessionId.value ||
      input.value.sessionId !== sessionId.value ||
      input.value.leaseGeneration !== grant.leaseGeneration
    )
      return unauthorized();
    const currentGrant = yield* grants.authorize(token);
    if (
      currentGrant === undefined ||
      !currentGrant.capabilities.has("webrtc-signaling") ||
      currentGrant.authSessionId !== grant.authSessionId ||
      currentGrant.sessionId !== grant.sessionId ||
      currentGrant.leaseGeneration !== grant.leaseGeneration
    )
      return unauthorized();
    const answer = yield* (yield* VoiceSessionService)
      .offer(grant.authSessionId, grant.sessionId, input.value)
      .pipe(Effect.result);
    return Result.isFailure(answer)
      ? voiceOperationFailure(answer.failure)
      : HttpServerResponse.jsonUnsafe(answer.success, {
          headers: { "cache-control": "no-store" },
        });
  }),
);

const nativeRealtimeCloseRoute = HttpRouter.add(
  "POST",
  "/api/voice/native/realtime-sessions/:sessionId/close",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const routeContext = yield* HttpRouter.RouteContext;
    const token = request.headers[VOICE_CONTROL_HEADER];
    if (token === undefined) return unauthorized();
    const grants = yield* VoiceNativeControlGrantRegistry;
    const grant = yield* grants.authorize(token);
    const sessionId = yield* decodeSessionId(routeContext.params.sessionId).pipe(Effect.option);
    const input = yield* decodeJsonBody(
      request,
      (body) => decodeLeaseInputJson(body, { onExcessProperty: "error" }),
      256,
    );
    if (
      grant === undefined ||
      !grant.capabilities.has("session-close") ||
      sessionId._tag === "None" ||
      input._tag === "None" ||
      grant.sessionId !== sessionId.value ||
      input.value.leaseGeneration !== grant.leaseGeneration
    )
      return unauthorized();
    const currentGrant = yield* grants.authorize(token);
    if (
      currentGrant === undefined ||
      !currentGrant.capabilities.has("session-close") ||
      currentGrant.authSessionId !== grant.authSessionId ||
      currentGrant.sessionId !== grant.sessionId ||
      currentGrant.leaseGeneration !== grant.leaseGeneration
    )
      return unauthorized();
    const result = yield* (yield* VoiceSessionService)
      .close(grant.authSessionId, grant.sessionId, grant.leaseGeneration)
      .pipe(Effect.result);
    if (Result.isFailure(result)) return voiceOperationFailure(result.failure);
    yield* grants.revokeSession(grant.sessionId);
    return HttpServerResponse.jsonUnsafe(result.success, {
      headers: { "cache-control": "no-store" },
    });
  }),
);

const heartbeatRoute = HttpRouter.add(
  "POST",
  "/api/voice/sessions/:sessionId/native-heartbeat",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const routeContext = yield* HttpRouter.RouteContext;
    const token = request.headers[VOICE_CONTROL_HEADER];
    if (token === undefined) return unauthorized();

    const grants = yield* VoiceNativeControlGrantRegistry;
    const grant = yield* grants.authorize(token);
    if (grant === undefined || !grant.capabilities.has("session-control")) return unauthorized();

    const sessionId = yield* decodeSessionId(routeContext.params.sessionId).pipe(Effect.option);
    const input = yield* decodeHeartbeatBody(request);
    if (input._tag === "None") return invalidRequest();
    if (
      sessionId._tag === "None" ||
      sessionId.value !== grant.sessionId ||
      input.value.leaseGeneration !== grant.leaseGeneration
    ) {
      return unauthorized();
    }

    const currentGrant = yield* grants.authorize(token);
    if (
      currentGrant === undefined ||
      currentGrant.sessionId !== grant.sessionId ||
      currentGrant.leaseGeneration !== grant.leaseGeneration ||
      currentGrant.authSessionId !== grant.authSessionId
    ) {
      return unauthorized();
    }

    const sessions = yield* VoiceSessionService;
    const state = yield* sessions
      .heartbeat(grant.authSessionId, grant.sessionId, grant.leaseGeneration)
      .pipe(Effect.option);
    if (state._tag === "None") return unauthorized();

    const result: VoiceNativeHeartbeatResult = {
      sessionId: state.value.sessionId,
      leaseGeneration: state.value.leaseGeneration,
      phase: state.value.phase,
      disposition:
        state.value.phase === "ended" || state.value.phase === "error" ? "terminal" : "live",
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(grant.expiresAt)),
    };
    return HttpServerResponse.jsonUnsafe(result, {
      headers: { "cache-control": "no-store" },
    });
  }),
);

const pendingHandoffActionsRoute = HttpRouter.add(
  "GET",
  "/api/voice/native/handoff-actions",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers[VOICE_CONTROL_HEADER];
    if (token === undefined) return unauthorized();
    const grants = yield* VoiceNativeControlGrantRegistry;
    const grant = yield* grants.authorize(token);
    if (grant === undefined || !grant.capabilities.has("handoff-actions")) return unauthorized();

    const sessions = yield* VoiceSessionService;
    const pending = yield* sessions
      .listPendingHandoffActions(grant.authSessionId, grant.sessionId, grant.leaseGeneration, 20)
      .pipe(Effect.option);
    if (pending._tag === "None") {
      return HttpServerResponse.jsonUnsafe(
        {
          code: "voice_operation_failed",
          message: "Could not list handoff actions",
        },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
    return HttpServerResponse.jsonUnsafe(
      {
        actions: pending.value,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);

const acknowledgeHandoffActionRoute = HttpRouter.add(
  "POST",
  "/api/voice/native/handoff-actions/:actionId/ack",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const routeContext = yield* HttpRouter.RouteContext;
    const token = request.headers[VOICE_CONTROL_HEADER];
    if (token === undefined) return unauthorized();
    const grants = yield* VoiceNativeControlGrantRegistry;
    const grant = yield* grants.authorize(token);
    if (grant === undefined || !grant.capabilities.has("handoff-actions")) return unauthorized();
    const actionId = yield* decodeActionId(routeContext.params.actionId).pipe(Effect.option);
    const input = yield* decodeActionAckBody(request);
    if (actionId._tag === "None" || input._tag === "None") return invalidRequest();

    const currentGrant = yield* grants.authorize(token);
    if (
      currentGrant === undefined ||
      !currentGrant.capabilities.has("handoff-actions") ||
      currentGrant.authSessionId !== grant.authSessionId
    ) {
      return unauthorized();
    }
    const sessions = yield* VoiceSessionService;
    const result = yield* sessions
      .acknowledgeNativeHandoffAction(
        grant.authSessionId,
        grant.sessionId,
        grant.leaseGeneration,
        actionId.value,
        input.value,
      )
      .pipe(Effect.option);
    if (result._tag === "None") {
      return HttpServerResponse.jsonUnsafe(
        {
          code: "voice_operation_failed",
          message: "Could not acknowledge handoff action",
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    yield* grants.revokeSession(grant.sessionId);
    return HttpServerResponse.jsonUnsafe(result.value, {
      headers: { "cache-control": "no-store" },
    });
  }),
);

export const voiceNativeControlRoutesLayer = Layer.mergeAll(
  nativeRealtimeStartRoute,
  nativeRealtimeOfferRoute,
  nativeRealtimeCloseRoute,
  heartbeatRoute,
  pendingHandoffActionsRoute,
  acknowledgeHandoffActionRoute,
);

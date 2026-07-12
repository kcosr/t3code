import {
  VoiceNativeHeartbeatInput,
  VoiceSessionId,
  type VoiceNativeHeartbeatResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { VoiceNativeControlGrantRegistry } from "./Services/VoiceNativeControlGrantRegistry.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";

const VOICE_CONTROL_HEADER = "x-t3-voice-control";
const MAXIMUM_HEARTBEAT_BODY_BYTES = 256;
const HEARTBEAT_BODY_TIMEOUT = "2 seconds";
const decodeSessionId = Schema.decodeUnknownEffect(VoiceSessionId);
const decodeHeartbeatInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceNativeHeartbeatInput),
);

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    { code: "auth_invalid", reason: "invalid_credential" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );

const invalidRequest = () =>
  HttpServerResponse.jsonUnsafe(
    { code: "invalid_request", message: "Invalid native voice heartbeat request" },
    { status: 400, headers: { "cache-control": "no-store" } },
  );

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
      decodeHeartbeatInputJson(new TextDecoder().decode(bytes), { onExcessProperty: "error" }),
    ),
    Effect.option,
  );
};

const route = HttpRouter.add(
  "POST",
  "/api/voice/sessions/:sessionId/native-heartbeat",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const routeContext = yield* HttpRouter.RouteContext;
    const token = request.headers[VOICE_CONTROL_HEADER];
    if (token === undefined) return unauthorized();

    const grants = yield* VoiceNativeControlGrantRegistry;
    const grant = yield* grants.authorize(token);
    if (grant === undefined) return unauthorized();

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

export const voiceNativeControlRoutesLayer = Layer.mergeAll(route);

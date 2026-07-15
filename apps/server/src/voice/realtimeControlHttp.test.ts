// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - HTTP integration exercises the Node boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthVoiceUseScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
  type VoiceSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  type PersistedVoiceRuntimeRealtimeStart,
  VoiceRuntimeRealtimeStartRepository,
} from "../persistence/Services/VoiceRuntimeRealtimeStarts.ts";
import { VoiceRealtimeTransitionReservationRepository } from "../persistence/Services/VoiceRealtimeTransitionReservations.ts";
import { VoiceRuntimeAuthorityRepository } from "../persistence/Services/VoiceRuntimeAuthorities.ts";
import { VoiceRealtimeControlServiceLive } from "./Layers/VoiceRealtimeControlService.ts";
import { voiceRealtimeControlRoutesLayer } from "./realtimeControlHttp.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";

const ownerAuthSessionId = AuthSessionId.make("realtime-route-owner");
const otherAuthSessionId = AuthSessionId.make("realtime-route-other");
const sessionId = VoiceSessionId.make("realtime-route-session");
const runtimeId = VoiceRuntimeId.make("realtime-route-runtime");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("realtime-route-instance");
const modeSessionId = VoiceModeSessionId.make("realtime-route-mode");
const conversationId = VoiceConversationId.make("realtime-route-conversation");
const leaseGeneration = 9;
const generation = 1;
const state = {
  sessionId,
  conversationId,
  mode: "realtime-agent" as const,
  phase: "listening" as const,
  leaseGeneration,
  sequence: 0,
} satisfies VoiceSessionState;
const fence = {
  runtimeId,
  runtimeInstanceId,
  generation,
  modeSessionId,
  leaseGeneration,
};
const threadModeSessionId = VoiceModeSessionId.make("realtime-route-thread-mode");
const threadTarget = {
  mode: "thread" as const,
  environmentId: EnvironmentId.make("realtime-route-environment"),
  projectId: ProjectId.make("realtime-route-project"),
  threadId: ThreadId.make("realtime-route-thread"),
  speechPreset: "default" as const,
  autoRearm: true,
  endpointPolicy: {
    endSilenceMs: 2_200,
    noSpeechTimeoutMs: null,
    maximumUtteranceMs: 600_000,
  },
  speechEnabled: true,
  rearmGuardMs: 500,
};

const authenticateHttpRequest: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"] =
  (request) => {
    const authorization = request.headers.authorization;
    const noVoiceScope = authorization === "Bearer no-voice";
    return Effect.succeed({
      sessionId: authorization === "Bearer other" ? otherAuthSessionId : ownerAuthSessionId,
      subject: "realtime-route-test",
      method: "bearer-access-token" as const,
      scopes: noVoiceScope ? [] : [AuthVoiceUseScope],
    });
  };

const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({ authenticateHttpRequest });

const startRecord = (closeOnly: boolean): PersistedVoiceRuntimeRealtimeStart => ({
  operationKey: "realtime-route-start",
  authSessionId: ownerAuthSessionId,
  runtimeId,
  runtimeInstanceId,
  runtimeGeneration: generation,
  modeSessionId,
  clientOperationId: "realtime-route-start",
  conversationId,
  sessionId,
  leaseGeneration,
  closeOnly,
  failure: null,
  claimExpiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
  expiresAt: Date.parse("2099-01-01T01:00:00.000Z"),
});

const makeControlServiceLayer = (closeOnly: boolean) =>
  VoiceRealtimeControlServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(VoiceRuntimeRealtimeStartRepository)({
          findBySession: () => Effect.succeed(startRecord(closeOnly)),
        }),
        Layer.mock(VoiceRuntimeAuthorityRepository)({
          consumeHandoff: () => Effect.succeed({ status: "existing", target: threadTarget }),
        }),
        Layer.mock(VoiceRealtimeTransitionReservationRepository)({}),
        Layer.mock(VoiceSessionService)({
          acknowledgeRuntimeHandoffAction: (_owner, _session, _lease, actionId) =>
            Effect.succeed({
              actionId,
              action: "handoff-to-thread-voice" as const,
              outcome: "succeeded" as const,
            }),
          close: () =>
            Effect.succeed({ state: { ...state, phase: "ended" as const }, closed: true }),
        }),
      ),
    ),
  );

const withServer = (closeOnly: boolean, run: (baseUrl: string) => Promise<void>) => {
  const serverLayer = HttpRouter.serve(voiceRealtimeControlRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(makeControlServiceLayer(closeOnly)),
    Layer.provide(authLayer),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address))
        return yield* Effect.die("Expected a TCP test server address");
      yield* Effect.promise(() => run(`http://127.0.0.1:${address.port}`));
    }).pipe(Effect.provide(serverLayer)),
  );
};

const runtimeHeaders = (authorization = "Bearer owner") => ({
  authorization,
  "content-type": "application/json",
  "x-t3-voice-runtime-protocol-major": "2",
});

const post = (baseUrl: string, path: string, body: unknown, authorization?: string) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: runtimeHeaders(authorization),
    body: JSON.stringify(body),
  });

const postHeadersWithoutBody = (baseUrl: string, path: string, authorization: string) =>
  new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request(
      new URL(path, baseUrl),
      {
        method: "POST",
        headers: {
          ...runtimeHeaders(authorization),
          "content-length": "1048576",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
          request.destroy();
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(2_000, () => reject(new Error("Route consumed the unauthorized body")));
    request.flushHeaders();
  });

describe("Realtime runtime HTTP session authority", () => {
  it.effect("rejects missing voice:use scope before consuming the request body", () =>
    withServer(false, async (baseUrl) => {
      expect(
        await postHeadersWithoutBody(
          baseUrl,
          "/api/voice/runtime/realtime-sessions",
          "Bearer no-voice",
        ),
      ).toBe(403);
    }),
  );

  it.effect("rejects a mismatched canonical fence at the route boundary", () =>
    withServer(false, async (baseUrl) => {
      const result = await post(
        baseUrl,
        `/api/voice/runtime/realtime-sessions/${sessionId}/heartbeat`,
        { ...fence, modeSessionId: VoiceModeSessionId.make("mismatched-mode") },
      );
      expect(result.status).toBe(401);
      expect(await result.json()).toMatchObject({
        code: "voice_operation_failed",
        reason: "authorization-revoked",
      });
    }),
  );

  it.effect("admits only close and handoff-commit replay after generation supersession", () =>
    withServer(true, async (baseUrl) => {
      const root = `/api/voice/runtime/realtime-sessions/${sessionId}`;
      const rejected = await Promise.all([
        post(baseUrl, `${root}/webrtc-offer`, {
          ...fence,
          clientOperationId: "close-only-offer",
          sdp: "offer",
        }),
        post(baseUrl, `${root}/heartbeat`, fence),
        fetch(
          `${baseUrl}${root}/actions?${new URLSearchParams({
            ...Object.fromEntries(
              Object.entries(fence).map(([key, value]) => [key, String(value)]),
            ),
            afterSequence: "0",
            waitMilliseconds: "0",
          })}`,
          { headers: runtimeHeaders() },
        ),
        post(baseUrl, `${root}/actions/rejected-action/ack`, {
          ...fence,
          clientOperationId: "close-only-ack",
          actionSequence: 1,
          action: "navigate-thread",
          outcome: "succeeded",
        }),
        fetch(`${baseUrl}${root}/focus`, {
          method: "PUT",
          headers: runtimeHeaders(),
          body: JSON.stringify({
            ...fence,
            clientOperationId: "close-only-focus",
            focus: null,
          }),
        }),
        post(baseUrl, `${root}/handoffs/rejected-handoff/exchange`, {
          ...fence,
          clientOperationId: "close-only-handoff",
          actionSequence: 1,
          nextGeneration: 2,
          threadModeSessionId,
          environmentId: threadTarget.environmentId,
          speechPreset: threadTarget.speechPreset,
          endpointPolicy: threadTarget.endpointPolicy,
          speechEnabled: threadTarget.speechEnabled,
          rearmGuardMs: threadTarget.rearmGuardMs,
        }),
      ]);
      expect(rejected.map((result) => result.status)).toEqual([401, 401, 401, 401, 401, 401]);

      const committed = await post(baseUrl, `${root}/handoffs/handoff-action/commit`, {
        ...fence,
        actionSequence: 1,
        nextGeneration: 2,
        threadModeSessionId,
      });
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({ committed: true, replayed: true });

      const closed = await post(baseUrl, `${root}/close`, {
        ...fence,
        clientOperationId: "close-only-close",
      });
      expect(closed.status).toBe(200);
      expect(await closed.json()).toMatchObject({ closed: true });
    }),
  );
});

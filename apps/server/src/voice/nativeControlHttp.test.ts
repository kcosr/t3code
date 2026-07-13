// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - HTTP integration exercises the Node server boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  type VoiceNativeHandoffAction,
  VoiceConversationId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { voiceNativeControlRoutesLayer } from "./nativeControlHttp.ts";
import { VoiceError } from "./Errors.ts";
import { VoiceNativeControlGrantRegistry } from "./Services/VoiceNativeControlGrantRegistry.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";

const sessionId = VoiceSessionId.make("voice-session-native-http");
const otherSessionId = VoiceSessionId.make("voice-session-native-http-other");
const token = "native-control-http-token";
const expiresAt = Date.parse("2026-07-12T18:00:00.000Z");

const grantScope = {
  authSessionId: AuthSessionId.make("native-http-auth"),
  sessionId,
  leaseGeneration: 4,
  expiresAt,
  capabilities: new Set(["session-control", "handoff-actions"] as const),
};

const runWithServer = <A>(
  run: (baseUrl: string, heartbeatCalls: () => number) => Promise<A>,
  options: {
    readonly authorize?: (candidate: string, call: number) => typeof grantScope | undefined;
    readonly phase?: "listening" | "ended";
    readonly heartbeatFails?: boolean;
    readonly grants?: VoiceNativeControlGrantRegistry["Service"];
    readonly pendingActions?: ReadonlyArray<VoiceNativeHandoffAction>;
  } = {},
) => {
  let calls = 0;
  let authorizeCalls = 0;
  const grants = VoiceNativeControlGrantRegistry.of({
    issue: () => Effect.die("unused"),
    authorize: (candidate) => {
      authorizeCalls += 1;
      return Effect.succeed(
        options.authorize === undefined
          ? candidate === token
            ? grantScope
            : undefined
          : options.authorize(candidate, authorizeCalls),
      );
    },
    revokeSession: () => Effect.void,
    releaseSessionControl: () => Effect.void,
    revokeAuthSession: () => Effect.void,
  });
  const sessions = Layer.mock(VoiceSessionService)({
    heartbeat: (_owner, heartbeatSessionId, leaseGeneration) => {
      calls += 1;
      if (options.heartbeatFails) {
        return Effect.fail(
          new VoiceError({
            reason: "invalid-phase",
            operation: "native-heartbeat-test",
            detail: "heartbeat failed",
            retryable: false,
          }),
        );
      }
      return Effect.succeed({
        sessionId: heartbeatSessionId,
        conversationId: VoiceConversationId.make("native-http-conversation"),
        mode: "realtime-agent",
        phase: options.phase ?? "listening",
        leaseGeneration,
        sequence: calls,
      });
    },
    listPendingHandoffActions: (owner, handoffSessionId, leaseGeneration, limit) => {
      expect(owner).toBe(grantScope.authSessionId);
      expect(handoffSessionId).toBe(grantScope.sessionId);
      expect(leaseGeneration).toBe(grantScope.leaseGeneration);
      expect(limit).toBe(20);
      return Effect.succeed(options.pendingActions ?? []);
    },
    acknowledgeNativeHandoffAction: (owner, handoffSessionId, leaseGeneration, actionId, input) => {
      expect(owner).toBe(grantScope.authSessionId);
      expect(handoffSessionId).toBe(grantScope.sessionId);
      expect(leaseGeneration).toBe(grantScope.leaseGeneration);
      return Effect.succeed({
        actionId,
        action: "handoff-to-thread-voice" as const,
        outcome: input.outcome,
      });
    },
  });
  const serverLayer = HttpRouter.serve(voiceNativeControlRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(Layer.succeed(VoiceNativeControlGrantRegistry, options.grants ?? grants)),
    Layer.provide(sessions),
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        throw new Error("Expected a TCP test server address");
      }
      return yield* Effect.promise(() => run(`http://127.0.0.1:${address.port}`, () => calls));
    }).pipe(Effect.provide(serverLayer)),
  );
};

const heartbeat = (
  baseUrl: string,
  input: {
    readonly pathSessionId?: string;
    readonly token?: string;
    readonly body?: string;
  },
) =>
  fetch(`${baseUrl}/api/voice/sessions/${input.pathSessionId ?? sessionId}/native-heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.token === undefined ? {} : { "x-t3-voice-control": input.token }),
    },
    body: input.body ?? '{"leaseGeneration":4}',
  });

const expectNoStore = (response: Response) =>
  expect(response.headers.get("cache-control")).toBe("no-store");

describe("native voice control HTTP", () => {
  it.effect("polls and acknowledges handoff actions with the native grant", () =>
    runWithServer(
      async (baseUrl) => {
        const pending = await fetch(`${baseUrl}/api/voice/native/handoff-actions`, {
          headers: { "x-t3-voice-control": token },
        });
        expect(pending.status).toBe(200);
        expect(await pending.json()).toMatchObject({
          actions: [{ actionId: "native-action-1", sessionId, autoRearm: true }],
        });
        const acknowledged = await fetch(
          `${baseUrl}/api/voice/native/handoff-actions/native-action-1/ack`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-t3-voice-control": token,
            },
            body: '{"outcome":"succeeded","state":"listening"}',
          },
        );
        expect(acknowledged.status).toBe(200);
        expect(await acknowledged.json()).toMatchObject({
          actionId: "native-action-1",
          action: "handoff-to-thread-voice",
          outcome: "succeeded",
        });
      },
      {
        pendingActions: [
          {
            actionId: VoiceClientActionId.make("native-action-1"),
            sessionId,
            leaseGeneration: 4,
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make("thread-1"),
            autoRearm: true,
            expiresAt: "2026-07-12T18:00:00.000Z",
          },
        ],
      },
    ),
  );

  it.effect(
    "rejects missing, wrong, and bearer-only credentials without a main-auth fallback",
    () =>
      runWithServer(async (baseUrl, calls) => {
        const missing = await heartbeat(baseUrl, {});
        const wrong = await heartbeat(baseUrl, { token: "wrong-token" });
        const bearerOnly = await fetch(
          `${baseUrl}/api/voice/sessions/${sessionId}/native-heartbeat`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer otherwise-valid-main-auth",
              "content-type": "application/json",
            },
            body: '{"leaseGeneration":4}',
          },
        );
        for (const response of [missing, wrong, bearerOnly]) {
          expect(response.status).toBe(401);
          expectNoStore(response);
        }
        expect(calls()).toBe(0);
      }),
  );

  it.effect("accepts repeated heartbeats with the same multi-use grant", () =>
    runWithServer(async (baseUrl, calls) => {
      for (const expectedSequence of [1, 2]) {
        const response = await heartbeat(baseUrl, { token });
        expect(response.status).toBe(200);
        expectNoStore(response);
        expect(await response.json()).toMatchObject({
          sessionId,
          leaseGeneration: 4,
          phase: "listening",
          disposition: "live",
          expiresAt: "2026-07-12T18:00:00.000Z",
        });
        expect(calls()).toBe(expectedSequence);
      }
    }),
  );

  it.effect("rejects a grant used for the wrong path session or lease generation", () =>
    runWithServer(async (baseUrl, calls) => {
      const wrongSession = await heartbeat(baseUrl, {
        token,
        pathSessionId: otherSessionId,
      });
      const wrongGeneration = await heartbeat(baseUrl, {
        token,
        body: '{"leaseGeneration":5}',
      });
      for (const response of [wrongSession, wrongGeneration]) {
        expect(response.status).toBe(401);
        expectNoStore(response);
      }
      expect(calls()).toBe(0);
    }),
  );

  it.effect("rejects malformed heartbeat bodies before session control", () =>
    runWithServer(async (baseUrl, calls) => {
      const malformed = await heartbeat(baseUrl, { token, body: "{" });
      expect(malformed.status).toBe(400);
      expectNoStore(malformed);
      expect(calls()).toBe(0);
    }),
  );

  it.effect("rejects promptly at byte 257 without waiting for sender completion", () =>
    runWithServer(async (baseUrl, calls) => {
      const url = new URL(`/api/voice/sessions/${sessionId}/native-heartbeat`, baseUrl);
      const response = await new Promise<
        | { status: number; cacheControl: string | undefined; reset?: never }
        | { reset: true; status?: never; cacheControl?: never }
      >((resolve, reject) => {
        const request = NodeHttp.request(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
              "x-t3-voice-control": token,
            },
          },
          (incoming) => {
            clearTimeout(timeout);
            resolve({
              status: incoming.statusCode ?? 0,
              cacheControl: incoming.headers["cache-control"],
            });
            request.destroy();
          },
        );
        request.on("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timeout);
          if (error.code === "ECONNRESET") resolve({ reset: true });
          else reject(error);
        });
        request.write("x".repeat(257));
        const timeout = setTimeout(() => {
          request.destroy();
          reject(new Error("oversized streaming request was not rejected"));
        }, 1_000);
      });
      if (response.reset !== true) {
        expect(response).toEqual({ status: 400, cacheControl: "no-store" });
      }
      expect(calls()).toBe(0);
    }),
  );

  it.effect("re-authorizes immediately before heartbeat to fence rotation or revocation", () =>
    runWithServer(
      async (baseUrl, calls) => {
        const response = await heartbeat(baseUrl, { token });
        expect(response.status).toBe(401);
        expectNoStore(response);
        expect(calls()).toBe(0);
      },
      {
        authorize: (candidate, call) =>
          candidate === token && call === 1 ? grantScope : undefined,
      },
    ),
  );

  it.effect(
    "returns terminal disposition and maps heartbeat service failures to unauthorized",
    () =>
      Effect.gen(function* () {
        yield* runWithServer(
          async (baseUrl) => {
            const response = await heartbeat(baseUrl, { token });
            expect(response.status).toBe(200);
            expectNoStore(response);
            expect(await response.json()).toMatchObject({
              phase: "ended",
              disposition: "terminal",
            });
          },
          { phase: "ended" },
        );
        yield* runWithServer(
          async (baseUrl) => {
            const response = await heartbeat(baseUrl, { token });
            expect(response.status).toBe(401);
            expectNoStore(response);
          },
          { heartbeatFails: true },
        );
      }),
  );
});

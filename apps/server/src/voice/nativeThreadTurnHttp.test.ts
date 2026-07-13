// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { VoiceError } from "./Errors.ts";
import { voiceNativeThreadTurnRoutesLayer } from "./nativeThreadTurnHttp.ts";
import { VoiceNativeThreadTurnService } from "./Services/VoiceNativeThreadTurnService.ts";

const runWithServer = <A, E, R>(
  run: (baseUrl: string) => Effect.Effect<A, E, R>,
  options: { readonly rejectCreate?: boolean; readonly expectedAuthorizationCalls?: number } = {},
) => {
  let authorizationCalls = 0;
  const rejectedOperation = () => {
    authorizationCalls += 1;
    return Effect.fail(
      new VoiceError({
        reason: "authorization-revoked",
        operation: "thread-turn.authorize",
        detail: "invalid",
        retryable: false,
      }),
    );
  };
  const service = Layer.succeed(
    VoiceNativeThreadTurnService,
    VoiceNativeThreadTurnService.of({
      authorizeCreate: () => {
        if (!options.rejectCreate) return Effect.void;
        authorizationCalls += 1;
        return Effect.fail(
          new VoiceError({
            reason: "authorization-revoked",
            operation: "thread-turn.create-authorize",
            detail: "invalid",
            retryable: false,
          }),
        );
      },
      authorizeOperation: rejectedOperation,
      beginAudioUpload: rejectedOperation,
      create: () => Effect.die("unused"),
      uploadAudio: () => Effect.die("unused"),
      events: rejectedOperation,
      acknowledgeEvents: () => Effect.die("unused"),
      speech: rejectedOperation,
      cancel: rejectedOperation,
      revokeRuntime: () => Effect.die("unused"),
    }),
  );
  const serverLayer = HttpRouter.serve(voiceNativeThreadTurnRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(service),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address))
        return yield* Effect.die("Expected a TCP test server address");
      const result = yield* run(`http://127.0.0.1:${address.port}`);
      expect(authorizationCalls).toBe(options.expectedAuthorizationCalls ?? 1);
      return result;
    }).pipe(Effect.provide(serverLayer)),
  );
};

describe("native thread turn HTTP", () => {
  it.effect("rejects an unauthorized create before consuming its body", () =>
    runWithServer(
      (baseUrl) =>
        Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              const request = NodeHttp.request(
                new URL("/api/voice/native/thread-turns", baseUrl),
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "content-length": "1048576",
                    "x-t3-voice-runtime": "invalid-runtime-token",
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
              request.flushHeaders();
            }),
        ),
      { rejectCreate: true },
    ).pipe(Effect.tap((status) => Effect.sync(() => expect(status).toBe(401)))),
  );

  it.effect("rejects an unauthorized audio upload before consuming its body", () =>
    runWithServer((baseUrl) =>
      Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            const url = new URL(
              "/api/voice/native/thread-turns/native-thread-operation/audio",
              baseUrl,
            );
            const request = NodeHttp.request(
              url,
              {
                method: "PUT",
                headers: {
                  "content-type": "audio/mp4",
                  "content-length": "1048576",
                  "x-t3-voice-operation": "invalid-operation-token",
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
            request.flushHeaders();
          }),
      ),
    ).pipe(Effect.tap((status) => Effect.sync(() => expect(status).toBe(401)))),
  );

  it.effect("rejects every operation endpoint after child authority is revoked", () =>
    runWithServer(
      (baseUrl) => {
        const operation = "/api/voice/native/thread-turns/native-thread-operation";
        const headers = { "x-t3-voice-operation": "revoked-operation-token" };
        return Effect.all(
          [
            HttpClient.get(new URL(`${operation}/events`, baseUrl), { headers }),
            HttpClient.post(new URL(`${operation}/events/ack`, baseUrl), { headers }),
            HttpClient.get(new URL(`${operation}/speech/0`, baseUrl), { headers }),
            HttpClient.post(new URL(`${operation}/cancel`, baseUrl), { headers }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map((responses) => responses.map((response) => response.status)));
      },
      { expectedAuthorizationCalls: 4 },
    ).pipe(
      Effect.tap((statuses) => Effect.sync(() => expect(statuses).toEqual([401, 401, 401, 401]))),
    ),
  );
});

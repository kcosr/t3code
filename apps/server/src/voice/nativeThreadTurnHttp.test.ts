// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { VoiceError } from "./Errors.ts";
import { voiceNativeThreadTurnRoutesLayer } from "./nativeThreadTurnHttp.ts";
import { VoiceNativeThreadTurnService } from "./Services/VoiceNativeThreadTurnService.ts";

const runWithServer = <A>(run: (baseUrl: string) => Promise<A>) => {
  let authorizationCalls = 0;
  const service = Layer.succeed(
    VoiceNativeThreadTurnService,
    VoiceNativeThreadTurnService.of({
      authorizeOperation: () => Effect.die("unused"),
      beginAudioUpload: () => {
        authorizationCalls += 1;
        return Effect.fail(
          new VoiceError({
            reason: "authorization-revoked",
            operation: "thread-turn.authorize",
            detail: "invalid",
            retryable: false,
          }),
        );
      },
      create: () => Effect.die("unused"),
      uploadAudio: () => Effect.die("unused"),
      events: () => Effect.die("unused"),
      acknowledgeEvents: () => Effect.die("unused"),
      speech: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
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
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address))
        return yield* Effect.die("Expected a TCP test server address");
      const result = yield* Effect.promise(() => run(`http://127.0.0.1:${address.port}`));
      expect(authorizationCalls).toBe(1);
      return result;
    }).pipe(Effect.provide(serverLayer)),
  );
};

describe("native thread turn HTTP", () => {
  it.effect("rejects an unauthorized audio upload before consuming its body", () =>
    runWithServer(
      (baseUrl) =>
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
    ).pipe(Effect.tap((status) => Effect.sync(() => expect(status).toBe(401)))),
  );
});

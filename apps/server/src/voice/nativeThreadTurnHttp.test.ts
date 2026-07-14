// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { VoiceRuntimeThreadTurnSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { VoiceError } from "./Errors.ts";
import { voiceNativeThreadTurnRoutesLayer } from "./nativeThreadTurnHttp.ts";
import { VoiceNativeThreadTurnService } from "./Services/VoiceNativeThreadTurnService.ts";

const operationSnapshot = Schema.decodeUnknownSync(VoiceRuntimeThreadTurnSnapshot)({
  operationId: "native-thread-operation",
  runtimeId: "runtime-1",
  runtimeInstanceId: "instance-1",
  generation: 1,
  modeSessionId: "mode-1",
  turnClientOperationId: "turn-client-1",
  submissionPolicy: "draft",
  speechPlanId: "speech-plan-1",
  projectId: "project-1",
  threadId: "thread-1",
  speechPreset: "default",
  autoRearm: true,
  phase: "draft-ready",
  userMessageId: null,
  turnId: null,
  assistantMessageIds: [],
  highestAdvertisedSegment: null,
  highestStartedSegment: null,
  highestDrainedSegment: null,
  segmentDispositions: [],
  lastSequence: 2,
  acknowledgedSequence: 0,
  speechTerminal: null,
  dispatchAccepted: false,
  detachedAt: null,
  operationTokenExpiresAt: "2026-07-14T02:00:00.000Z",
  retentionExpiresAt: "2026-08-13T00:00:00.000Z",
});

const runWithServer = <A, E, R>(
  run: (baseUrl: string) => Effect.Effect<A, E, R>,
  options: {
    readonly rejectCreate?: boolean;
    readonly acceptDraftOperations?: boolean;
    readonly expectedAuthorizationCalls?: number;
  } = {},
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
      authorizeOperation: options.acceptDraftOperations
        ? () => Effect.succeed(operationSnapshot)
        : rejectedOperation,
      beginAudioUpload: rejectedOperation,
      create: () => Effect.die("unused"),
      uploadAudio: () => Effect.die("unused"),
      setDraftDisposition: options.acceptDraftOperations
        ? () =>
            Effect.succeed({
              snapshot: { ...operationSnapshot, submissionPolicy: "draft", phase: "created" },
            })
        : rejectedOperation,
      events: rejectedOperation,
      acknowledgeEvents: () => Effect.die("unused"),
      speech: rejectedOperation,
      cancel: rejectedOperation,
      readDraft: options.acceptDraftOperations
        ? () =>
            Effect.succeed({
              operationId: operationSnapshot.operationId,
              transcript: "draft transcript",
              expiresAt: "2026-07-14T00:15:00.000Z",
            })
        : rejectedOperation,
      consumeDraft: options.acceptDraftOperations
        ? () => Effect.succeed({ snapshot: operationSnapshot, consumed: true })
        : rejectedOperation,
      detach: options.acceptDraftOperations
        ? () => Effect.succeed(operationSnapshot)
        : rejectedOperation,
      revokeRuntime: () => Effect.die("unused"),
    }),
  );
  const serverLayer = HttpRouter.serve(voiceNativeThreadTurnRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(service),
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
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
                new URL("/api/voice/runtime/thread-turns", baseUrl),
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
              "/api/voice/runtime/thread-turns/native-thread-operation/audio",
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
        const operation = "/api/voice/runtime/thread-turns/native-thread-operation";
        const headers = { "x-t3-voice-operation": "revoked-operation-token" };
        return Effect.all(
          [
            HttpClient.get(new URL(`${operation}/events`, baseUrl), {
              headers,
            }),
            HttpClient.post(new URL(`${operation}/events/ack`, baseUrl), {
              headers,
            }),
            HttpClient.post(new URL(`${operation}/disposition`, baseUrl), {
              headers,
              body: HttpBody.jsonUnsafe({ submissionPolicy: "draft" }),
            }),
            HttpClient.get(new URL(`${operation}/speech/0`, baseUrl), {
              headers,
            }),
            HttpClient.get(new URL(`${operation}/draft`, baseUrl), {
              headers,
            }),
            HttpClient.post(new URL(`${operation}/draft/consume`, baseUrl), {
              headers,
            }),
            HttpClient.post(new URL(`${operation}/detach`, baseUrl), {
              headers,
            }),
            HttpClient.post(new URL(`${operation}/cancel`, baseUrl), {
              headers,
            }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map((responses) => responses.map((response) => response.status)));
      },
      { expectedAuthorizationCalls: 8 },
    ).pipe(
      Effect.tap((statuses) =>
        Effect.sync(() => expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 401, 401])),
      ),
    ),
  );

  it.effect("accepts only the strict draft disposition body", () =>
    runWithServer(
      (baseUrl) => {
        const url = new URL(
          "/api/voice/runtime/thread-turns/native-thread-operation/disposition",
          baseUrl,
        );
        const headers = { "x-t3-voice-operation": "operation-token" };
        return Effect.all([
          HttpClient.post(url, {
            headers,
            body: HttpBody.jsonUnsafe({ submissionPolicy: "draft" }),
          }),
          HttpClient.post(url, {
            headers,
            body: HttpBody.jsonUnsafe({
              submissionPolicy: "draft",
              legacy: true,
            }),
          }),
          HttpClient.post(url, {
            headers,
            body: HttpBody.jsonUnsafe({ submissionPolicy: "auto-submit" }),
          }),
        ]).pipe(Effect.map((responses) => responses.map((response) => response.status)));
      },
      { acceptDraftOperations: true, expectedAuthorizationCalls: 0 },
    ).pipe(Effect.tap((statuses) => Effect.sync(() => expect(statuses).toEqual([200, 400, 400])))),
  );

  it.effect("serves canonical draft and detach operations through the child token", () =>
    runWithServer(
      (baseUrl) => {
        const operation = "/api/voice/runtime/thread-turns/native-thread-operation";
        const headers = { "x-t3-voice-operation": "operation-token" };
        return Effect.all([
          HttpClient.get(new URL(`${operation}/draft`, baseUrl), { headers }),
          HttpClient.post(new URL(`${operation}/draft/consume`, baseUrl), {
            headers,
          }),
          HttpClient.post(new URL(`${operation}/detach`, baseUrl), {
            headers,
          }),
        ]).pipe(Effect.map((responses) => responses.map((response) => response.status)));
      },
      { acceptDraftOperations: true, expectedAuthorizationCalls: 0 },
    ).pipe(Effect.tap((statuses) => Effect.sync(() => expect(statuses).toEqual([200, 200, 200])))),
  );
});

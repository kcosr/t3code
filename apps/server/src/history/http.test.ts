// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - HTTP integration exercises the Node server boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHistoryHttpApi,
  VoiceConversationEntryId,
  VoiceConversationId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { historyHttpApiLayer, historyPrivacyBoundaryLayer } from "./http.ts";
import { HistorySearchService } from "./Services/HistorySearchService.ts";

class HistoryTestApi extends HttpApi.make("environment").add(EnvironmentHistoryHttpApi) {}

const testPrincipal = (scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
  sessionId: AuthSessionId.make("history-http-session"),
  subject: "history-http-test",
  method: "bearer-access-token" as const,
  scopes: new Set(scopes),
});

const runWithServer = <A>(input: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly service: HistorySearchService["Service"];
  readonly run: (baseUrl: string) => Promise<A>;
  readonly capturedLogs?: Array<string>;
}) => {
  const serverLayer = HttpRouter.serve(
    HttpApiBuilder.layer(HistoryTestApi).pipe(
      Layer.provide(historyHttpApiLayer),
      Layer.provide(historyPrivacyBoundaryLayer),
      Layer.provide(
        Layer.succeed(
          EnvironmentAuthenticatedAuth,
          EnvironmentAuthenticatedAuth.of((effect) =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, testPrincipal(input.scopes)),
            ),
          ),
        ),
      ),
      Layer.provide(Layer.succeed(HistorySearchService, input.service)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer),
  );
  const captureLoggerLayer = Logger.layer(
    [
      Logger.make(({ fiber, message }) => {
        if (input.capturedLogs === undefined) return;
        const annotations = fiber.getRef(References.CurrentLogAnnotations);
        input.capturedLogs.push(
          [
            String(message),
            ...Object.entries(annotations).map(([key, value]) => `${key}:${String(value)}`),
          ].join(" "),
        );
      }),
    ],
    { mergeWithExisting: false },
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        throw new Error("Expected a TCP test server address");
      }
      return yield* Effect.promise(() => input.run(`http://127.0.0.1:${address.port}`));
    }).pipe(Effect.provide(serverLayer.pipe(Layer.provide(captureLoggerLayer)))),
  );
};

describe("history HTTP API", () => {
  it.effect("requires every requested source scope before invoking search", () => {
    let searchCalls = 0;
    const capturedLogs: Array<string> = [];
    const sentinel = "private-query-sentinel-7f12";
    return runWithServer({
      scopes: ["orchestration:read"],
      capturedLogs,
      service: HistorySearchService.of({
        search: () => {
          searchCalls += 1;
          return Effect.succeed({ matches: [], nextCursor: null });
        },
        read: () => Effect.die("read should not be called"),
      }),
      run: async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/history/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: sentinel,
            sources: ["thread-message", "voice-entry"],
            voiceScope: { type: "all-durable" },
            limit: 5,
          }),
        });
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(searchCalls).toBe(0);
        expect(capturedLogs.join("\n")).not.toContain(sentinel);
      },
    });
  });

  it.effect("allows a combined search only when both scopes are present", () => {
    let searchCalls = 0;
    return runWithServer({
      scopes: ["orchestration:read", "voice:use"],
      service: HistorySearchService.of({
        search: () => {
          searchCalls += 1;
          return Effect.succeed({ matches: [], nextCursor: null });
        },
        read: () => Effect.die("read should not be called"),
      }),
      run: async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/history/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: "history",
            sources: ["thread-message", "voice-entry"],
            voiceScope: { type: "all-durable" },
            limit: 5,
          }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(searchCalls).toBe(1);
      },
    });
  });

  it.effect("sanitizes malformed authenticated history payloads", () => {
    let searchCalls = 0;
    const capturedLogs: Array<string> = [];
    const sentinel = "private-malformed-sentinel-81ad";
    return runWithServer({
      scopes: ["orchestration:read"],
      capturedLogs,
      service: HistorySearchService.of({
        search: () => {
          searchCalls += 1;
          return Effect.succeed({ matches: [], nextCursor: null });
        },
        read: () => Effect.die("read should not be called"),
      }),
      run: async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/history/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: sentinel,
            sources: ["not-a-history-source"],
            limit: 5,
          }),
        });
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("pragma")).toBe("no-cache");
        expect(searchCalls).toBe(0);
        expect(capturedLogs.join("\n")).not.toContain(sentinel);
      },
    });
  });

  it.effect("annotates voice reads from the explicit voice scope", () => {
    const capturedLogs: Array<string> = [];
    return runWithServer({
      scopes: ["voice:use"],
      capturedLogs,
      service: HistorySearchService.of({
        search: () => Effect.die("search should not be called"),
        read: () =>
          Effect.logInfo("history read annotation probe").pipe(
            Effect.as({
              target: {
                ref: {
                  type: "voice-entry" as const,
                  conversationId: VoiceConversationId.make("conversation-1"),
                  entryId: VoiceConversationEntryId.make("entry-1"),
                },
                roleOrKind: "user",
                occurredAt: "2026-07-11T00:00:00.000Z",
                content: "bounded content",
                truncated: false,
              },
              context: [],
            }),
          ),
      }),
      run: async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/history/read`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ref: {
              type: "voice-entry",
              conversationId: "conversation-1",
              entryId: "entry-1",
            },
            voiceScope: { type: "conversation", conversationId: "conversation-1" },
            before: 0,
            after: 0,
          }),
        });
        expect(response.status).toBe(200);
        expect(capturedLogs.join("\n")).toContain("history.hasVoiceScope:true");
      },
    });
  });

  it.effect("rejects a mismatched voice read scope without invoking read", () => {
    let readCalls = 0;
    return runWithServer({
      scopes: ["voice:use"],
      service: HistorySearchService.of({
        search: () => Effect.die("search should not be called"),
        read: () => {
          readCalls += 1;
          return Effect.die("mismatched scope should not reach read");
        },
      }),
      run: async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/history/read`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ref: {
              type: "voice-entry",
              conversationId: "conversation-1",
              entryId: "entry-1",
            },
            voiceScope: { type: "conversation", conversationId: "conversation-2" },
            before: 0,
            after: 0,
          }),
        });
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(readCalls).toBe(0);
      },
    });
  });
});

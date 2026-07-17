import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HistoryVoiceEntryRef,
  VoiceConversationEntryId,
  VoiceConversationId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type PreparedConnection,
  PrimaryConnectionTarget,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeHistoryHttpClient } from "./client.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-history-test");

const preparedConnection = (
  httpAuthorization: PreparedHttpAuthorization | null,
): PreparedConnection => ({
  environmentId: ENVIRONMENT_ID,
  label: "History test",
  httpBaseUrl: "https://environment.example.test/base-path",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization,
  target: new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "History test",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  }),
});

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("makeHistoryHttpClient", () => {
  it.effect("uses credentialed cookies and keeps search text out of the URL", () =>
    Effect.gen(function* () {
      let received: { readonly url: string; readonly init?: RequestInit } | undefined;
      const client = makeHistoryHttpClient({
        prepared: preparedConnection(null),
        fetch: async (resource, init) => {
          received =
            init === undefined ? { url: String(resource) } : { url: String(resource), init };
          return jsonResponse({ matches: [], nextCursor: null });
        },
      });

      yield* client.search({
        query: "private deployment phrase",
        sources: ["thread-message"],
        limit: 10,
      });

      expect(received?.url).toBe("https://environment.example.test/api/history/search");
      expect(received?.url).not.toContain("private");
      expect(received?.init?.method).toBe("POST");
      expect(received?.init?.credentials).toBe("include");
    }),
  );

  it.effect("signs the exact POST URLs with DPoP", () =>
    Effect.gen(function* () {
      const proofs: Array<{ readonly method: string; readonly url: string }> = [];
      const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("thumbprint"),
        createProof: (input) => {
          proofs.push({ method: input.method, url: input.url });
          return Effect.succeed("signed-proof");
        },
      });
      const voiceRef = HistoryVoiceEntryRef.make({
        type: "voice-entry",
        conversationId: VoiceConversationId.make("conversation-1"),
        entryId: VoiceConversationEntryId.make("entry-1"),
      });
      const client = makeHistoryHttpClient({
        prepared: preparedConnection({ _tag: "Dpop", accessToken: "history-token" }),
        signer,
        fetch: async (resource, init) => {
          const url = String(resource);
          requests.push({
            url,
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return url.endsWith("/search")
            ? jsonResponse({ matches: [], nextCursor: null })
            : jsonResponse({
                target: {
                  ref: voiceRef,
                  roleOrKind: "transcript.user",
                  occurredAt: "2026-07-11T00:00:00.000Z",
                  content: "hello",
                  truncated: false,
                },
                context: [],
              });
        },
      });

      yield* client.search({
        query: "hello",
        sources: ["voice-entry"],
        voiceScope: { type: "all-durable" },
        limit: 5,
      });
      yield* client.read({
        ref: voiceRef,
        voiceScope: {
          type: "conversation",
          conversationId: VoiceConversationId.make("conversation-1"),
        },
        before: 1,
        after: 1,
      });

      expect(proofs).toEqual([
        { method: "POST", url: "https://environment.example.test/api/history/search" },
        { method: "POST", url: "https://environment.example.test/api/history/read" },
      ]);
      expect(requests.map(({ authorization }) => authorization)).toEqual([
        "DPoP history-token",
        "DPoP history-token",
      ]);
    }),
  );

  it.effect("preserves declared typed history request errors", () =>
    Effect.gen(function* () {
      const client = makeHistoryHttpClient({
        prepared: preparedConnection({ _tag: "Bearer", token: "history-token" }),
        fetch: async () =>
          jsonResponse(
            {
              _tag: "EnvironmentHistoryRequestError",
              code: "history_request_invalid",
              reason: "invalid_cursor",
              traceId: "trace-1",
            },
            400,
          ),
      });

      const error = yield* client
        .search({
          query: "hello",
          sources: ["thread-message"],
          limit: 5,
          cursor: "invalid",
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "EnvironmentHistoryRequestError",
        reason: "invalid_cursor",
      });
    }),
  );
});

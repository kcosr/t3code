import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConfirmationId,
  VoiceConversationId,
  VoiceMediaTicketId,
  VoicePlaybackId,
  VoiceRequestId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  type PreparedConnection,
  PrimaryConnectionTarget,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeVoiceHttpClient } from "./client.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-voice-test");
const CONVERSATION_ID = VoiceConversationId.make("conversation-1");
const REQUEST_ID = VoiceRequestId.make("request-1");
const PLAYBACK_ID = VoicePlaybackId.make("playback-1");
const SESSION_ID = VoiceSessionId.make("voice-session-1");
const CONFIRMATION_ID = VoiceConfirmationId.make("confirmation-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const preparedConnection = (
  httpAuthorization: PreparedHttpAuthorization | null,
): PreparedConnection => ({
  environmentId: ENVIRONMENT_ID,
  label: "Voice test",
  httpBaseUrl: "https://environment.example.test/base-path",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization,
  target: new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Voice test",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  }),
});

const conversation = {
  conversationId: CONVERSATION_ID,
  retention: "durable" as const,
  title: "Planning",
  activeEpoch: 1,
  createdAt: "2026-07-10T20:00:00.000Z",
  updatedAt: "2026-07-10T20:00:00.000Z",
};

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("makeVoiceHttpClient", () => {
  it.effect("uses credentialed cookies for local typed control requests", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly url: string;
        readonly init: RequestInit | undefined;
      }> = [];
      const fetch: typeof globalThis.fetch = async (resource, init) => {
        requests.push({ url: String(resource), init });
        return jsonResponse({
          version: 1,
          capabilities: [],
          conversationRetention: ["ephemeral", "durable"],
        });
      };
      const client = makeVoiceHttpClient({
        prepared: preparedConnection(null),
        fetch,
      });

      const result = yield* client.capabilities();

      expect(result.version).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://environment.example.test/api/voice/capabilities");
      expect(requests[0]?.init?.credentials).toBe("include");
      expect(new Headers(requests[0]?.init?.headers).has("authorization")).toBe(false);
    }),
  );

  it.effect("exposes conversation CRUD and media tickets through the typed voice API", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly url: string;
        readonly init: RequestInit | undefined;
      }> = [];
      const fetch: typeof globalThis.fetch = async (resource, init) => {
        const url = String(resource);
        requests.push({ url, init });
        const method = init?.method ?? "GET";
        if (url.endsWith("/media-tickets")) {
          return jsonResponse({
            ticketId: "ticket-1",
            token: "one-use-token",
            operation: "speech-stream",
            expiresAt: "2026-07-10T20:01:00.000Z",
          });
        }
        if (url.endsWith("/clear-context")) {
          return jsonResponse({
            conversationId: CONVERSATION_ID,
            activeEpoch: 2,
            clearedAt: "2026-07-10T20:00:30.000Z",
          });
        }
        if (method === "DELETE") {
          return jsonResponse({ deleted: true });
        }
        if (method === "GET" && url.endsWith("/conversations")) {
          return jsonResponse([conversation]);
        }
        return jsonResponse(conversation);
      };
      const client = makeVoiceHttpClient({
        prepared: preparedConnection({
          _tag: "Bearer",
          token: "voice-token",
        }),
        fetch,
      });

      const results = yield* Effect.all([
        client.createConversation({
          retention: "durable",
          title: "Planning",
        }),
        client.listConversations(),
        client.getConversation(CONVERSATION_ID),
        client.clearConversationContext(CONVERSATION_ID),
        client.deleteConversation(CONVERSATION_ID),
        client.createMediaTicket({
          operation: "speech-stream",
          requestId: REQUEST_ID,
        }),
      ]);

      expect(results[0]).toEqual(conversation);
      expect(results[1]).toEqual([conversation]);
      expect(results[3].activeEpoch).toBe(2);
      expect(results[4].deleted).toBe(true);
      expect(results[5].token).toBe("one-use-token");
      for (const request of requests) {
        expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer voice-token");
        expect(request.init?.credentials).toBeUndefined();
      }
    }),
  );

  it.effect("exposes the complete realtime session lifecycle", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly url: string;
        readonly method: string;
        readonly body: BodyInit | null | undefined;
      }> = [];
      const sessionState = {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        mode: "realtime-agent" as const,
        phase: "idle" as const,
        leaseGeneration: 1,
        sequence: 4,
      };
      const fetch: typeof globalThis.fetch = async (resource, init) => {
        const url = String(resource);
        const method = init?.method ?? "GET";
        requests.push({ url, method, body: init?.body });
        if (url.endsWith("/webrtc-offer")) {
          return jsonResponse({
            sessionId: SESSION_ID,
            leaseGeneration: 1,
            sdp: "answer-sdp",
          });
        }
        if (url.includes("/events")) {
          return jsonResponse({ state: sessionState, events: [] });
        }
        if (url.includes("/confirmations/")) {
          return jsonResponse({
            confirmationId: CONFIRMATION_ID,
            toolCallId: "tool-call-1",
            outcome: "approved",
          });
        }
        if (url.endsWith("/focus")) {
          return jsonResponse({ state: sessionState, projectId: PROJECT_ID, threadId: THREAD_ID });
        }
        if (method === "DELETE") {
          return jsonResponse({
            state: { ...sessionState, phase: "ended" },
            closed: true,
          });
        }
        if (url.endsWith("/sessions")) {
          return jsonResponse({
            state: { ...sessionState, phase: "signaling", sequence: 0 },
            transport: {
              kind: "webrtc-sdp-v1",
              signalingPath: `/api/voice/sessions/${SESSION_ID}/webrtc-offer`,
            },
            expiresAt: "2026-07-10T20:55:00.000Z",
            heartbeatIntervalSeconds: 10,
          });
        }
        return jsonResponse(sessionState);
      };
      const client = makeVoiceHttpClient({
        prepared: preparedConnection({ _tag: "Bearer", token: "voice-token" }),
        fetch,
      });

      const created = yield* client.createSession({
        mode: "realtime-agent",
        conversation: { type: "new", retention: "ephemeral" },
        media: {
          transports: ["webrtc-sdp-v1"],
          audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
          supportsInputRouteSelection: true,
          supportsOutputRouteSelection: true,
        },
        idempotencyKey: "create-1",
      });
      yield* client.getSession(SESSION_ID);
      yield* client.heartbeatSession(SESSION_ID, 1);
      yield* client.updateSessionFocus(SESSION_ID, 1, {
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
      });
      const answer = yield* client.offerSession({
        sessionId: SESSION_ID,
        leaseGeneration: 1,
        sdp: "offer-sdp",
      });
      const events = yield* client.sessionEvents(SESSION_ID, 4);
      const confirmation = yield* client.decideConfirmation(SESSION_ID, CONFIRMATION_ID, "approve");
      const closed = yield* client.closeSession(SESSION_ID, 1);

      expect(created.state.phase).toBe("signaling");
      expect(answer.sdp).toBe("answer-sdp");
      expect(events.state.sequence).toBe(4);
      expect(confirmation.outcome).toBe("approved");
      expect(closed.closed).toBe(true);
      expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
        "POST https://environment.example.test/api/voice/sessions",
        `GET https://environment.example.test/api/voice/sessions/${SESSION_ID}`,
        `POST https://environment.example.test/api/voice/sessions/${SESSION_ID}/heartbeat`,
        `POST https://environment.example.test/api/voice/sessions/${SESSION_ID}/focus`,
        `POST https://environment.example.test/api/voice/sessions/${SESSION_ID}/webrtc-offer`,
        `GET https://environment.example.test/api/voice/sessions/${SESSION_ID}/events?afterSequence=4&waitMilliseconds=20000`,
        `POST https://environment.example.test/api/voice/sessions/${SESSION_ID}/confirmations/${CONFIRMATION_ID}`,
        `DELETE https://environment.example.test/api/voice/sessions/${SESSION_ID}`,
      ]);
      const focusBody = requests[3]?.body;
      expect(
        focusBody instanceof Uint8Array ? new TextDecoder().decode(focusBody) : focusBody,
      ).toBe('{"leaseGeneration":1,"projectId":"project-1","threadId":"thread-1"}');
    }),
  );

  it.effect("streams fragmented NDJSON and signs the exact transcription URL with DPoP", () =>
    Effect.gen(function* () {
      const proofs: Array<{
        readonly method: string;
        readonly url: string;
        readonly accessToken?: string;
      }> = [];
      let received: { readonly url: string; readonly init: RequestInit | undefined } | undefined;
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("thumbprint"),
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed("signed-proof");
        },
      });
      const fetch: typeof globalThis.fetch = async (resource, init) => {
        received = { url: String(resource), init };
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('{"type":"delta","requestId":"request-1","text":"hel'),
              );
              controller.enqueue(
                encoder.encode(
                  'lo"}\n{"type":"final","result":{"requestId":"request-1","text":"hello"}}\n',
                ),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          },
        );
      };
      const client = makeVoiceHttpClient({
        prepared: preparedConnection({
          _tag: "Dpop",
          accessToken: "dpop-token",
        }),
        signer,
        fetch,
      });

      const events = yield* client
        .transcribe({
          audio: {
            kind: "blob",
            value: new Blob([new Uint8Array([1, 2, 3])], {
              type: "audio/wav",
            }),
            filename: "recording.wav",
          },
          metadata: { requestId: REQUEST_ID, format: "audio/wav" },
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );

      expect(events.map((event) => event.type)).toEqual(["delta", "final"]);
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://environment.example.test/api/voice/transcriptions",
          accessToken: "dpop-token",
        },
      ]);
      expect(received?.url).toBe("https://environment.example.test/api/voice/transcriptions");
      const headers = new Headers(received?.init?.headers);
      expect(headers.get("authorization")).toBe("DPoP dpop-token");
      expect(headers.get("dpop")).toBe("signed-proof");
      const body = received?.init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("metadata")).toBe(
        '{"requestId":"request-1","format":"audio/wav"}',
      );
    }),
  );

  it.effect("uses the platform URI uploader for native recordings", () =>
    Effect.gen(function* () {
      let received:
        | {
            readonly requestUrl: string;
            readonly fileUri: string;
            readonly parameters: Readonly<Record<string, string>>;
            readonly ticket: string | null;
          }
        | undefined;
      const client = makeVoiceHttpClient({
        prepared: preparedConnection({ _tag: "Bearer", token: "voice-token" }),
        fetch: async () => {
          throw new Error("The fetch transport must not handle native file URIs");
        },
        uploadUri: async (input) => {
          received = {
            requestUrl: input.requestUrl,
            fileUri: input.fileUri,
            parameters: input.parameters,
            ticket: input.headers.get("x-t3-voice-ticket"),
          };
          return {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
            body: '{"type":"final","result":{"requestId":"request-1","text":"native audio"}}\n',
          };
        },
      });

      const events = yield* client
        .transcribe({
          audio: {
            kind: "uri",
            uri: "file:///data/user/0/t3/cache/recording.m4a",
            filename: "recording.m4a",
          },
          metadata: { requestId: REQUEST_ID, format: "audio/mp4" },
          ticket: {
            ticketId: VoiceMediaTicketId.make("ticket-native-upload"),
            token: "native-upload-token",
            operation: "transcription-upload",
            expiresAt: "2026-07-10T20:01:00.000Z",
          },
        })
        .pipe(Stream.runCollect);

      expect(Array.from(events)).toHaveLength(1);
      expect(received).toEqual({
        requestUrl: "https://environment.example.test/api/voice/transcriptions",
        fileUri: "file:///data/user/0/t3/cache/recording.m4a",
        parameters: {
          metadata: '{"requestId":"request-1","format":"audio/mp4"}',
        },
        ticket: "native-upload-token",
      });
    }),
  );

  it.effect("signs the exact long-poll URL including its query string", () =>
    Effect.gen(function* () {
      const proofs: Array<{ readonly method: string; readonly url: string }> = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("thumbprint"),
        createProof: (input) => {
          proofs.push({ method: input.method, url: input.url });
          return Effect.succeed("signed-proof");
        },
      });
      const fetch: typeof globalThis.fetch = async () =>
        jsonResponse({
          state: {
            sessionId: SESSION_ID,
            conversationId: CONVERSATION_ID,
            mode: "realtime-agent",
            phase: "idle",
            leaseGeneration: 1,
            sequence: 4,
          },
          events: [],
        });
      const client = makeVoiceHttpClient({
        prepared: preparedConnection({
          _tag: "Dpop",
          accessToken: "dpop-token",
        }),
        signer,
        fetch,
      });

      yield* client.sessionEvents(SESSION_ID, 4);

      expect(proofs).toEqual([
        {
          method: "GET",
          url: `https://environment.example.test/api/voice/sessions/${SESSION_ID}/events?afterSequence=4&waitMilliseconds=20000`,
        },
      ]);
    }),
  );

  it.effect("streams PCM with a one-use media ticket and no connection credential", () =>
    Effect.gen(function* () {
      let received: RequestInit | undefined;
      const fetch: typeof globalThis.fetch = async (_resource, init) => {
        received = init;
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/pcm" },
        });
      };
      const client = makeVoiceHttpClient({
        prepared: preparedConnection({
          _tag: "Dpop",
          accessToken: "dpop-token",
        }),
        fetch,
      });

      const chunks = yield* client
        .synthesize({
          ticket: {
            ticketId: VoiceMediaTicketId.make("ticket-1"),
            token: "one-use-token",
            operation: "speech-stream",
            expiresAt: "2026-07-10T20:01:00.000Z",
          },
          request: {
            requestId: REQUEST_ID,
            playbackId: PLAYBACK_ID,
            segmentIndex: 0,
            finalSegment: true,
            text: "Hello from T3",
            preset: "default",
          },
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );

      expect(Array.from(chunks[0] ?? [])).toEqual([1, 2, 3, 4]);
      const headers = new Headers(received?.headers);
      expect(headers.get("x-t3-voice-ticket")).toBe("one-use-token");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("dpop")).toBe(false);
      expect(received?.credentials).toBeUndefined();
    }),
  );
});

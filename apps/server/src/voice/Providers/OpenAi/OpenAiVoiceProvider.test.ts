import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { VoiceError } from "../../Errors.ts";
import { VoiceCredentialStore } from "../../Services/VoiceCredentialStore.ts";
import {
  OpenAiRealtimeSocket,
  type OpenAiRealtimeSocketConnection,
  type OpenAiRealtimeSocketEvent,
} from "./OpenAiRealtimeSocket.ts";
import { __testing } from "./OpenAiVoiceProvider.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

const credentialStore = (key: Option.Option<string>) =>
  VoiceCredentialStore.of({
    status: Effect.succeed({ configured: Option.isSome(key), updatedAt: null }),
    getOpenAiApiKey: Effect.succeed(key),
    setOpenAiApiKey: () => Effect.die("unused"),
    clearOpenAiApiKey: Effect.die("unused"),
  });

const realtimeSocket = (
  events: ReadonlyArray<OpenAiRealtimeSocketEvent> = [],
  sent: Array<string> = [],
  onClose: () => void = () => undefined,
) =>
  OpenAiRealtimeSocket.of({
    connect: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(onClose));
        const eventQueue = yield* Queue.unbounded<OpenAiRealtimeSocketEvent>();
        yield* Effect.forEach(events, (event) => Queue.offer(eventQueue, event));
        return {
          events: Stream.fromQueue(eventQueue).pipe(
            Stream.takeUntil((event) => event.type === "closed"),
          ),
          receive: Queue.take(eventQueue),
          send: (data) => Effect.sync(() => sent.push(data)).pipe(Effect.asVoid),
          close: Effect.sync(onClose),
        } satisfies OpenAiRealtimeSocketConnection;
      }),
  });

it.effect("normalizes OpenAI transcription SSE without exposing provider events", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      });
      const body = [
        'event: transcript.text.delta\ndata: {"type":"transcript.text.delta","delta":"hello "}\n\n',
        'event: transcript.text.done\ndata: {"type":"transcript.text.done","text":"hello world"}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ),
      );
    });
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("sk-test"))),
      Effect.provideService(OpenAiRealtimeSocket, realtimeSocket()),
    );
    const events = yield* provider
      .transcriber!.transcribe({
        requestId: "voice-request-1" as never,
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "audio/wav",
      })
      .pipe(Stream.runCollect);

    expect(Array.from(events)).toEqual([
      { type: "delta", requestId: "voice-request-1", text: "hello " },
      {
        type: "final",
        result: { requestId: "voice-request-1", text: "hello world" },
      },
    ]);
    expect(requests).toEqual([
      {
        url: "https://api.openai.com/v1/audio/transcriptions",
        authorization: "Bearer sk-test",
      },
    ]);
  }),
);

it.effect("streams PCM speech bytes and maps the server-owned voice preset", () =>
  Effect.gen(function* () {
    let requestBody = "";
    const httpClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          requestBody = new TextDecoder().decode(request.body.body);
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "content-type": "audio/pcm" },
          }),
        );
      }),
    );
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("sk-test"))),
      Effect.provideService(OpenAiRealtimeSocket, realtimeSocket()),
    );
    const bytes = yield* provider
      .speechSynthesizer!.synthesize({
        requestId: "voice-request-2" as never,
        playbackId: "voice-playback-1",
        segmentIndex: 0,
        finalSegment: true,
        text: "Hello world",
        preset: "default",
      })
      .pipe(Stream.runCollect);

    expect(Array.from(bytes).flatMap((chunk) => Array.from(chunk))).toEqual([1, 2, 3, 4]);
    const decodedRequestBody = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
      requestBody,
    );
    expect(decodedRequestBody).toMatchObject({
      model: __testing.speechModel,
      voice: "marin",
      input: "Hello world",
      response_format: "pcm",
    });
  }),
);

it.effect("fails before HTTP when the server credential is absent", () =>
  Effect.gen(function* () {
    const provider = yield* __testing.make.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("HTTP must not be called")),
      ),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.none())),
      Effect.provideService(OpenAiRealtimeSocket, realtimeSocket()),
    );
    const error = yield* provider
      .speechSynthesizer!.synthesize({
        requestId: "voice-request-3" as never,
        playbackId: "voice-playback-2",
        segmentIndex: 0,
        finalSegment: true,
        text: "Hello",
        preset: "default",
      })
      .pipe(Stream.runDrain, Effect.flip);

    expect(error.reason).toBe("not-configured");
  }),
);

it.effect("negotiates unified WebRTC, attaches sideband, and normalizes Realtime events", () =>
  Effect.gen(function* () {
    const httpRequests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    let sessionConfig: unknown;
    let offerSdp = "";
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        httpRequests.push({
          url: request.url,
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
        });
        if (request.url.endsWith("/v1/realtime/calls")) {
          expect(request.body._tag).toBe("FormData");
          if (request.body._tag === "FormData") {
            const formData = request.body.formData;
            offerSdp = formData.get("sdp") as string;
            sessionConfig = decodeJson(formData.get("session") as string);
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response("answer-sdp", {
              status: 201,
              headers: { location: "/v1/realtime/calls/rtc_test" },
            }),
          );
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    );
    const sent: Array<string> = [];
    let closed = 0;
    const socketConnections: Array<{ readonly url: string; readonly apiKey: string }> = [];
    const socket = OpenAiRealtimeSocket.of({
      connect: (input) =>
        Effect.gen(function* () {
          socketConnections.push(input);
          yield* Effect.addFinalizer(() => Effect.sync(() => closed++));
          const eventQueue = yield* Queue.unbounded<OpenAiRealtimeSocketEvent>();
          yield* Effect.forEach(
            [
              {
                type: "message",
                data: encodeJson({
                  event_id: "server-replay-1",
                  type: "conversation.item.created",
                  item: { id: "t3_replay_item_voice-session-1_3_0" },
                }),
              },
              {
                type: "message",
                data: encodeJson({
                  event_id: "server-replay-2",
                  type: "conversation.item.created",
                  item: { id: "t3_replay_item_voice-session-1_3_1" },
                }),
              },
              {
                type: "message",
                data: encodeJson({
                  type: "conversation.item.input_audio_transcription.completed",
                  transcript: "show my threads",
                }),
              },
              {
                type: "message",
                data: encodeJson({
                  type: "response.done",
                  response: {
                    output: [
                      {
                        type: "function_call",
                        status: "completed",
                        call_id: "call_tools_1",
                        name: "list_threads",
                        arguments: '{"projectId":"project-1","limit":10}',
                      },
                    ],
                  },
                }),
              },
              { type: "closed", code: 1000, reason: "done" },
            ] satisfies ReadonlyArray<OpenAiRealtimeSocketEvent>,
            (event) => Queue.offer(eventQueue, event),
          );
          return {
            events: Stream.fromQueue(eventQueue).pipe(
              Stream.takeUntil((event) => event.type === "closed"),
            ),
            receive: Queue.take(eventQueue),
            send: (data: string) => Effect.sync(() => sent.push(data)).pipe(Effect.asVoid),
            close: Effect.void,
          } satisfies OpenAiRealtimeSocketConnection;
        }),
    });
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("sk-test"))),
      Effect.provideService(OpenAiRealtimeSocket, socket),
    );
    const session = yield* provider.realtime!.negotiate({
      sessionId: "voice-session-1" as never,
      leaseGeneration: 3,
      offer: {
        sessionId: "voice-session-1" as never,
        leaseGeneration: 3,
        sdp: "offer-sdp",
      },
      instructions: "Control T3 threads.",
      continuationContext: [
        { role: "system", text: "Previous work was in project one." },
        { role: "assistant", text: "I found the project." },
      ],
    });
    const events = Array.from(yield* session.events.pipe(Stream.runCollect));

    expect(session.answer).toEqual({
      sessionId: "voice-session-1",
      leaseGeneration: 3,
      sdp: "answer-sdp",
    });
    expect(offerSdp).toBe("offer-sdp");
    expect(sessionConfig).toMatchObject({
      type: "realtime",
      model: __testing.realtimeModel,
      truncation: "disabled",
      tool_choice: "auto",
      audio: {
        input: {
          transcription: { model: __testing.transcriptionModel },
        },
      },
    });
    expect(socketConnections).toEqual([
      {
        url: "wss://api.openai.com/v1/realtime?call_id=rtc_test",
        apiKey: "sk-test",
      },
    ]);
    expect(sent.map((message) => decodeJson(message))).toEqual([
      {
        type: "conversation.item.create",
        event_id: "t3_replay_event_voice-session-1_3_0",
        item: {
          id: "t3_replay_item_voice-session-1_3_0",
          type: "message",
          role: "system",
          status: "completed",
          content: [{ type: "input_text", text: "Previous work was in project one." }],
        },
      },
      {
        type: "conversation.item.create",
        event_id: "t3_replay_event_voice-session-1_3_1",
        item: {
          id: "t3_replay_item_voice-session-1_3_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "I found the project." }],
        },
      },
    ]);
    expect(events).toEqual([
      { type: "transcript", role: "user", text: "show my threads", final: true },
      {
        type: "function-call",
        providerFunctionCallId: "call_tools_1",
        name: "list_threads",
        argumentsJson: '{"projectId":"project-1","limit":10}',
      },
      { type: "activity", activity: "idle" },
      { type: "closed" },
    ]);

    yield* session.submitToolOutput({
      providerFunctionCallId: "call_tools_1",
      output: '{"threads":[]}',
    });
    yield* session.submitToolOutput({
      providerFunctionCallId: "call_tools_1",
      output: '{"threads":[]}',
    });
    expect(sent.slice(2).map((message) => decodeJson(message))).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_tools_1",
          output: '{"threads":[]}',
        },
      },
      { type: "response.create" },
    ]);

    yield* session.terminate;
    yield* session.terminate;
    expect(httpRequests).toEqual([
      { url: "https://api.openai.com/v1/realtime/calls", authorization: "Bearer sk-test" },
      {
        url: "https://api.openai.com/v1/realtime/calls/rtc_test/hangup",
        authorization: "Bearer sk-test",
      },
    ]);
    expect(closed).toBe(1);
  }),
);

it.effect("hangs up the provider call when sideband attachment fails", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/hangup")
            ? new Response(null, { status: 200 })
            : new Response("answer-sdp", {
                status: 201,
                headers: { location: "/v1/realtime/calls/rtc_failed" },
              }),
        ),
      );
    });
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("sk-test"))),
      Effect.provideService(
        OpenAiRealtimeSocket,
        OpenAiRealtimeSocket.of({
          connect: () =>
            Effect.fail(
              new VoiceError({
                reason: "provider-unavailable",
                operation: "test.sideband",
                detail: "failed",
                retryable: true,
              }),
            ),
        }),
      ),
    );
    const error = yield* provider
      .realtime!.negotiate({
        sessionId: "voice-session-failed" as never,
        leaseGeneration: 1,
        offer: {
          sessionId: "voice-session-failed" as never,
          leaseGeneration: 1,
          sdp: "offer-sdp",
        },
        instructions: "test",
        continuationContext: [],
      })
      .pipe(Effect.flip);

    expect(error.operation).toBe("test.sideband");
    expect(requests).toEqual([
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls/rtc_failed/hangup",
    ]);
  }),
);

it.effect("rejects startup and hangs up when OpenAI rejects a replay item", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/hangup")
            ? new Response(null, { status: 200 })
            : new Response("answer-sdp", {
                status: 201,
                headers: { location: "/v1/realtime/calls/rtc_replay_rejected" },
              }),
        ),
      );
    });
    const sent: Array<string> = [];
    let closed = 0;
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("sk-test"))),
      Effect.provideService(
        OpenAiRealtimeSocket,
        realtimeSocket(
          [
            {
              type: "message",
              data: encodeJson({
                type: "error",
                error: {
                  event_id: "t3_replay_event_voice-session-rejected_1_0",
                  message: "item rejected",
                },
              }),
            },
          ],
          sent,
          () => closed++,
        ),
      ),
    );
    const error = yield* provider
      .realtime!.negotiate({
        sessionId: "voice-session-rejected" as never,
        leaseGeneration: 1,
        offer: {
          sessionId: "voice-session-rejected" as never,
          leaseGeneration: 1,
          sdp: "offer-sdp",
        },
        instructions: "test",
        continuationContext: [{ role: "user", text: "My code word is heliotrope." }],
      })
      .pipe(Effect.flip);

    expect(error.operation).toBe("openai.realtime.context-replay");
    expect(error.detail).toBe("OpenAI rejected a context replay item");
    expect(sent.map((message) => decodeJson(message))).toMatchObject([
      {
        type: "conversation.item.create",
        event_id: "t3_replay_event_voice-session-rejected_1_0",
        item: { id: "t3_replay_item_voice-session-rejected_1_0" },
      },
    ]);
    expect(requests).toEqual([
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls/rtc_replay_rejected/hangup",
    ]);
    expect(closed).toBe(1);
  }),
);

it.effect("rejects startup when the sideband closes before every replay item is acknowledged", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/hangup")
            ? new Response(null, { status: 200 })
            : new Response("answer-sdp", {
                status: 201,
                headers: { location: "/v1/realtime/calls/rtc_replay_incomplete" },
              }),
        ),
      );
    });
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("sk-test"))),
      Effect.provideService(
        OpenAiRealtimeSocket,
        realtimeSocket([
          {
            type: "message",
            data: encodeJson({
              type: "conversation.item.created",
              item: { id: "t3_replay_item_voice-session-incomplete_1_0" },
            }),
          },
          { type: "closed", code: 1006, reason: "connection lost" },
        ]),
      ),
    );
    const error = yield* provider
      .realtime!.negotiate({
        sessionId: "voice-session-incomplete" as never,
        leaseGeneration: 1,
        offer: {
          sessionId: "voice-session-incomplete" as never,
          leaseGeneration: 1,
          sdp: "offer-sdp",
        },
        instructions: "test",
        continuationContext: [
          { role: "user", text: "My code word is heliotrope." },
          { role: "assistant", text: "I will remember that." },
        ],
      })
      .pipe(Effect.flip);

    expect(error.operation).toBe("openai.realtime.context-replay");
    expect(error.detail).toBe("OpenAI Realtime closed before context replay completed");
    expect(requests).toEqual([
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls/rtc_replay_incomplete/hangup",
    ]);
  }),
);

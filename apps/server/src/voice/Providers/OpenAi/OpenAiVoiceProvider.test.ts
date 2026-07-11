import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

it("normalizes stable semantic transcript identities and rejects unidentified finals", () => {
  const parse = (value: unknown) =>
    __testing.parseRealtimeEvent({ type: "message", data: encodeJson(value) });

  const assistant = {
    type: "response.output_audio_transcript.done",
    event_id: "envelope-one",
    response_id: "response-one",
    item_id: "assistant-item-one",
    output_index: 0,
    content_index: 1,
    transcript: "Done.",
  };
  expect(parse(assistant)).toEqual([
    {
      type: "transcript",
      role: "assistant",
      text: "Done.",
      final: true,
      sourceId: "output:assistant-item-one:1",
    },
  ]);
  expect(parse({ ...assistant, event_id: "duplicate-envelope" })).toEqual(parse(assistant));
  expect(
    parse({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "No identity",
    }),
  ).toEqual([
    {
      type: "error",
      detail: "OpenAI sent a final input transcript without a stable identity",
      recoverable: false,
    },
  ]);
  expect(
    parse({ type: "conversation.item.input_audio_transcription.completed", transcript: "" }),
  ).toEqual([]);
  expect(parse({ type: "response.output_audio_transcript.done", transcript: "" })).toEqual([]);
});

it("reports provider failures without logging provider messages or transcript content", () => {
  const privateMessage = "context overflow after private transcript content";
  const providerErrorDiagnostic = __testing.realtimeDiagnostic({
    type: "message",
    data: encodeJson({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        param: "session.truncation",
        event_id: "event_123",
        message: privateMessage,
      },
    }),
  });
  expect(providerErrorDiagnostic).toEqual({
    message: "OpenAI Realtime provider error",
    annotations: {
      providerErrorType: "invalid_request_error",
      providerErrorCode: "context_length_exceeded",
      providerErrorParam: "session.truncation",
      providerEventId: "event_123",
      providerMessagePresent: true,
    },
  });
  expect(JSON.stringify(providerErrorDiagnostic)).not.toContain(privateMessage);
  expect(
    __testing.parseRealtimeEvent({
      type: "message",
      data: encodeJson({ type: "error", error: { message: privateMessage } }),
    }),
  ).toEqual([{ type: "error", detail: "OpenAI Realtime reported an error", recoverable: false }]);
  expect(
    __testing.realtimeDiagnostic({ type: "closed", code: 1009, reason: privateMessage }),
  ).toEqual({
    message: "OpenAI Realtime sideband closed",
    annotations: {
      closeCode: 1009,
      closeReason: "provider-supplied",
      closeReasonLength: privateMessage.length,
    },
  });
});

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
                  type: "conversation.item.added",
                  item: { id: "t3ctx_3_0" },
                }),
              },
              {
                type: "message",
                data: encodeJson({
                  event_id: "server-replay-2",
                  type: "conversation.item.done",
                  item: { id: "t3ctx_3_0" },
                }),
              },
              {
                type: "message",
                data: encodeJson({
                  event_id: "server-replay-3",
                  type: "conversation.item.added",
                  item: { id: "t3ctx_3_1" },
                }),
              },
              {
                type: "message",
                data: encodeJson({
                  event_id: "server-replay-4",
                  type: "conversation.item.done",
                  item: { id: "t3ctx_3_1" },
                }),
              },
              {
                type: "message",
                data: encodeJson({
                  type: "conversation.item.input_audio_transcription.completed",
                  item_id: "input-item-1",
                  content_index: 0,
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
    const configuredTools = (
      sessionConfig as {
        readonly tools: ReadonlyArray<{
          readonly name: string;
          readonly parameters: Record<string, unknown>;
        }>;
      }
    ).tools;
    expect(configuredTools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "list_threads",
      "get_thread_status",
      "interrupt_thread",
      "archive_thread",
      "get_thread_messages",
      "wait_for_thread_turn",
      "search_history",
      "read_history",
      "create_thread",
      "send_thread_message",
    ]);
    expect(
      configuredTools.find((tool) => tool.name === "search_history")?.parameters,
    ).toMatchObject({
      required: ["query", "sources", "limit"],
      additionalProperties: false,
      properties: {
        query: { maxLength: 512 },
        sources: { maxItems: 2, uniqueItems: true },
        limit: { maximum: 20 },
      },
    });
    const readHistoryParameters = configuredTools.find((tool) => tool.name === "read_history")
      ?.parameters as {
      readonly anyOf: ReadonlyArray<{
        readonly required: ReadonlyArray<string>;
        readonly additionalProperties: boolean;
        readonly properties: Record<string, unknown>;
      }>;
    };
    expect(readHistoryParameters.anyOf).toHaveLength(2);
    expect(readHistoryParameters.anyOf[0]).toMatchObject({
      required: ["ref", "before", "after"],
      additionalProperties: false,
      properties: {
        ref: { required: ["type", "projectId", "threadId", "messageId"] },
        before: { maximum: 10 },
        after: { maximum: 10 },
      },
    });
    expect(readHistoryParameters.anyOf[1]).toMatchObject({
      required: ["ref", "voiceScope", "before", "after"],
      additionalProperties: false,
      properties: {
        ref: { required: ["type", "conversationId", "entryId"] },
        voiceScope: {
          oneOf: expect.arrayContaining([
            expect.objectContaining({ required: ["type", "conversationId"] }),
          ]),
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
          id: "t3ctx_3_0",
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
          id: "t3ctx_3_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "I found the project." }],
        },
      },
    ]);
    expect(events).toEqual([
      {
        type: "transcript",
        role: "user",
        text: "show my threads",
        final: true,
        sourceId: "input:input-item-1:0",
      },
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

it.effect("coalesces parallel tool outputs into one continuation in either completion order", () =>
  Effect.gen(function* () {
    for (const completionOrder of [
      ["call_tools_1", "call_tools_2"],
      ["call_tools_2", "call_tools_1"],
    ] as const) {
      const sent: Array<string> = [];
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/hangup")
              ? new Response(null, { status: 200 })
              : new Response("answer-sdp", {
                  status: 201,
                  headers: { location: "/v1/realtime/calls/rtc_parallel_tools" },
                }),
          ),
        ),
      );
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
                  type: "response.done",
                  response: {
                    output: [
                      {
                        type: "function_call",
                        status: "completed",
                        call_id: "call_tools_1",
                        name: "search_history",
                        arguments: "{}",
                      },
                      {
                        type: "function_call",
                        status: "completed",
                        call_id: "call_tools_2",
                        name: "wait_for_thread_turn",
                        arguments: "{}",
                      },
                    ],
                  },
                }),
              },
              { type: "closed", code: 1000, reason: "done" },
            ],
            sent,
          ),
        ),
      );
      const session = yield* provider.realtime!.negotiate({
        sessionId: "voice-session-parallel-tools" as never,
        leaseGeneration: 1,
        offer: {
          sessionId: "voice-session-parallel-tools" as never,
          leaseGeneration: 1,
          sdp: "offer-sdp",
        },
        instructions: "test",
        continuationContext: [],
      });
      yield* session.events.pipe(Stream.runDrain);

      for (const providerFunctionCallId of completionOrder) {
        yield* session.submitToolOutput({
          providerFunctionCallId,
          output: `{"callId":"${providerFunctionCallId}"}`,
        });
      }

      expect(sent.map((message) => decodeJson(message))).toEqual([
        ...completionOrder.map((providerFunctionCallId) => ({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: providerFunctionCallId,
            output: `{"callId":"${providerFunctionCallId}"}`,
          },
        })),
        { type: "response.create" },
      ]);
      yield* session.terminate;
    }
  }),
);

it.effect("does not track malformed completed function calls as pending continuations", () =>
  Effect.gen(function* () {
    const sent: Array<string> = [];
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/hangup")
            ? new Response(null, { status: 200 })
            : new Response("answer-sdp", {
                status: 201,
                headers: { location: "/v1/realtime/calls/rtc_malformed_tool" },
              }),
        ),
      ),
    );
    const responseDone = (output: ReadonlyArray<unknown>): OpenAiRealtimeSocketEvent => ({
      type: "message",
      data: encodeJson({ type: "response.done", response: { output } }),
    });
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("sk-test"))),
      Effect.provideService(
        OpenAiRealtimeSocket,
        realtimeSocket(
          [
            responseDone([
              {
                type: "function_call",
                status: "completed",
                call_id: "call_malformed",
              },
            ]),
            responseDone([
              {
                type: "function_call",
                status: "completed",
                call_id: "call_valid",
                name: "search_history",
                arguments: "{}",
              },
            ]),
            { type: "closed", code: 1000, reason: "done" },
          ],
          sent,
        ),
      ),
    );
    const session = yield* provider.realtime!.negotiate({
      sessionId: "voice-session-malformed-tool" as never,
      leaseGeneration: 1,
      offer: {
        sessionId: "voice-session-malformed-tool" as never,
        leaseGeneration: 1,
        sdp: "offer-sdp",
      },
      instructions: "test",
      continuationContext: [],
    });
    yield* session.events.pipe(Stream.runDrain);
    yield* session.submitToolOutput({
      providerFunctionCallId: "call_valid",
      output: "{}",
    });

    expect(sent.map((message) => decodeJson(message))).toEqual([
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call_valid", output: "{}" },
      },
      { type: "response.create" },
    ]);
    yield* session.terminate;
  }),
);

it.effect("waits for an acknowledged live context update on the sideband event stream", () =>
  Effect.gen(function* () {
    const queueReady = yield* Deferred.make<Queue.Queue<OpenAiRealtimeSocketEvent>>();
    const updateSent = yield* Deferred.make<void>();
    const sent: Array<string> = [];
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/hangup")
            ? new Response(null, { status: 200 })
            : new Response("answer-sdp", {
                status: 201,
                headers: { location: "/v1/realtime/calls/rtc_focus_update" },
              }),
        ),
      ),
    );
    const socket = OpenAiRealtimeSocket.of({
      connect: () =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<OpenAiRealtimeSocketEvent>();
          yield* Deferred.succeed(queueReady, queue);
          return {
            events: Stream.fromQueue(queue),
            receive: Queue.take(queue),
            send: (data: string) =>
              Effect.sync(() => sent.push(data)).pipe(
                Effect.andThen(Deferred.succeed(updateSent, undefined)),
                Effect.asVoid,
              ),
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
      sessionId: "voice-session-focus" as never,
      leaseGeneration: 4,
      offer: {
        sessionId: "voice-session-focus" as never,
        leaseGeneration: 4,
        sdp: "offer-sdp",
      },
      instructions: "test",
      continuationContext: [],
    });
    const eventFiber = yield* session.events.pipe(Stream.runDrain, Effect.forkScoped);
    const updating = yield* session
      .updateContext({ role: "system", text: "Active T3 context: project p, thread t" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(updateSent);
    const updateEvent = decodeJson(sent[0]!) as {
      readonly event_id: string;
      readonly item: { readonly id: string };
    };
    expect(updateEvent.event_id.length).toBeLessThanOrEqual(32);
    expect(updateEvent.item.id.length).toBeLessThanOrEqual(32);
    const queue = yield* Deferred.await(queueReady);
    yield* Queue.offer(queue, {
      type: "message",
      data: encodeJson({
        type: "conversation.item.done",
        item: { id: updateEvent.item.id },
      }),
    });
    yield* Fiber.join(updating);
    yield* Fiber.interrupt(eventFiber);
    yield* session.terminate;
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
        item: { id: "t3ctx_1_0" },
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
              type: "conversation.item.done",
              item: { id: "t3ctx_1_0" },
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

import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
    parse({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "",
    }),
  ).toEqual([]);
  expect(parse({ type: "response.output_audio_transcript.done", transcript: "" })).toEqual([]);
  expect(parse({ ...assistant, transcript: "  Done.  " })).toEqual([
    {
      type: "transcript",
      role: "assistant",
      text: "Done.",
      final: true,
      sourceId: "output:assistant-item-one:1",
    },
  ]);
  expect(parse({ ...assistant, transcript: "   " })).toEqual([]);
  const user = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user-item-one",
    content_index: 0,
    transcript: "  Question?  ",
  };
  expect(parse(user)).toEqual([
    {
      type: "transcript",
      role: "user",
      text: "Question?",
      final: true,
      sourceId: "input:user-item-one:0",
    },
  ]);
  expect(parse({ ...user, transcript: "\t\n" })).toEqual([]);
  expect(
    parse({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: " ",
    }),
  ).toEqual([]);
  expect(parse({ type: "response.output_audio_transcript.done", transcript: " " })).toEqual([]);
});

it("preserves whitespace in partial Realtime transcript deltas", () => {
  const parse = (value: unknown) =>
    __testing.parseRealtimeEvent({ type: "message", data: encodeJson(value) });

  expect(parse({ type: "response.output_audio_transcript.delta", delta: " " })).toEqual([
    { type: "transcript", role: "assistant", text: " ", final: false },
  ]);
  expect(
    parse({
      type: "conversation.item.input_audio_transcription.delta",
      delta: " next",
    }),
  ).toEqual([{ type: "transcript", role: "user", text: " next", final: false }]);
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
      providerMessagePresent: true,
    },
  });
  expect(JSON.stringify(providerErrorDiagnostic)).not.toContain(privateMessage);
  expect(JSON.stringify(providerErrorDiagnostic)).not.toContain("event_123");
  expect(
    __testing.parseRealtimeEvent({
      type: "message",
      data: encodeJson({ type: "error", error: { message: privateMessage } }),
    }),
  ).toEqual([
    {
      type: "error",
      detail: "OpenAI Realtime reported an error",
      recoverable: false,
    },
  ]);
  expect(
    __testing.realtimeDiagnostic(
      { type: "closed", code: 1009, reason: privateMessage },
      { sessionId: "voice-session-sensitive", leaseGeneration: 7 },
    ),
  ).toEqual({
    message: "OpenAI Realtime sideband closed",
    annotations: {
      sessionId: "voice-session-sensitive",
      leaseGeneration: 7,
      closeCode: 1009,
      closeReason: "provider-supplied",
      closeReasonLength: privateMessage.length,
    },
  });
  expect(
    JSON.stringify(
      __testing.realtimeDiagnostic(
        { type: "closed", code: 1009, reason: privateMessage },
        { sessionId: "voice-session-sensitive", leaseGeneration: 7 },
      ),
    ),
  ).not.toContain(privateMessage);
  const privateName = new Error("safe message");
  privateName.name = privateMessage;
  const transportDiagnostic = __testing.realtimeDiagnostic(
    { type: "error", cause: privateName },
    { sessionId: "voice-session-sensitive", leaseGeneration: 7 },
  );
  expect(transportDiagnostic).toMatchObject({
    annotations: { causeType: "error-object" },
  });
  expect(JSON.stringify(transportDiagnostic)).not.toContain(privateMessage);
});

it("distinguishes normal and abnormal Realtime sideband closes", () => {
  for (const code of [1000, 1001, 1005]) {
    expect(__testing.parseRealtimeEvent({ type: "closed", code, reason: "done" })).toEqual([
      { type: "closed" },
    ]);
  }
  expect(
    __testing.parseRealtimeEvent({
      type: "closed",
      code: 1006,
      reason: "private provider failure reason",
    }),
  ).toEqual([
    {
      type: "error",
      detail: "OpenAI Realtime sideband closed unexpectedly",
      recoverable: false,
    },
  ]);
});

const credentialStore = (key: Option.Option<string>) =>
  VoiceCredentialStore.of({
    listStatus: Effect.succeed({
      credentials: [
        { providerId: "openai", configured: Option.isSome(key), updatedAt: null },
        { providerId: "openai-speech-server", configured: false, updatedAt: null },
      ],
    }),
    status: (providerId) =>
      Effect.succeed({
        providerId,
        configured: providerId === "openai" && Option.isSome(key),
        updatedAt: null,
      }),
    get: (providerId) => Effect.succeed(providerId === "openai" ? key : Option.none()),
    set: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
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
    const requests: Array<{
      readonly url: string;
      readonly authorization?: string;
    }> = [];
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
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
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
    const body = yield* provider.speechSynthesizer!.prepare({
      requestId: "voice-request-2" as never,
      playbackId: "voice-playback-1",
      segmentIndex: 0,
      finalSegment: true,
      text: "Hello world",
      preset: "default",
    });
    const bytes = yield* body.pipe(Stream.runCollect);

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
      .speechSynthesizer!.prepare({
        requestId: "voice-request-3" as never,
        playbackId: "voice-playback-2",
        segmentIndex: 0,
        finalSegment: true,
        text: "Hello",
        preset: "default",
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("not-configured");
  }),
);

it.effect("negotiates unified WebRTC, attaches sideband, and normalizes Realtime events", () =>
  Effect.gen(function* () {
    const httpRequests: Array<{
      readonly url: string;
      readonly authorization?: string;
    }> = [];
    let sessionConfig: unknown;
    let offerSdp = "";
    let negotiationAttempts = 0;
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        httpRequests.push({
          url: request.url,
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
        });
        if (request.url.endsWith("/v1/realtime/calls")) {
          negotiationAttempts += 1;
          if (negotiationAttempts === 1) {
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 504 }));
          }
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
    const socketConnections: Array<{
      readonly url: string;
      readonly apiKey: string;
    }> = [];
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
      terminalActions: new Set(),
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
          readonly description: string;
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
      "activate_thread",
      "create_thread",
      "send_thread_message",
    ]);
    expect(configuredTools.find((tool) => tool.name === "create_thread")?.description).toContain(
      "does not mean downstream initialization is complete",
    );
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
      readonly type: string;
      readonly required: ReadonlyArray<string>;
      readonly additionalProperties: boolean;
      readonly properties: {
        readonly ref: {
          readonly oneOf: ReadonlyArray<Record<string, unknown>>;
        };
        readonly voiceScope: {
          readonly oneOf: ReadonlyArray<Record<string, unknown>>;
        };
        readonly before: Record<string, unknown>;
        readonly after: Record<string, unknown>;
      };
    };
    expect(readHistoryParameters).toMatchObject({
      type: "object",
      required: ["ref", "before", "after"],
      additionalProperties: false,
    });
    expect(readHistoryParameters).not.toHaveProperty("anyOf");
    expect(readHistoryParameters.properties.ref.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          required: ["type", "projectId", "threadId", "messageId"],
        }),
        expect.objectContaining({
          required: ["type", "conversationId", "entryId"],
        }),
      ]),
    );
    expect(readHistoryParameters.properties.voiceScope.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ["type"] }),
        expect.objectContaining({ required: ["type", "conversationId"] }),
      ]),
    );
    expect(readHistoryParameters.properties).toMatchObject({
      before: { maximum: 10 },
      after: { maximum: 10 },
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
      {
        url: "https://api.openai.com/v1/realtime/calls",
        authorization: "Bearer sk-test",
      },
      {
        url: "https://api.openai.com/v1/realtime/calls",
        authorization: "Bearer sk-test",
      },
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
                  headers: {
                    location: "/v1/realtime/calls/rtc_parallel_tools",
                  },
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
        terminalActions: new Set(),
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
                headers: {
                  location: "/v1/realtime/calls/rtc_malformed_tool",
                },
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
      terminalActions: new Set(),
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
        item: {
          type: "function_call_output",
          call_id: "call_valid",
          output: "{}",
        },
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
      terminalActions: new Set(),
      continuationContext: [],
    });
    const eventFiber = yield* session.events.pipe(Stream.runDrain, Effect.forkScoped);
    const updating = yield* session
      .updateContext({
        role: "system",
        text: "Active T3 context: project p, thread t",
      })
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

it("exposes only the terminal tools advertised for negotiation", () => {
  const names = (actions: ReadonlySet<"stop-realtime" | "switch-to-thread">) =>
    __testing
      .providerSessionConfig("test", actions)
      .tools.map((tool) => tool.name)
      .filter((name) => name === "stop_realtime_voice" || name === "switch_to_thread_voice");

  expect(names(new Set())).toEqual([]);
  expect(names(new Set(["stop-realtime"]))).toEqual(["stop_realtime_voice"]);
  expect(names(new Set(["switch-to-thread"]))).toEqual(["switch_to_thread_voice"]);
  expect(names(new Set(["stop-realtime", "switch-to-thread"]))).toEqual([
    "stop_realtime_voice",
    "switch_to_thread_voice",
  ]);
  expect(
    __testing
      .providerSessionConfig("test", new Set(["switch-to-thread"]))
      .tools.find((tool) => tool.name === "switch_to_thread_voice"),
  ).toMatchObject({
    parameters: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
  });
  expect(__testing.providerSessionConfig("test", new Set()).parallel_tool_calls).toBe(false);
});

it.effect(
  "updates terminal tools dynamically and completes a terminal call without another response",
  () =>
    Effect.gen(function* () {
      const queueReady = yield* Deferred.make<Queue.Queue<OpenAiRealtimeSocketEvent>>();
      const firstUpdateSent = yield* Deferred.make<void>();
      const secondUpdateSent = yield* Deferred.make<void>();
      const terminalOutputSent = yield* Deferred.make<void>();
      const sent: Array<string> = [];
      let updateCount = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/hangup")
              ? new Response(null, { status: 200 })
              : new Response("answer-sdp", {
                  status: 201,
                  headers: { location: "/v1/realtime/calls/rtc_terminal_tools" },
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
                Effect.gen(function* () {
                  sent.push(data);
                  const message = decodeJson(data) as { readonly type?: string };
                  if (message.type === "session.update") {
                    updateCount += 1;
                    yield* Deferred.succeed(
                      updateCount === 1 ? firstUpdateSent : secondUpdateSent,
                      undefined,
                    );
                  }
                  if (message.type === "conversation.item.create") {
                    yield* Deferred.succeed(terminalOutputSent, undefined);
                  }
                }),
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
        sessionId: "voice-session-terminal-tools" as never,
        leaseGeneration: 2,
        offer: {
          sessionId: "voice-session-terminal-tools" as never,
          leaseGeneration: 2,
          sdp: "offer-sdp",
        },
        instructions: "test",
        terminalActions: new Set(["stop-realtime"]),
        continuationContext: [],
      });
      const eventFiber = yield* session.events.pipe(Stream.runDrain, Effect.forkScoped);
      const queue = yield* Deferred.await(queueReady);

      const adding = yield* session
        .updateTerminalActions(new Set(["stop-realtime", "switch-to-thread"]))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstUpdateSent);
      yield* Queue.offer(queue, {
        type: "message",
        data: encodeJson({ type: "response.done", response: { output: [] } }),
      });
      yield* Queue.offer(queue, {
        type: "message",
        data: encodeJson({ type: "session.updated", session: { type: "realtime" } }),
      });
      yield* Fiber.join(adding);

      const removing = yield* session
        .updateTerminalActions(new Set(["stop-realtime"]))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(secondUpdateSent);
      yield* Queue.offer(queue, {
        type: "message",
        data: encodeJson({ type: "session.updated", session: { type: "realtime" } }),
      });
      yield* Fiber.join(removing);

      const terminalOutput = {
        providerFunctionCallId: "call-terminal-stop",
        output: '{"status":"accepted"}',
        itemId: "t3t_terminal_stop_item",
      };
      const completing = yield* session
        .completeTerminalToolCall(terminalOutput)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(terminalOutputSent);
      yield* Queue.offer(queue, {
        type: "message",
        data: encodeJson({
          type: "conversation.item.done",
          item: { id: terminalOutput.itemId },
        }),
      });
      yield* Fiber.join(completing);
      yield* session.completeTerminalToolCall(terminalOutput);

      const differentTerminal = yield* session
        .completeTerminalToolCall({ ...terminalOutput, itemId: "different-terminal-item" })
        .pipe(Effect.flip);
      expect(differentTerminal.detail).toContain("different terminal tool output");
      const lateUpdate = yield* session
        .updateTerminalActions(new Set(["stop-realtime", "switch-to-thread"]))
        .pipe(Effect.flip);
      expect(lateUpdate.detail).toContain("already accepted a terminal tool output");

      const messages = sent.map((message) => decodeJson(message)) as ReadonlyArray<{
        readonly type?: string;
        readonly session?: {
          readonly tools?: ReadonlyArray<{ readonly name?: string }>;
          readonly parallel_tool_calls?: boolean;
        };
      }>;
      expect(
        messages
          .filter((message) => message.type === "session.update")
          .map((message) =>
            message.session?.tools
              ?.map((tool) => tool.name)
              .filter(
                (name) => name === "stop_realtime_voice" || name === "switch_to_thread_voice",
              ),
          ),
      ).toEqual([["stop_realtime_voice", "switch_to_thread_voice"], ["stop_realtime_voice"]]);
      expect(
        messages
          .filter((message) => message.type === "session.update")
          .every((message) => message.session?.parallel_tool_calls === false),
      ).toBe(true);
      expect(messages.filter((message) => message.type === "conversation.item.create")).toEqual([
        {
          type: "conversation.item.create",
          event_id: `t3_terminal_output_${terminalOutput.itemId}`,
          item: {
            id: terminalOutput.itemId,
            type: "function_call_output",
            call_id: terminalOutput.providerFunctionCallId,
            output: terminalOutput.output,
          },
        },
      ]);
      expect(messages.some((message) => message.type === "response.cancel")).toBe(false);
      expect(messages.some((message) => message.type === "response.create")).toBe(false);

      yield* Fiber.interrupt(eventFiber);
      yield* session.terminate;
    }),
);

it.effect("retries a terminal tool output after the sideband send fails", () =>
  Effect.gen(function* () {
    const queueReady = yield* Deferred.make<Queue.Queue<OpenAiRealtimeSocketEvent>>();
    const retrySent = yield* Deferred.make<void>();
    const sent: Array<string> = [];
    let terminalSendCount = 0;
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/hangup")
            ? new Response(null, { status: 200 })
            : new Response("answer-sdp", {
                status: 201,
                headers: { location: "/v1/realtime/calls/rtc_terminal_send_retry" },
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
              Effect.gen(function* () {
                sent.push(data);
                const message = decodeJson(data) as { readonly type?: string };
                if (message.type !== "conversation.item.create") return;
                terminalSendCount += 1;
                if (terminalSendCount === 1) {
                  return yield* new VoiceError({
                    reason: "provider-unavailable",
                    operation: "test.terminal-output.send",
                    detail: "Terminal output send failed",
                    retryable: true,
                  });
                }
                yield* Deferred.succeed(retrySent, undefined);
              }),
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
      sessionId: "voice-session-terminal-send-retry" as never,
      leaseGeneration: 1,
      offer: {
        sessionId: "voice-session-terminal-send-retry" as never,
        leaseGeneration: 1,
        sdp: "offer-sdp",
      },
      instructions: "test",
      terminalActions: new Set(["stop-realtime"]),
      continuationContext: [],
    });
    const eventFiber = yield* session.events.pipe(Stream.runDrain, Effect.forkScoped);
    const queue = yield* Deferred.await(queueReady);
    const output = {
      providerFunctionCallId: "call-terminal-send-retry",
      output: '{"status":"accepted"}',
      itemId: "t3t_terminal_send_retry",
    };

    const sendFailure = yield* session.completeTerminalToolCall(output).pipe(Effect.flip);
    expect(sendFailure.detail).toContain("send failed");

    const retry = yield* session.completeTerminalToolCall(output).pipe(Effect.forkScoped);
    yield* Deferred.await(retrySent);
    yield* Queue.offer(queue, {
      type: "message",
      data: encodeJson({ type: "conversation.item.done", item: { id: output.itemId } }),
    });
    yield* Fiber.join(retry);

    const messages = sent.map((message) => decodeJson(message)) as ReadonlyArray<{
      readonly type?: string;
    }>;
    expect(messages.filter((message) => message.type === "conversation.item.create")).toHaveLength(
      2,
    );
    expect(messages.some((message) => message.type === "response.create")).toBe(false);
    yield* Fiber.interrupt(eventFiber);
    yield* session.terminate;
  }),
);

it.effect("retries a terminal tool output after its acknowledgement times out", () =>
  Effect.gen(function* () {
    const queueReady = yield* Deferred.make<Queue.Queue<OpenAiRealtimeSocketEvent>>();
    const firstSent = yield* Deferred.make<void>();
    const retrySent = yield* Deferred.make<void>();
    const sent: Array<string> = [];
    let terminalSendCount = 0;
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/hangup")
            ? new Response(null, { status: 200 })
            : new Response("answer-sdp", {
                status: 201,
                headers: { location: "/v1/realtime/calls/rtc_terminal_timeout_retry" },
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
              Effect.gen(function* () {
                sent.push(data);
                const message = decodeJson(data) as { readonly type?: string };
                if (message.type !== "conversation.item.create") return;
                terminalSendCount += 1;
                yield* Deferred.succeed(terminalSendCount === 1 ? firstSent : retrySent, undefined);
              }),
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
      sessionId: "voice-session-terminal-timeout-retry" as never,
      leaseGeneration: 1,
      offer: {
        sessionId: "voice-session-terminal-timeout-retry" as never,
        leaseGeneration: 1,
        sdp: "offer-sdp",
      },
      instructions: "test",
      terminalActions: new Set(["stop-realtime"]),
      continuationContext: [],
    });
    const eventFiber = yield* session.events.pipe(Stream.runDrain, Effect.forkScoped);
    const queue = yield* Deferred.await(queueReady);
    const output = {
      providerFunctionCallId: "call-terminal-timeout-retry",
      output: '{"status":"accepted"}',
      itemId: "t3t_terminal_timeout_retry",
    };

    const firstAttempt = yield* session
      .completeTerminalToolCall(output)
      .pipe(Effect.flip, Effect.forkScoped);
    yield* Deferred.await(firstSent);
    yield* TestClock.adjust("10 seconds");
    const timeout = yield* Fiber.join(firstAttempt);
    expect(timeout.detail).toContain("did not acknowledge");

    const retry = yield* session.completeTerminalToolCall(output).pipe(Effect.forkScoped);
    yield* Deferred.await(retrySent);
    yield* Queue.offer(queue, {
      type: "message",
      data: encodeJson({ type: "conversation.item.done", item: { id: output.itemId } }),
    });
    yield* Fiber.join(retry);

    const messages = sent.map((message) => decodeJson(message)) as ReadonlyArray<{
      readonly type?: string;
    }>;
    expect(messages.filter((message) => message.type === "conversation.item.create")).toHaveLength(
      2,
    );
    expect(messages.some((message) => message.type === "response.create")).toBe(false);
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
        terminalActions: new Set(),
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
                headers: {
                  location: "/v1/realtime/calls/rtc_replay_rejected",
                },
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
        terminalActions: new Set(),
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
                headers: {
                  location: "/v1/realtime/calls/rtc_replay_incomplete",
                },
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
        terminalActions: new Set(),
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

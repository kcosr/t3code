import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../../../serverSettings.ts";
import { VoiceCredentialStore } from "../../Services/VoiceCredentialStore.ts";
import { __testing } from "./OpenAiSpeechServerVoiceProvider.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const baseSettings = (patch?: {
  readonly baseUrl?: string;
  readonly transcriptionProvider?: "openai" | "openai-speech-server";
  readonly speechProvider?: "openai" | "openai-speech-server";
  readonly speechPresets?: ServerSettings["voice"]["openaiSpeechServer"]["speechPresets"];
}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  voice: {
    ...DEFAULT_SERVER_SETTINGS.voice,
    enabled: true,
    providers: {
      transcription: patch?.transcriptionProvider ?? "openai-speech-server",
      speech: patch?.speechProvider ?? "openai-speech-server",
    },
    openaiSpeechServer: {
      ...DEFAULT_SERVER_SETTINGS.voice.openaiSpeechServer,
      baseUrl: patch?.baseUrl ?? "http://speech.test:6624",
      ...(patch?.speechPresets === undefined ? {} : { speechPresets: patch.speechPresets }),
    },
  },
});

const settingsService = (settings: ServerSettings) =>
  ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: () => Effect.die("unused"),
    streamChanges: Stream.empty,
  });

const credentialStore = (token: Option.Option<string>) =>
  VoiceCredentialStore.of({
    listStatus: Effect.succeed({
      credentials: [
        { providerId: "openai", configured: false, updatedAt: null },
        {
          providerId: "openai-speech-server",
          configured: Option.isSome(token),
          updatedAt: null,
        },
      ],
    }),
    status: (providerId) =>
      Effect.succeed({
        providerId,
        configured: providerId === "openai-speech-server" && Option.isSome(token),
        updatedAt: null,
      }),
    get: (providerId) =>
      Effect.succeed(providerId === "openai-speech-server" ? token : Option.none()),
    set: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
  });

const makeProvider = (
  httpClient: HttpClient.HttpClient,
  options?: {
    readonly token?: Option.Option<string>;
    readonly settings?: ServerSettings;
  },
) =>
  __testing.make.pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(
      VoiceCredentialStore,
      credentialStore(options?.token ?? Option.some("speech-token")),
    ),
    Effect.provideService(
      ServerSettingsService,
      settingsService(options?.settings ?? baseSettings()),
    ),
  );

it.effect("transcribes with model=default, stream=true, language, and prompt", () =>
  Effect.gen(function* () {
    const seen: Array<{
      readonly url: string;
      readonly authorization?: string;
      readonly form: Record<string, string>;
      readonly fileType?: string;
      readonly fileName?: string;
    }> = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        const form: Record<string, string> = {};
        let fileType: string | undefined;
        let fileName: string | undefined;
        if (request.body._tag === "FormData") {
          const formData = request.body.formData;
          formData.forEach((value, key) => {
            if (typeof value === "string") {
              form[key] = value;
              return;
            }
            const file = value as { readonly type?: string; readonly name?: string };
            fileType = file.type;
            fileName = file.name;
          });
        }
        seen.push({
          url: request.url,
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          form,
          ...(fileType === undefined ? {} : { fileType }),
          ...(fileName === undefined ? {} : { fileName }),
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            [
              'data: {"type":"transcript.text.done","text":"hello from speech server"}\n\n',
              "data: [DONE]\n\n",
            ].join(""),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "x-request-id": "upstream-req-1",
              },
            },
          ),
        );
      }),
    );
    const provider = yield* makeProvider(httpClient);
    const events = yield* provider
      .transcriber!.transcribe({
        requestId: "voice-request-1" as never,
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "audio/mp4",
        language: "en",
        vocabulary: ["T3", "Codex"],
      })
      .pipe(Stream.runCollect);

    expect(Array.from(events)).toEqual([
      {
        type: "final",
        result: {
          requestId: "voice-request-1",
          text: "hello from speech server",
          language: "en",
        },
      },
    ]);
    expect(seen).toEqual([
      {
        url: "http://speech.test:6624/v1/audio/transcriptions",
        authorization: "Bearer speech-token",
        form: {
          model: "default",
          stream: "true",
          language: "en",
          prompt: "T3, Codex",
        },
        fileType: "audio/mp4",
        fileName: "utterance.m4a",
      },
    ]);
  }),
);

it.effect("rejects unknown presets without calling upstream", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider(
      HttpClient.make(() => Effect.die("HTTP must not be called")),
    );
    const error = yield* provider
      .speechSynthesizer!.prepare({
        requestId: "voice-request-2" as never,
        playbackId: "voice-playback-1",
        segmentIndex: 0,
        finalSegment: true,
        text: "Hello",
        preset: "mystery" as never,
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("unsupported-media");
  }),
);

it.effect("maps speech presets and validates PCM before streaming", () =>
  Effect.gen(function* () {
    let requestBody = "";
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") {
          requestBody = new TextDecoder().decode(request.body.body);
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([9, 8, 7, 6]), {
            status: 200,
            headers: {
              "content-type": "audio/pcm",
              "x-request-id": "speech-upstream-1",
            },
          }),
        );
      }),
    );
    const provider = yield* makeProvider(httpClient);
    const body = yield* provider.speechSynthesizer!.prepare({
      requestId: "voice-request-3" as never,
      playbackId: "voice-playback-2",
      segmentIndex: 0,
      finalSegment: true,
      text: "Hello world",
      preset: "warm",
    });
    const bytes = yield* body.pipe(Stream.runCollect);
    expect(Array.from(bytes).flatMap((chunk) => Array.from(chunk))).toEqual([9, 8, 7, 6]);
    const decodedRequestBody = yield* decodeUnknownJson(requestBody);
    expect(decodedRequestBody).toMatchObject({
      model: "default",
      voice: "af_sky",
      input: "Hello world",
      response_format: "pcm",
      speed: 1,
      stream_format: "audio",
    });
  }),
);

it.effect("fails prepare when upstream content-type is not PCM", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          }),
        ),
      ),
    );
    const provider = yield* makeProvider(httpClient);
    const error = yield* provider
      .speechSynthesizer!.prepare({
        requestId: "voice-request-4" as never,
        playbackId: "voice-playback-3",
        segmentIndex: 0,
        finalSegment: true,
        text: "Hello",
        preset: "default",
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("unsupported-media");
  }),
);

it.effect("maps 401 before T3 can commit a successful speech response", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson({ error: { message: "bad token" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const provider = yield* makeProvider(httpClient);
    const error = yield* provider
      .speechSynthesizer!.prepare({
        requestId: "voice-request-5" as never,
        playbackId: "voice-playback-4",
        segmentIndex: 0,
        finalSegment: true,
        text: "Hello",
        preset: "default",
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("not-configured");
    expect(error.retryable).toBe(false);
  }),
);

it.effect("maps bounded upstream error statuses", () =>
  Effect.gen(function* () {
    const cases: Array<{ status: number; reason: string }> = [
      { status: 400, reason: "unsupported-media" },
      { status: 413, reason: "payload-too-large" },
      { status: 415, reason: "unsupported-media" },
      { status: 429, reason: "quota-exceeded" },
      { status: 503, reason: "provider-unavailable" },
    ];
    for (const testCase of cases) {
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: testCase.status })),
        ),
      );
      const provider = yield* makeProvider(httpClient);
      const error = yield* provider
        .speechSynthesizer!.prepare({
          requestId: "voice-request-status" as never,
          playbackId: "voice-playback-status",
          segmentIndex: 0,
          finalSegment: true,
          text: "Hello",
          preset: "default",
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe(testCase.reason);
    }
  }),
);

it.effect("fails closed when base URL or token is missing", () =>
  Effect.gen(function* () {
    const missingUrl = yield* makeProvider(
      HttpClient.make(() => Effect.die("HTTP must not be called")),
      { settings: baseSettings({ baseUrl: "" }) },
    );
    const missingUrlError = yield* missingUrl
      .speechSynthesizer!.prepare({
        requestId: "voice-request-6" as never,
        playbackId: "voice-playback-5",
        segmentIndex: 0,
        finalSegment: true,
        text: "Hello",
        preset: "default",
      })
      .pipe(Effect.flip);
    expect(missingUrlError.reason).toBe("not-configured");

    const missingToken = yield* makeProvider(
      HttpClient.make(() => Effect.die("HTTP must not be called")),
      { token: Option.none() },
    );
    const missingTokenError = yield* missingToken
      .transcriber!.transcribe({
        requestId: "voice-request-7" as never,
        bytes: new Uint8Array([1]),
        mediaType: "audio/mp4",
      })
      .pipe(Stream.runDrain, Effect.flip);
    expect(missingTokenError.reason).toBe("not-configured");
  }),
);

it.effect("allows interrupting an opened speech body stream", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4]));
              },
            }),
            {
              status: 200,
              headers: { "content-type": "audio/pcm" },
            },
          ),
        ),
      ),
    );
    const provider = yield* makeProvider(httpClient);
    const body = yield* provider.speechSynthesizer!.prepare({
      requestId: "voice-request-8" as never,
      playbackId: "voice-playback-6",
      segmentIndex: 0,
      finalSegment: true,
      text: "Hello",
      preset: "default",
    });
    const fiber = yield* Effect.forkChild(body.pipe(Stream.runDrain));
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("reports readiness from health/ready with configuration gates", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"status":"ready"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );

    const ready = yield* __testing.checkOpenAiSpeechServerHealth.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("speech-token"))),
      Effect.provideService(ServerSettingsService, settingsService(baseSettings())),
    );
    expect(ready).toBe("ready");
    expect(requests).toEqual(["http://speech.test:6624/health/ready"]);

    const missingConfig = yield* __testing.checkOpenAiSpeechServerHealth.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("HTTP must not be called")),
      ),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("speech-token"))),
      Effect.provideService(ServerSettingsService, settingsService(baseSettings({ baseUrl: "" }))),
    );
    expect(missingConfig).toBe("not-configured");

    const unhealthyClient = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
    );
    const unhealthy = yield* __testing.checkOpenAiSpeechServerHealth.pipe(
      Effect.provideService(HttpClient.HttpClient, unhealthyClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("speech-token"))),
      Effect.provideService(ServerSettingsService, settingsService(baseSettings())),
    );
    expect(unhealthy).toBe("unavailable");
  }),
);

it.effect("reads live settings so selection changes affect the next request", () =>
  Effect.gen(function* () {
    const settingsRef = yield* Ref.make(baseSettings({ baseUrl: "http://speech-a.test:6624" }));
    const urls: Array<string> = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        urls.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          new Response('data: {"type":"transcript.text.done","text":"ok"}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }),
    );
    const liveSettings = ServerSettingsService.of({
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: () => Effect.die("unused"),
      streamChanges: Stream.empty,
    });
    const provider = yield* __testing.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(VoiceCredentialStore, credentialStore(Option.some("speech-token"))),
      Effect.provideService(ServerSettingsService, liveSettings),
    );
    yield* provider
      .transcriber!.transcribe({
        requestId: "voice-request-a" as never,
        bytes: new Uint8Array([1]),
        mediaType: "audio/mp4",
      })
      .pipe(Stream.runDrain);
    yield* Ref.set(settingsRef, baseSettings({ baseUrl: "http://speech-b.test:6624" }));
    yield* provider
      .transcriber!.transcribe({
        requestId: "voice-request-b" as never,
        bytes: new Uint8Array([1]),
        mediaType: "audio/mp4",
      })
      .pipe(Stream.runDrain);
    expect(urls).toEqual([
      "http://speech-a.test:6624/v1/audio/transcriptions",
      "http://speech-b.test:6624/v1/audio/transcriptions",
    ]);
  }),
);

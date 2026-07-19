import type { VoiceCommandToolName, VoiceTerminalAction } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { VoiceError } from "../../Errors.ts";
import { realtimeToolConfig } from "../../modelTools/declarations.ts";
import { resolveVoiceToolExposure } from "../../modelTools/exposure.ts";
import { VOICE_SPEECH_FIRST_BYTE_TIMEOUT_SECONDS } from "../../Services/VoiceMediaPolicy.ts";
import { VoiceCredentialStore } from "../../Services/VoiceCredentialStore.ts";
import { logVoiceDiagnostic } from "../../Services/VoiceObservability.ts";
import type {
  RealtimeProviderEvent,
  RealtimeVoiceProvider,
  SpeechSynthesizer,
  Transcriber,
  VoiceProviderAdapter,
} from "../../Services/VoiceProvider.ts";
import {
  logOpenAiCompatibleHttpFailure,
  mapOpenAiCompatibleHttpFailure,
  mapTranscriptionSseToVoiceEvents,
  requireCompatiblePcmResponse,
  requireOkHttpResponse,
} from "../openaiCompatible/http.ts";
import {
  OpenAiRealtimeSocket,
  OpenAiRealtimeSocketLive,
  type OpenAiRealtimeSocketEvent,
} from "./OpenAiRealtimeSocket.ts";

const OPENAI_API_ORIGIN = "https://api.openai.com";
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const SPEECH_MODEL = "gpt-4o-mini-tts";
const REALTIME_MODEL = "gpt-realtime-2.1";
const CONTEXT_REPLAY_TIMEOUT = "30 seconds";
const CONTEXT_UPDATE_TIMEOUT = "10 seconds";
const TERMINAL_TOOL_OUTPUT_TIMEOUT = "10 seconds";
const VOICE_PRESETS: Readonly<Record<string, string>> = {
  default: "marin",
  warm: "cedar",
};
const decodeRealtimeEventJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const decodeRealtimeRecord = (data: string): Record<string, unknown> | undefined => {
  try {
    const value = decodeRealtimeEventJson(data);
    return typeof value === "object" && value !== null && "type" in value
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export class OpenAiVoiceProvider extends Context.Service<
  OpenAiVoiceProvider,
  VoiceProviderAdapter
>()("t3/voice/Providers/OpenAi/OpenAiVoiceProvider") {}

const providerError = (operation: string) => (cause: unknown) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation,
    detail: "OpenAI voice request failed",
    retryable: true,
    cause,
  });

const logHttpFailure = (operation: string, cause: unknown) =>
  logOpenAiCompatibleHttpFailure(operation, cause);

const isTransientNegotiationFailure = (cause: unknown): boolean =>
  Cause.isTimeoutError(cause) ||
  (HttpClientError.isHttpClientError(cause) &&
    cause.response !== undefined &&
    (cause.response.status === 502 ||
      cause.response.status === 503 ||
      cause.response.status === 504));

const safeOperationalValue = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9._:/[\]-]{1,128}$/.test(value) ? value : undefined;

const realtimeDiagnostic = (
  event: OpenAiRealtimeSocketEvent,
  correlation?: {
    readonly sessionId: string;
    readonly leaseGeneration: number;
  },
):
  | {
      readonly message: string;
      readonly annotations: Readonly<Record<string, string | number | boolean>>;
    }
  | undefined => {
  if (event.type === "closed") {
    return {
      message: "OpenAI Realtime sideband closed",
      annotations: {
        ...correlation,
        closeCode: event.code,
        closeReason:
          event.reason.length === 0
            ? "none"
            : event.reason === "T3 voice session closed"
              ? "client-closed"
              : "provider-supplied",
        closeReasonLength: event.reason.length,
      },
    };
  }
  if (event.type === "error") {
    return {
      message: "OpenAI Realtime sideband transport error",
      annotations: {
        ...correlation,
        causeType: event.cause instanceof Error ? "error-object" : typeof event.cause,
      },
    };
  }
  const record = decodeRealtimeRecord(event.data);
  if (record?.type !== "error") return undefined;
  const error =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {};
  return {
    message: "OpenAI Realtime provider error",
    annotations: {
      ...correlation,
      ...(safeOperationalValue(error.type) === undefined
        ? {}
        : { providerErrorType: safeOperationalValue(error.type)! }),
      ...(safeOperationalValue(error.code) === undefined
        ? {}
        : { providerErrorCode: safeOperationalValue(error.code)! }),
      ...(safeOperationalValue(error.param) === undefined
        ? {}
        : { providerErrorParam: safeOperationalValue(error.param)! }),
      providerMessagePresent: typeof error.message === "string" && error.message.length > 0,
    },
  };
};

const completedFunctionCall = (
  value: unknown,
):
  | {
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const call = value as Record<string, unknown>;
  return call.type === "function_call" &&
    call.status === "completed" &&
    typeof call.call_id === "string" &&
    typeof call.name === "string" &&
    typeof call.arguments === "string"
    ? { callId: call.call_id, name: call.name, argumentsJson: call.arguments }
    : undefined;
};

/** Non-negative integer from provider usage objects; rejects non-finite values. */
const usageCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * Extract privacy-safe token counts from `response.done` usage.
 * Never includes transcripts, tool args, or provider item content.
 */
const parseResponseUsage = (
  response: unknown,
): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTextTokens: number;
  readonly inputAudioTokens: number;
  readonly inputImageTokens: number;
  readonly cachedInputTextTokens: number;
  readonly cachedInputAudioTokens: number;
  readonly cachedInputImageTokens: number;
  readonly outputTextTokens: number;
  readonly outputAudioTokens: number;
  readonly functionCallCount: number;
} | null => {
  const responseRecord = asRecord(response);
  if (responseRecord === undefined) return null;
  const usage = asRecord(responseRecord.usage);
  if (usage === undefined) return null;

  const inputDetails = asRecord(usage.input_token_details) ?? asRecord(usage.input_tokens_details);
  const cachedDetails = asRecord(inputDetails?.cached_tokens_details);
  const outputDetails =
    asRecord(usage.output_token_details) ?? asRecord(usage.output_tokens_details);

  let functionCallCount = 0;
  if (Array.isArray(responseRecord.output)) {
    for (const item of responseRecord.output) {
      if (completedFunctionCall(item) !== undefined) functionCallCount += 1;
    }
  }

  return {
    inputTokens: usageCount(usage.input_tokens),
    outputTokens: usageCount(usage.output_tokens),
    totalTokens: usageCount(usage.total_tokens),
    cachedInputTokens: usageCount(inputDetails?.cached_tokens),
    inputTextTokens: usageCount(inputDetails?.text_tokens),
    inputAudioTokens: usageCount(inputDetails?.audio_tokens),
    inputImageTokens: usageCount(inputDetails?.image_tokens),
    cachedInputTextTokens: usageCount(cachedDetails?.text_tokens),
    cachedInputAudioTokens: usageCount(cachedDetails?.audio_tokens),
    cachedInputImageTokens: usageCount(cachedDetails?.image_tokens),
    outputTextTokens: usageCount(outputDetails?.text_tokens),
    outputAudioTokens: usageCount(outputDetails?.audio_tokens),
    functionCallCount,
  };
};

const parseInputTranscriptionUsage = (
  record: Record<string, unknown>,
): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly inputTextTokens: number;
  readonly inputAudioTokens: number;
} | null => {
  const usage = asRecord(record.usage);
  if (usage === undefined) return null;
  const inputDetails = asRecord(usage.input_token_details) ?? asRecord(usage.input_tokens_details);
  return {
    inputTokens: usageCount(usage.input_tokens),
    outputTokens: usageCount(usage.output_tokens),
    totalTokens: usageCount(usage.total_tokens),
    inputTextTokens: usageCount(inputDetails?.text_tokens),
    inputAudioTokens: usageCount(inputDetails?.audio_tokens),
  };
};

const isBenignRealtimeClose = (event: OpenAiRealtimeSocketEvent): boolean =>
  event.type === "closed" && (event.code === 1000 || event.code === 1001 || event.code === 1005);

const parseRealtimeEvent = (
  event: OpenAiRealtimeSocketEvent,
): ReadonlyArray<RealtimeProviderEvent> => {
  if (event.type === "closed") {
    return isBenignRealtimeClose(event)
      ? [{ type: "closed" }]
      : [
          {
            type: "error",
            detail: "OpenAI Realtime sideband closed unexpectedly",
            recoverable: false,
          },
        ];
  }
  if (event.type === "error") {
    return [
      {
        type: "error",
        detail: "OpenAI Realtime sideband failed",
        recoverable: true,
      },
    ];
  }
  let value: unknown;
  try {
    value = decodeRealtimeEventJson(event.data);
  } catch {
    return [
      {
        type: "error",
        detail: "OpenAI sent an invalid Realtime event",
        recoverable: false,
      },
    ];
  }
  if (typeof value !== "object" || value === null || !("type" in value)) return [];
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "input_audio_buffer.speech_started":
      return [{ type: "activity", activity: "listening" }];
    case "input_audio_buffer.speech_stopped":
    case "response.created":
      return [{ type: "activity", activity: "thinking" }];
    case "response.output_audio.delta":
      return [{ type: "activity", activity: "speaking" }];
    case "response.done": {
      const response = record.response;
      if (typeof response !== "object" || response === null) {
        return [{ type: "activity", activity: "idle" }];
      }
      const responseRecord = response as Record<string, unknown>;
      const calls = Array.isArray(responseRecord.output)
        ? responseRecord.output.flatMap((item): ReadonlyArray<RealtimeProviderEvent> => {
            const call = completedFunctionCall(item);
            return call === undefined
              ? []
              : [
                  {
                    type: "function-call",
                    providerFunctionCallId: call.callId,
                    name: call.name,
                    argumentsJson: call.argumentsJson,
                  },
                ];
          })
        : [];
      return [...calls, { type: "activity", activity: "idle" }];
    }
    case "conversation.item.input_audio_transcription.delta":
      return typeof record.delta === "string" && record.delta.length > 0
        ? [
            {
              type: "transcript",
              role: "user",
              text: record.delta,
              final: false,
            },
          ]
        : [];
    case "conversation.item.input_audio_transcription.completed":
      if (typeof record.transcript !== "string") return [];
      const inputTranscript = record.transcript.trim();
      if (inputTranscript.length === 0) return [];
      if (
        typeof record.item_id !== "string" ||
        !Number.isInteger(record.content_index) ||
        (record.content_index as number) < 0
      ) {
        return [
          {
            type: "error",
            detail: "OpenAI sent a final input transcript without a stable identity",
            recoverable: false,
          },
        ];
      }
      return [
        {
          type: "transcript",
          role: "user",
          text: inputTranscript,
          final: true,
          sourceId: `input:${record.item_id}:${record.content_index}`,
        },
      ];
    case "response.output_audio_transcript.delta":
      return typeof record.delta === "string" && record.delta.length > 0
        ? [
            {
              type: "transcript",
              role: "assistant",
              text: record.delta,
              final: false,
            },
          ]
        : [];
    case "response.output_audio_transcript.done":
      if (typeof record.transcript !== "string") return [];
      const outputTranscript = record.transcript.trim();
      if (outputTranscript.length === 0) return [];
      if (
        typeof record.item_id !== "string" ||
        !Number.isInteger(record.content_index) ||
        (record.content_index as number) < 0
      ) {
        return [
          {
            type: "error",
            detail: "OpenAI sent a final output transcript without a stable identity",
            recoverable: false,
          },
        ];
      }
      return [
        {
          type: "transcript",
          role: "assistant",
          text: outputTranscript,
          final: true,
          sourceId: `output:${record.item_id}:${record.content_index}`,
        },
      ];
    case "error": {
      return [
        {
          type: "error",
          detail: "OpenAI Realtime reported an error",
          recoverable: false,
        },
      ];
    }
    default:
      return [];
  }
};

const providerSessionConfig = (
  instructions: string,
  terminalActions: ReadonlySet<VoiceTerminalAction>,
  commandTools: ReadonlyArray<VoiceCommandToolName>,
) => ({
  type: "realtime",
  model: REALTIME_MODEL,
  output_modalities: ["audio"],
  instructions,
  truncation: "disabled",
  audio: {
    input: {
      format: { type: "audio/pcm", rate: 24_000 },
      transcription: { model: TRANSCRIPTION_MODEL },
      turn_detection: { type: "semantic_vad" },
    },
    output: { format: { type: "audio/pcm" }, voice: VOICE_PRESETS.default },
  },
  ...realtimeToolConfig({
    terminalActions,
    exposure: resolveVoiceToolExposure(commandTools),
  }),
});

const continuationEvent = (
  item: {
    readonly role: "system" | "user" | "assistant";
    readonly text: string;
  },
  identity: { readonly eventId: string; readonly itemId: string },
) => ({
  type: "conversation.item.create",
  event_id: identity.eventId,
  item: {
    id: identity.itemId,
    type: "message",
    role: item.role,
    status: "completed",
    content: [
      {
        type: item.role === "assistant" ? "output_text" : "input_text",
        text: item.text,
      },
    ],
  },
});

const continuationIdentity = (sessionId: string, leaseGeneration: number, index: number) => ({
  eventId: `t3_replay_event_${sessionId}_${leaseGeneration}_${index}`,
  itemId: `t3ctx_${leaseGeneration.toString(36)}_${index.toString(36)}`,
});

const replayError = (
  detail: string,
  options?: { readonly cause?: unknown; readonly retryable?: boolean },
) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation: "openai.realtime.context-replay",
    detail,
    retryable: options?.retryable ?? true,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

const contextUpdateError = (
  detail: string,
  options?: { readonly cause?: unknown; readonly retryable?: boolean },
) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation: "openai.realtime.context-update",
    detail,
    retryable: options?.retryable ?? true,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

const terminalToolOutputError = (
  detail: string,
  options?: { readonly cause?: unknown; readonly retryable?: boolean },
) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation: "openai.realtime.terminal-tool-output",
    detail,
    retryable: options?.retryable ?? true,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

type ReplayServerEvent =
  | { readonly type: "acknowledged"; readonly itemId: string }
  | { readonly type: "rejected"; readonly clientEventId: string | undefined }
  | { readonly type: "ignored" };

const parseReplayServerEvent = (
  event: OpenAiRealtimeSocketEvent,
): Effect.Effect<ReplayServerEvent, VoiceError> => {
  if (event.type === "closed") {
    return Effect.fail(replayError("OpenAI Realtime closed before context replay completed"));
  }
  if (event.type === "error") {
    return Effect.fail(
      replayError("OpenAI Realtime failed during context replay", {
        cause: event.cause,
      }),
    );
  }
  let value: unknown;
  try {
    value = decodeRealtimeEventJson(event.data);
  } catch {
    return Effect.fail(replayError("OpenAI sent an invalid context replay event"));
  }
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return Effect.succeed({ type: "ignored" });
  }
  const record = value as Record<string, unknown>;
  if (record.type === "conversation.item.done") {
    const item = record.item;
    return Effect.succeed(
      typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string"
        ? { type: "acknowledged", itemId: (item as { readonly id: string }).id }
        : { type: "ignored" },
    );
  }
  if (record.type === "error") {
    const error = record.error;
    const clientEventId =
      typeof error === "object" &&
      error !== null &&
      typeof (error as Record<string, unknown>).event_id === "string"
        ? ((error as Record<string, unknown>).event_id as string)
        : undefined;
    return Effect.succeed({ type: "rejected", clientEventId });
  }
  return Effect.succeed({ type: "ignored" });
};

const requireApiKey = (credentials: VoiceCredentialStore["Service"]) =>
  credentials.get("openai").pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new VoiceError({
              reason: "not-configured",
              operation: "openai.credentials",
              detail: "OpenAI voice credential is not configured",
              retryable: false,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const credentials = yield* VoiceCredentialStore;
  const realtimeSocket = yield* OpenAiRealtimeSocket;

  const transcriber: Transcriber = {
    transcribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* requireApiKey(credentials);
          const data = new FormData();
          data.append("file", new File([input.bytes], "utterance", { type: input.mediaType }));
          data.append("model", TRANSCRIPTION_MODEL);
          data.append("stream", "true");
          if (input.language !== undefined) data.append("language", input.language);
          if (input.vocabulary !== undefined && input.vocabulary.length > 0) {
            data.append("prompt", input.vocabulary.join(", "));
          }
          const request = HttpClientRequest.post(
            `${OPENAI_API_ORIGIN}/v1/audio/transcriptions`,
          ).pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.setHeader("accept", "text/event-stream"),
            HttpClientRequest.setBody(HttpBody.formData(data)),
          );
          const response = yield* client.execute(request).pipe(
            Effect.tapError((cause) => logHttpFailure("openai.transcribe", cause)),
            Effect.mapError(mapOpenAiCompatibleHttpFailure("openai.transcribe")),
          );
          yield* requireOkHttpResponse(response, "openai.transcribe");
          return mapTranscriptionSseToVoiceEvents(
            response,
            input.requestId,
            input.language,
            "openai.transcribe",
          );
        }),
      ),
  };

  const speechSynthesizer: SpeechSynthesizer = {
    prepare: (input) =>
      Effect.gen(function* () {
        const apiKey = yield* requireApiKey(credentials);
        const voice = VOICE_PRESETS[input.preset];
        if (voice === undefined) {
          return yield* new VoiceError({
            reason: "unsupported-media",
            operation: "openai.synthesize",
            detail: `Unknown server voice preset: ${input.preset}`,
            retryable: false,
          });
        }
        const request = yield* HttpClientRequest.post(`${OPENAI_API_ORIGIN}/v1/audio/speech`).pipe(
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.setHeader("accept", "audio/pcm"),
          HttpClientRequest.bodyJson({
            model: SPEECH_MODEL,
            voice,
            input: input.text,
            response_format: "pcm",
          }),
          Effect.mapError(providerError("openai.synthesize.request")),
        );
        // Bound connect+headers before the media route commits 200 / holds a permit.
        // Matches the pre-prepare first-byte budget and speech-server connect timeout.
        const response = yield* client.execute(request).pipe(
          Effect.timeout(`${VOICE_SPEECH_FIRST_BYTE_TIMEOUT_SECONDS} seconds`),
          Effect.tapError((cause) => logHttpFailure("openai.synthesize", cause)),
          Effect.mapError(mapOpenAiCompatibleHttpFailure("openai.synthesize")),
        );
        yield* requireCompatiblePcmResponse(response, "openai.synthesize");
        return response.stream.pipe(
          Stream.tapError((cause) => logHttpFailure("openai.synthesize", cause)),
          Stream.mapError(mapOpenAiCompatibleHttpFailure("openai.synthesize")),
        );
      }),
  };

  const realtime: RealtimeVoiceProvider = {
    negotiate: Effect.fn("OpenAiVoiceProvider.realtime.negotiate")(function* (input) {
      const apiKey = yield* requireApiKey(credentials);
      const sessionCommandTools = input.commandTools;
      const sessionExposure = resolveVoiceToolExposure(sessionCommandTools);
      const form = new FormData();
      form.set("sdp", input.offer.sdp);
      form.set(
        "session",
        encodeJson(
          providerSessionConfig(input.instructions, input.terminalActions, sessionCommandTools),
        ),
      );
      const providerCallStartedAt = yield* Clock.currentTimeMillis;
      const response = yield* client
        .execute(
          HttpClientRequest.post(`${OPENAI_API_ORIGIN}/v1/realtime/calls`).pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.setHeader("accept", "application/sdp"),
            HttpClientRequest.setBody(HttpBody.formData(form)),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.timeout("7 seconds"),
          Effect.tapError((cause) => logHttpFailure("openai.realtime.negotiate", cause)),
          Effect.retry({ times: 1, while: isTransientNegotiationFailure }),
          Effect.mapError(providerError("openai.realtime.negotiate")),
        );
      const providerRealtimeCallId = response.headers.location?.split("/").at(-1);
      if (providerRealtimeCallId === undefined || !providerRealtimeCallId.startsWith("rtc_")) {
        return yield* new VoiceError({
          reason: "provider-unavailable",
          operation: "openai.realtime.negotiate",
          detail: "OpenAI Realtime response omitted a valid call ID",
          retryable: true,
        });
      }
      const hangup = client
        .execute(
          HttpClientRequest.post(
            `${OPENAI_API_ORIGIN}/v1/realtime/calls/${encodeURIComponent(providerRealtimeCallId)}/hangup`,
          ).pipe(HttpClientRequest.bearerToken(apiKey)),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.asVoid,
          Effect.timeout("7 seconds"),
          Effect.mapError(providerError("openai.realtime.hangup")),
        );
      const answerSdp = yield* response.text.pipe(
        Effect.mapError(providerError("openai.realtime.answer")),
        Effect.catch((cause) => hangup.pipe(Effect.ignore, Effect.andThen(Effect.fail(cause)))),
      );
      if (answerSdp.trim().length === 0) {
        return yield* hangup.pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.fail(
              new VoiceError({
                reason: "provider-unavailable",
                operation: "openai.realtime.answer",
                detail: "OpenAI Realtime returned an empty SDP answer",
                retryable: true,
              }),
            ),
          ),
        );
      }
      const providerCallCompletedAt = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("OpenAI Realtime call created", {
        sessionId: input.sessionId,
        leaseGeneration: input.leaseGeneration,
        durationMs: Math.max(0, providerCallCompletedAt - providerCallStartedAt),
      });
      const sessionScope = yield* Scope.make("sequential");
      const sidebandStartedAt = yield* Clock.currentTimeMillis;
      const sideband = yield* realtimeSocket
        .connect({
          url: `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(providerRealtimeCallId)}`,
          apiKey,
        })
        .pipe(
          Scope.provide(sessionScope),
          Effect.onExit((exit) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((sidebandCompletedAt) =>
                logVoiceDiagnostic({
                  type: "provider-sideband-attached",
                  sessionId: input.sessionId,
                  leaseGeneration: input.leaseGeneration,
                  outcome: Exit.isSuccess(exit) ? "success" : "failure",
                  durationMs: Math.max(0, sidebandCompletedAt - sidebandStartedAt),
                }),
              ),
            ),
          ),
          Effect.catch((cause) =>
            hangup.pipe(
              Effect.ignore,
              Effect.andThen(Scope.close(sessionScope, Exit.void)),
              Effect.andThen(Effect.fail(cause)),
            ),
          ),
        );
      const abortStartup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catch((cause) =>
            hangup.pipe(
              Effect.ignore,
              Effect.andThen(Scope.close(sessionScope, Exit.void)),
              Effect.andThen(Effect.fail(cause)),
            ),
          ),
        );
      const replayItems = input.continuationContext.map((item, index) => ({
        item,
        identity: continuationIdentity(input.sessionId, input.leaseGeneration, index),
      }));
      const replayStartedAt = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("OpenAI Realtime context replay starting", {
        sessionId: input.sessionId,
        leaseGeneration: input.leaseGeneration,
        requestedItemCount: replayItems.length,
      });
      const acknowledgedReplayItems = yield* Ref.make(0);
      const acknowledgedItemCount = yield* Effect.gen(function* () {
        const pendingByItemId = new Map(
          replayItems.map(({ identity }) => [identity.itemId, identity.eventId] as const),
        );
        const pendingEventIds = new Set(replayItems.map(({ identity }) => identity.eventId));
        for (const { item, identity } of replayItems) {
          yield* sideband.send(encodeJson(continuationEvent(item, identity)));
        }
        while (pendingByItemId.size > 0) {
          const replayEvent = yield* sideband.receive.pipe(Effect.flatMap(parseReplayServerEvent));
          if (replayEvent.type === "acknowledged") {
            const clientEventId = pendingByItemId.get(replayEvent.itemId);
            if (clientEventId !== undefined) {
              pendingByItemId.delete(replayEvent.itemId);
              pendingEventIds.delete(clientEventId);
              yield* Ref.update(acknowledgedReplayItems, (count) => count + 1);
            }
            continue;
          }
          if (
            replayEvent.type === "rejected" &&
            (replayEvent.clientEventId === undefined ||
              pendingEventIds.has(replayEvent.clientEventId))
          ) {
            return yield* replayError("OpenAI rejected a context replay item", {
              retryable: false,
            });
          }
        }
        return yield* Ref.get(acknowledgedReplayItems);
      }).pipe(
        Effect.timeoutOption(CONTEXT_REPLAY_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(replayError("OpenAI context replay did not acknowledge every item")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.tapError(() =>
          Effect.all([Ref.get(acknowledgedReplayItems), Clock.currentTimeMillis]).pipe(
            Effect.flatMap(([acknowledgedItemCount, replayFailedAt]) =>
              Effect.logWarning("OpenAI Realtime context replay failed", {
                sessionId: input.sessionId,
                leaseGeneration: input.leaseGeneration,
                requestedItemCount: replayItems.length,
                acknowledgedItemCount,
                durationMs: Math.max(0, replayFailedAt - replayStartedAt),
              }),
            ),
          ),
        ),
        abortStartup,
      );
      const replayCompletedAt = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("OpenAI Realtime context replay completed", {
        sessionId: input.sessionId,
        leaseGeneration: input.leaseGeneration,
        requestedItemCount: replayItems.length,
        acknowledgedItemCount,
        durationMs: Math.max(0, replayCompletedAt - replayStartedAt),
      });

      const submittedToolOutputs = yield* Ref.make(new Set<string>());
      const continuationMutex = yield* Semaphore.make(1);
      const continuationState = yield* Ref.make({
        activeResponse: false,
        pendingFunctionCalls: new Set<string>(),
        continuationNeeded: false,
        terminal: false,
        terminalToolCallId: null as string | null,
        terminalItemId: null as string | null,
      });
      const requestContinuationIfReady = Effect.fn(
        "OpenAiVoiceProvider.requestContinuationIfReady",
      )(function* () {
        const state = yield* Ref.get(continuationState);
        if (
          state.activeResponse ||
          state.terminal ||
          state.pendingFunctionCalls.size > 0 ||
          !state.continuationNeeded
        ) {
          return;
        }
        yield* sideband.send(encodeJson({ type: "response.create" }));
        yield* Ref.set(continuationState, {
          ...state,
          activeResponse: true,
          continuationNeeded: false,
        });
      });
      const observeContinuationState = Effect.fn("OpenAiVoiceProvider.observeContinuationState")(
        function* (event: OpenAiRealtimeSocketEvent) {
          if (event.type !== "message") return;
          const record = decodeRealtimeRecord(event.data);
          if (record === undefined) return;
          if (record.type === "response.created") {
            yield* continuationMutex.withPermits(1)(
              Ref.update(continuationState, (state) => ({
                ...state,
                activeResponse: true,
              })),
            );
            return;
          }
          if (record.type === "conversation.item.input_audio_transcription.completed") {
            const transcriptionUsage = parseInputTranscriptionUsage(record);
            if (transcriptionUsage !== null) {
              yield* logVoiceDiagnostic({
                type: "realtime-input-transcription-usage",
                sessionId: input.sessionId,
                leaseGeneration: input.leaseGeneration,
                ...transcriptionUsage,
              });
            }
            return;
          }
          if (record.type !== "response.done") return;
          const response = record.response;
          const responseUsage = parseResponseUsage(response);
          if (responseUsage !== null) {
            yield* logVoiceDiagnostic({
              type: "realtime-response-usage",
              sessionId: input.sessionId,
              leaseGeneration: input.leaseGeneration,
              ...responseUsage,
            });
          }
          const functionCallIds =
            typeof response === "object" && response !== null
              ? ((response as Record<string, unknown>).output as unknown)
              : undefined;
          yield* continuationMutex.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(continuationState, (state) => {
                const pendingFunctionCalls = new Set(state.pendingFunctionCalls);
                if (Array.isArray(functionCallIds)) {
                  for (const item of functionCallIds) {
                    const call = completedFunctionCall(item);
                    if (call !== undefined) pendingFunctionCalls.add(call.callId);
                  }
                }
                return {
                  ...state,
                  activeResponse: false,
                  pendingFunctionCalls,
                };
              });
              yield* requestContinuationIfReady();
            }),
          );
        },
      );
      const observeProviderDiagnostic = Effect.fn("OpenAiVoiceProvider.observeProviderDiagnostic")(
        function* (event: OpenAiRealtimeSocketEvent) {
          const diagnostic = realtimeDiagnostic(event, {
            sessionId: input.sessionId,
            leaseGeneration: input.leaseGeneration,
          });
          if (diagnostic === undefined) return;
          yield* isBenignRealtimeClose(event)
            ? Effect.logInfo(diagnostic.message, diagnostic.annotations)
            : Effect.logWarning(diagnostic.message, diagnostic.annotations);
        },
      );
      const contextUpdateSequence = yield* Ref.make(0);
      const pendingContextUpdates = yield* SynchronizedRef.make(
        new Map<
          string,
          {
            readonly eventId: string;
            readonly completion: Deferred.Deferred<void, VoiceError>;
          }
        >(),
      );
      const terminalActionsUpdateMutex = yield* Semaphore.make(1);
      const pendingTerminalActionsUpdate = yield* SynchronizedRef.make<Deferred.Deferred<
        void,
        VoiceError
      > | null>(null);
      const failPendingTerminalActionsUpdate = Effect.fn(
        "OpenAiVoiceProvider.failPendingTerminalActionsUpdate",
      )(function* (error: VoiceError) {
        const pending = yield* SynchronizedRef.getAndSet(pendingTerminalActionsUpdate, null);
        if (pending !== null) yield* Deferred.fail(pending, error).pipe(Effect.ignore);
      });
      const observeTerminalActionsUpdate = Effect.fn(
        "OpenAiVoiceProvider.observeTerminalActionsUpdate",
      )(function* (event: OpenAiRealtimeSocketEvent) {
        if (event.type === "closed") {
          yield* failPendingTerminalActionsUpdate(
            terminalToolOutputError(
              "OpenAI Realtime closed before terminal tool availability was updated",
            ),
          );
          return;
        }
        if (event.type === "error") {
          yield* failPendingTerminalActionsUpdate(
            terminalToolOutputError(
              "OpenAI Realtime failed while terminal tool availability was updating",
              { cause: event.cause },
            ),
          );
          return;
        }
        const record = decodeRealtimeRecord(event.data);
        if (record?.type !== "session.updated") return;
        const pending = yield* SynchronizedRef.getAndSet(pendingTerminalActionsUpdate, null);
        if (pending !== null) yield* Deferred.succeed(pending, undefined).pipe(Effect.ignore);
      });
      const failPendingContextUpdates = Effect.fn("OpenAiVoiceProvider.failPendingContextUpdates")(
        function* (error: VoiceError) {
          const pending = yield* SynchronizedRef.modify(pendingContextUpdates, (current) => [
            [...current.values()],
            new Map(),
          ]);
          yield* Effect.forEach(pending, ({ completion }) => Deferred.fail(completion, error), {
            discard: true,
          });
        },
      );
      const observeContextUpdate = Effect.fn("OpenAiVoiceProvider.observeContextUpdate")(function* (
        event: OpenAiRealtimeSocketEvent,
      ) {
        if (event.type === "closed") {
          yield* failPendingContextUpdates(
            contextUpdateError("OpenAI Realtime closed before a context update completed"),
          );
          return;
        }
        if (event.type === "error") {
          yield* failPendingContextUpdates(
            contextUpdateError("OpenAI Realtime failed during a context update", {
              cause: event.cause,
            }),
          );
          return;
        }
        const record = decodeRealtimeRecord(event.data);
        if (record === undefined) return;
        if (record.type === "conversation.item.done") {
          const item = record.item;
          const itemId =
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).id === "string"
              ? ((item as Record<string, unknown>).id as string)
              : undefined;
          if (itemId === undefined) return;
          const pending = yield* SynchronizedRef.modify(pendingContextUpdates, (current) => {
            const match = current.get(itemId);
            if (match === undefined) return [undefined, current] as const;
            const next = new Map(current);
            next.delete(itemId);
            return [match, next] as const;
          });
          if (pending !== undefined) yield* Deferred.succeed(pending.completion, undefined);
          return;
        }
        if (record.type !== "error") return;
        const error = record.error;
        const rejectedEventId =
          typeof error === "object" &&
          error !== null &&
          typeof (error as Record<string, unknown>).event_id === "string"
            ? ((error as Record<string, unknown>).event_id as string)
            : undefined;
        if (rejectedEventId === undefined) return;
        const pending = yield* SynchronizedRef.modify(pendingContextUpdates, (current) => {
          const entry = [...current.entries()].find(
            ([, candidate]) => candidate.eventId === rejectedEventId,
          );
          if (entry === undefined) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(entry[0]);
          return [entry[1], next] as const;
        });
        if (pending !== undefined) {
          yield* Deferred.fail(
            pending.completion,
            contextUpdateError("OpenAI rejected a context update", {
              retryable: false,
            }),
          );
        }
      });
      const terminated = yield* Ref.make(false);
      const terminate = Effect.gen(function* () {
        const shouldTerminate = yield* Ref.modify(
          terminated,
          (current) => [!current, true] as const,
        );
        if (!shouldTerminate) return;
        yield* failPendingTerminalActionsUpdate(
          terminalToolOutputError("OpenAI Realtime ended before terminal tools were updated"),
        );
        const terminationStartedAt = yield* Clock.currentTimeMillis;
        const result = yield* hangup.pipe(
          Effect.ensuring(Scope.close(sessionScope, Exit.void)),
          Effect.exit,
        );
        const terminationCompletedAt = yield* Clock.currentTimeMillis;
        const terminationAnnotations = {
          sessionId: input.sessionId,
          leaseGeneration: input.leaseGeneration,
          durationMs: Math.max(0, terminationCompletedAt - terminationStartedAt),
        };
        yield* result._tag === "Failure"
          ? Effect.logWarning("OpenAI Realtime termination failed", terminationAnnotations)
          : Effect.logInfo("OpenAI Realtime termination completed", terminationAnnotations);
        if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      });

      return {
        answer: {
          sessionId: input.sessionId,
          leaseGeneration: input.leaseGeneration,
          sdp: answerSdp,
        },
        events: sideband.events.pipe(
          Stream.tap((event) =>
            observeContextUpdate(event).pipe(
              Effect.andThen(observeTerminalActionsUpdate(event)),
              Effect.andThen(observeContinuationState(event)),
              Effect.andThen(observeProviderDiagnostic(event)),
            ),
          ),
          Stream.flatMap((event) => Stream.fromIterable(parseRealtimeEvent(event))),
        ),
        updateContext: (item) =>
          Effect.gen(function* () {
            const sequence = yield* Ref.getAndUpdate(contextUpdateSequence, (value) => value + 1);
            const identity = {
              eventId: `t3fe_${input.leaseGeneration.toString(36)}_${sequence.toString(36)}`,
              itemId: `t3focus_${input.leaseGeneration.toString(36)}_${sequence.toString(36)}`,
            };
            const completion = yield* Deferred.make<void, VoiceError>();
            yield* SynchronizedRef.update(pendingContextUpdates, (current) => {
              const next = new Map(current);
              next.set(identity.itemId, {
                eventId: identity.eventId,
                completion,
              });
              return next;
            });
            yield* sideband.send(encodeJson(continuationEvent(item, identity))).pipe(
              Effect.mapError((cause) =>
                contextUpdateError("OpenAI failed to send a context update", { cause }),
              ),
              Effect.andThen(
                Deferred.await(completion).pipe(
                  Effect.timeoutOption(CONTEXT_UPDATE_TIMEOUT),
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          contextUpdateError("OpenAI did not acknowledge the context update"),
                        ),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.ensuring(
                SynchronizedRef.update(pendingContextUpdates, (current) => {
                  if (!current.has(identity.itemId)) return current;
                  const next = new Map(current);
                  next.delete(identity.itemId);
                  return next;
                }),
              ),
            );
          }),
        updateTerminalActions: (actions) =>
          terminalActionsUpdateMutex.withPermits(1)(
            Effect.gen(function* () {
              const completion = yield* Deferred.make<void, VoiceError>();
              yield* continuationMutex.withPermits(1)(
                Effect.gen(function* () {
                  const state = yield* Ref.get(continuationState);
                  if (state.terminal) {
                    return yield* terminalToolOutputError(
                      "OpenAI Realtime session already accepted a terminal tool output",
                      { retryable: false },
                    );
                  }
                  yield* SynchronizedRef.set(pendingTerminalActionsUpdate, completion);
                  yield* sideband
                    .send(
                      encodeJson({
                        type: "session.update",
                        session: {
                          type: "realtime",
                          ...realtimeToolConfig({
                            terminalActions: actions,
                            // Session-stable command exposure; never re-read settings.
                            exposure: sessionExposure,
                          }),
                        },
                      }),
                    )
                    .pipe(
                      Effect.mapError((cause) =>
                        terminalToolOutputError(
                          "OpenAI failed to update terminal tool availability",
                          { cause },
                        ),
                      ),
                    );
                }),
              );
              yield* Deferred.await(completion).pipe(
                Effect.timeoutOption(CONTEXT_UPDATE_TIMEOUT),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        terminalToolOutputError(
                          "OpenAI did not acknowledge terminal tool availability",
                        ),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              );
            }).pipe(Effect.ensuring(SynchronizedRef.set(pendingTerminalActionsUpdate, null))),
          ),
        submitToolOutput: (output) =>
          continuationMutex.withPermits(1)(
            Effect.gen(function* () {
              const submitted = yield* Ref.get(submittedToolOutputs);
              const state = yield* Ref.get(continuationState);
              if (state.terminal) {
                return yield* terminalToolOutputError(
                  "OpenAI Realtime session already accepted a terminal tool output",
                  { retryable: false },
                );
              }
              if (submitted.has(output.providerFunctionCallId)) {
                yield* requestContinuationIfReady();
                return;
              }
              yield* sideband.send(
                encodeJson({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: output.providerFunctionCallId,
                    output: output.output,
                  },
                }),
              );
              yield* Ref.update(submittedToolOutputs, (current) => {
                const next = new Set(current);
                next.add(output.providerFunctionCallId);
                return next;
              });
              yield* Ref.update(continuationState, (state) => {
                const pendingFunctionCalls = new Set(state.pendingFunctionCalls);
                pendingFunctionCalls.delete(output.providerFunctionCallId);
                return {
                  ...state,
                  pendingFunctionCalls,
                  continuationNeeded: true,
                };
              });
              yield* requestContinuationIfReady();
            }),
          ),
        completeTerminalToolCall: (output) =>
          Effect.gen(function* () {
            const pending = yield* continuationMutex.withPermits(1)(
              Effect.gen(function* () {
                const submitted = yield* Ref.get(submittedToolOutputs);
                const state = yield* Ref.get(continuationState);
                if (state.terminal) {
                  if (
                    state.terminalToolCallId !== output.providerFunctionCallId ||
                    state.terminalItemId !== output.itemId
                  ) {
                    return yield* terminalToolOutputError(
                      "OpenAI Realtime session already accepted a different terminal tool output",
                      { retryable: false },
                    );
                  }
                  if (submitted.has(output.providerFunctionCallId)) return;
                  const existing = (yield* SynchronizedRef.get(pendingContextUpdates)).get(
                    output.itemId,
                  );
                  if (existing !== undefined) return existing.completion;
                } else {
                  yield* Ref.set(continuationState, {
                    ...state,
                    terminal: true,
                    terminalToolCallId: output.providerFunctionCallId,
                    terminalItemId: output.itemId,
                    continuationNeeded: false,
                    pendingFunctionCalls: new Set<string>(),
                  });
                }
                const eventId = `t3_terminal_output_${output.itemId}`;
                const completion = yield* Deferred.make<void, VoiceError>();
                yield* SynchronizedRef.update(pendingContextUpdates, (current) => {
                  const next = new Map(current);
                  next.set(output.itemId, { eventId, completion });
                  return next;
                });
                yield* sideband
                  .send(
                    encodeJson({
                      type: "conversation.item.create",
                      event_id: eventId,
                      item: {
                        id: output.itemId,
                        type: "function_call_output",
                        call_id: output.providerFunctionCallId,
                        output: output.output,
                      },
                    }),
                  )
                  .pipe(
                    Effect.tapError(() =>
                      SynchronizedRef.update(pendingContextUpdates, (current) => {
                        if (!current.has(output.itemId)) return current;
                        const next = new Map(current);
                        next.delete(output.itemId);
                        return next;
                      }),
                    ),
                  );
                return completion;
              }),
            );
            if (pending === undefined) return;
            yield* Deferred.await(pending).pipe(
              Effect.timeoutOption(TERMINAL_TOOL_OUTPUT_TIMEOUT),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      terminalToolOutputError(
                        "OpenAI did not acknowledge the terminal tool output",
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.tap(() =>
                Ref.update(submittedToolOutputs, (current) =>
                  new Set(current).add(output.providerFunctionCallId),
                ),
              ),
              Effect.ensuring(
                SynchronizedRef.update(pendingContextUpdates, (current) => {
                  if (!current.has(output.itemId)) return current;
                  const next = new Map(current);
                  next.delete(output.itemId);
                  return next;
                }),
              ),
            );
          }),
        terminate,
      };
    }),
  };

  return {
    id: "openai",
    capabilities: new Set(["transcription.request", "speech.streaming", "agent.realtime"]),
    transcriber,
    speechSynthesizer,
    realtime,
  } satisfies VoiceProviderAdapter;
});

export const OpenAiVoiceProviderLive = Layer.effect(OpenAiVoiceProvider, make).pipe(
  Layer.provide(OpenAiRealtimeSocketLive),
);

export const __testing = {
  make,
  transcriptionModel: TRANSCRIPTION_MODEL,
  speechModel: SPEECH_MODEL,
  realtimeModel: REALTIME_MODEL,
  providerSessionConfig,
  parseRealtimeEvent,
  realtimeDiagnostic,
};

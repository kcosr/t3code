import type { VoiceTranscriptionStreamEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { VoiceError } from "../../Errors.ts";
import { VoiceCredentialStore } from "../../Services/VoiceCredentialStore.ts";
import type {
  RealtimeProviderEvent,
  RealtimeVoiceProvider,
  SpeechSynthesizer,
  Transcriber,
  VoiceProviderAdapter,
} from "../../Services/VoiceProvider.ts";
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

const OpenAiTranscriptionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("transcript.text.delta"),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript.text.done"),
    text: Schema.String,
  }),
]);
const decodeOpenAiTranscriptionEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OpenAiTranscriptionEvent),
);

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "list_projects",
    description: "List T3 projects available to the current user.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_threads",
    description: "List threads in a T3 project.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["projectId", "limit"],
      additionalProperties: false,
    },
  },
  ...[
    ["get_thread_status", "Get the current status of a T3 thread."],
    ["interrupt_thread", "Interrupt the active operation in a T3 thread."],
    ["archive_thread", "Archive a T3 thread."],
  ].map(([name, description]) => ({
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
  })),
  {
    type: "function",
    name: "get_thread_messages",
    description: "Read a bounded page of normalized user and assistant messages from a T3 thread.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
      },
      required: ["threadId", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "wait_for_thread_turn",
    description:
      "Wait for the exact T3 thread turn started by send_thread_message, up to a bounded timeout.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        messageId: { type: "string" },
        waitMilliseconds: { type: "integer", minimum: 250, maximum: 25_000 },
      },
      required: ["threadId", "messageId", "waitMilliseconds"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_thread",
    description: "Create a thread in a T3 project.",
    parameters: {
      type: "object",
      properties: { projectId: { type: "string" }, title: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "send_thread_message",
    description: "Send a message to a T3 thread.",
    parameters: {
      type: "object",
      properties: { threadId: { type: "string" }, message: { type: "string" } },
      required: ["threadId", "message"],
      additionalProperties: false,
    },
  },
] as const;

const providerError = (operation: string) => (cause: unknown) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation,
    detail: "OpenAI voice request failed",
    retryable: true,
    cause,
  });

const parseRealtimeEvent = (
  event: OpenAiRealtimeSocketEvent,
): ReadonlyArray<RealtimeProviderEvent> => {
  if (event.type === "closed") return [{ type: "closed" }];
  if (event.type === "error") {
    return [{ type: "error", detail: "OpenAI Realtime sideband failed", recoverable: true }];
  }
  let value: unknown;
  try {
    value = decodeRealtimeEventJson(event.data);
  } catch {
    return [{ type: "error", detail: "OpenAI sent an invalid Realtime event", recoverable: false }];
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
            if (typeof item !== "object" || item === null) return [];
            const call = item as Record<string, unknown>;
            return call.type === "function_call" &&
              call.status === "completed" &&
              typeof call.call_id === "string" &&
              typeof call.name === "string" &&
              typeof call.arguments === "string"
              ? [
                  {
                    type: "function-call",
                    providerFunctionCallId: call.call_id,
                    name: call.name,
                    argumentsJson: call.arguments,
                  },
                ]
              : [];
          })
        : [];
      return [...calls, { type: "activity", activity: "idle" }];
    }
    case "conversation.item.input_audio_transcription.delta":
      return typeof record.delta === "string" && record.delta.length > 0
        ? [{ type: "transcript", role: "user", text: record.delta, final: false }]
        : [];
    case "conversation.item.input_audio_transcription.completed":
      return typeof record.transcript === "string" && record.transcript.length > 0
        ? [{ type: "transcript", role: "user", text: record.transcript, final: true }]
        : [];
    case "response.output_audio_transcript.delta":
      return typeof record.delta === "string" && record.delta.length > 0
        ? [{ type: "transcript", role: "assistant", text: record.delta, final: false }]
        : [];
    case "response.output_audio_transcript.done":
      return typeof record.transcript === "string" && record.transcript.length > 0
        ? [{ type: "transcript", role: "assistant", text: record.transcript, final: true }]
        : [];
    case "error": {
      const error = record.error;
      const detail =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { readonly message?: unknown }).message === "string"
          ? (error as { readonly message: string }).message
          : "OpenAI Realtime reported an error";
      return [{ type: "error", detail, recoverable: false }];
    }
    default:
      return [];
  }
};

const providerSessionConfig = (instructions: string) => ({
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
  tools: REALTIME_TOOLS,
  tool_choice: "auto",
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
    content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.text }],
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
      replayError("OpenAI Realtime failed during context replay", { cause: event.cause }),
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
  credentials.getOpenAiApiKey.pipe(
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
          const response = client
            .execute(request)
            .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
          return HttpClientResponse.stream(response).pipe(
            Stream.decodeText,
            Stream.pipeThroughChannel(Sse.decode()),
            Stream.filter(({ data }) => data !== "[DONE]"),
            Stream.mapEffect(({ data }) => decodeOpenAiTranscriptionEvent(data)),
            Stream.map(
              (data): VoiceTranscriptionStreamEvent =>
                data.type === "transcript.text.delta"
                  ? { type: "delta", requestId: input.requestId, text: data.delta }
                  : {
                      type: "final",
                      result: {
                        requestId: input.requestId,
                        text: data.text,
                        ...(input.language === undefined ? {} : { language: input.language }),
                      },
                    },
            ),
            Stream.filter(
              (event) =>
                event.type === "final" || (event.type === "delta" && event.text.length > 0),
            ),
            Stream.mapError(providerError("openai.transcribe")),
          );
        }),
      ),
  };

  const speechSynthesizer: SpeechSynthesizer = {
    synthesize: (input) =>
      Stream.unwrap(
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
          const request = yield* HttpClientRequest.post(
            `${OPENAI_API_ORIGIN}/v1/audio/speech`,
          ).pipe(
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
          return HttpClientResponse.stream(
            client.execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk)),
          ).pipe(Stream.mapError(providerError("openai.synthesize")));
        }),
      ),
  };

  const realtime: RealtimeVoiceProvider = {
    negotiate: Effect.fn("OpenAiVoiceProvider.realtime.negotiate")(function* (input) {
      const apiKey = yield* requireApiKey(credentials);
      const form = new FormData();
      form.set("sdp", input.offer.sdp);
      form.set("session", encodeJson(providerSessionConfig(input.instructions)));
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
      const sessionScope = yield* Scope.make("sequential");
      const sideband = yield* realtimeSocket
        .connect({
          url: `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(providerRealtimeCallId)}`,
          apiKey,
        })
        .pipe(
          Scope.provide(sessionScope),
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
      yield* Effect.logInfo("OpenAI Realtime context replay starting", {
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
          Ref.get(acknowledgedReplayItems).pipe(
            Effect.flatMap((acknowledgedItemCount) =>
              Effect.logWarning("OpenAI Realtime context replay failed", {
                requestedItemCount: replayItems.length,
                acknowledgedItemCount,
              }),
            ),
          ),
        ),
        abortStartup,
      );
      yield* Effect.logInfo("OpenAI Realtime context replay completed", {
        requestedItemCount: replayItems.length,
        acknowledgedItemCount,
      });

      const submittedToolOutputs = yield* Ref.make(new Set<string>());
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
            contextUpdateError("OpenAI rejected a context update", { retryable: false }),
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
        const result = yield* hangup.pipe(
          Effect.ensuring(Scope.close(sessionScope, Exit.void)),
          Effect.exit,
        );
        if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      });

      return {
        answer: {
          sessionId: input.sessionId,
          leaseGeneration: input.leaseGeneration,
          sdp: answerSdp,
        },
        events: sideband.events.pipe(
          Stream.tap(observeContextUpdate),
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
              next.set(identity.itemId, { eventId: identity.eventId, completion });
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
        submitToolOutput: (output) =>
          Effect.gen(function* () {
            const firstSubmission = yield* Ref.modify(submittedToolOutputs, (submitted) => {
              if (submitted.has(output.providerFunctionCallId)) return [false, submitted] as const;
              const next = new Set(submitted);
              next.add(output.providerFunctionCallId);
              return [true, next] as const;
            });
            if (!firstSubmission) return;
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
            yield* sideband.send(encodeJson({ type: "response.create" }));
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
};

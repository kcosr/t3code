import {
  VoiceTranscriptionStreamEvent,
  VoiceSpeechRequest,
  VoiceTranscriptionMetadata,
  type ProjectId,
  type ThreadId,
  type VoiceConfirmationDecision,
  type VoiceConfirmationId,
  type VoiceConfirmationResult,
  type VoiceCapabilities,
  type VoiceConversationClearContextResult,
  type VoiceConversationClearContextInput,
  type VoiceConversationCreateInput,
  type VoiceConversationDeleteResult,
  type VoiceConversationId,
  type VoiceConversationListPage,
  type VoiceConversationListQuery,
  type VoiceConversationSummary,
  type VoiceConversationTranscriptPage,
  type VoiceConversationTranscriptQuery,
  type VoiceConversationUpdateInput,
  type VoiceMediaTicket,
  type VoiceMediaTicketRequest,
  type VoiceSessionCloseResult,
  type VoiceSessionCreateInput,
  type VoiceSessionCreateResult,
  type VoiceSessionFocusResult,
  type VoiceSessionEventsResult,
  type VoiceSessionId,
  type VoiceSessionState,
  type VoiceTranscriptionStreamEvent as VoiceTranscriptionStreamEventType,
  type VoiceWebRtcAnswer,
  type VoiceWebRtcOffer,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  remoteHttpClientLayer,
  RemoteEnvironmentAuthFetchError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";

const DEFAULT_VOICE_HTTP_TIMEOUT_MS = 30_000;
const VOICE_TICKET_HEADER = "x-t3-voice-ticket";
const decodeTranscriptionEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VoiceTranscriptionStreamEvent),
);
const encodeTranscriptionMetadata = Schema.encodeSync(
  Schema.fromJsonString(VoiceTranscriptionMetadata),
);
const encodeSpeechRequest = Schema.encodeSync(Schema.fromJsonString(VoiceSpeechRequest));

export class VoiceHttpResponseError extends Data.TaggedError("VoiceHttpResponseError")<{
  readonly method: "POST";
  readonly requestUrl: string;
  readonly status: number;
}> {
  override get message(): string {
    return `Voice media endpoint ${this.requestUrl} returned HTTP ${this.status}.`;
  }
}

export class VoiceHttpBodyUnavailableError extends Data.TaggedError(
  "VoiceHttpBodyUnavailableError",
)<{
  readonly requestUrl: string;
}> {
  override get message(): string {
    return `Voice media endpoint ${this.requestUrl} returned no streaming body.`;
  }
}

export class VoiceHttpStreamError extends Data.TaggedError("VoiceHttpStreamError")<{
  readonly requestUrl: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not read the voice media stream from ${this.requestUrl}.`;
  }
}

export class VoiceTranscriptionDecodeError extends Data.TaggedError(
  "VoiceTranscriptionDecodeError",
)<{
  readonly requestUrl: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Voice transcription endpoint ${this.requestUrl} returned invalid NDJSON.`;
  }
}

export class VoiceUriUploadUnavailableError extends Data.TaggedError(
  "VoiceUriUploadUnavailableError",
)<{
  readonly requestUrl: string;
}> {
  override get message(): string {
    return `No native URI uploader is configured for ${this.requestUrl}.`;
  }
}

export type VoiceMediaStreamError =
  | RemoteEnvironmentRequestError
  | VoiceHttpResponseError
  | VoiceHttpBodyUnavailableError
  | VoiceHttpStreamError
  | VoiceTranscriptionDecodeError
  | VoiceUriUploadUnavailableError;

export interface VoiceUriUploadInput {
  readonly requestUrl: string;
  readonly fileUri: string;
  readonly fieldName: string;
  readonly mimeType: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly headers: Headers;
  readonly signal: AbortSignal;
}

export interface VoiceUriUploadResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface VoiceTranscriptionInput {
  readonly audio:
    | {
        readonly kind: "blob";
        readonly value: Blob;
        readonly filename: string;
      }
    | {
        readonly kind: "uri";
        readonly uri: string;
        readonly filename: string;
      };
  readonly metadata: VoiceTranscriptionMetadata;
  readonly ticket?: VoiceMediaTicket;
}

export interface VoiceSpeechInput {
  readonly request: VoiceSpeechRequest;
  readonly ticket?: VoiceMediaTicket;
}

export interface VoiceHttpClient {
  readonly createSession: (
    input: VoiceSessionCreateInput,
  ) => Effect.Effect<VoiceSessionCreateResult, RemoteEnvironmentRequestError>;
  readonly getSession: (
    sessionId: VoiceSessionId,
  ) => Effect.Effect<VoiceSessionState, RemoteEnvironmentRequestError>;
  readonly heartbeatSession: (
    sessionId: VoiceSessionId,
    leaseGeneration: number,
  ) => Effect.Effect<VoiceSessionState, RemoteEnvironmentRequestError>;
  readonly updateSessionFocus: (
    sessionId: VoiceSessionId,
    leaseGeneration: number,
    focus:
      | { readonly projectId: ProjectId; readonly threadId?: ThreadId }
      | { readonly projectId?: never; readonly threadId?: never },
  ) => Effect.Effect<VoiceSessionFocusResult, RemoteEnvironmentRequestError>;
  readonly closeSession: (
    sessionId: VoiceSessionId,
    leaseGeneration: number,
  ) => Effect.Effect<VoiceSessionCloseResult, RemoteEnvironmentRequestError>;
  readonly offerSession: (
    offer: VoiceWebRtcOffer,
  ) => Effect.Effect<VoiceWebRtcAnswer, RemoteEnvironmentRequestError>;
  readonly sessionEvents: (
    sessionId: VoiceSessionId,
    afterSequence?: number,
  ) => Effect.Effect<VoiceSessionEventsResult, RemoteEnvironmentRequestError>;
  readonly decideConfirmation: (
    sessionId: VoiceSessionId,
    confirmationId: VoiceConfirmationId,
    decision: VoiceConfirmationDecision,
  ) => Effect.Effect<VoiceConfirmationResult, RemoteEnvironmentRequestError>;
  readonly capabilities: () => Effect.Effect<VoiceCapabilities, RemoteEnvironmentRequestError>;
  readonly createConversation: (
    input: VoiceConversationCreateInput,
  ) => Effect.Effect<VoiceConversationSummary, RemoteEnvironmentRequestError>;
  readonly listConversations: (
    query?: VoiceConversationListQuery,
  ) => Effect.Effect<VoiceConversationListPage, RemoteEnvironmentRequestError>;
  readonly getConversation: (
    conversationId: VoiceConversationId,
  ) => Effect.Effect<VoiceConversationSummary, RemoteEnvironmentRequestError>;
  readonly updateConversation: (
    conversationId: VoiceConversationId,
    input: VoiceConversationUpdateInput,
  ) => Effect.Effect<VoiceConversationSummary, RemoteEnvironmentRequestError>;
  readonly getConversationTranscript: (
    conversationId: VoiceConversationId,
    query?: VoiceConversationTranscriptQuery,
  ) => Effect.Effect<VoiceConversationTranscriptPage, RemoteEnvironmentRequestError>;
  readonly deleteConversation: (
    conversationId: VoiceConversationId,
  ) => Effect.Effect<VoiceConversationDeleteResult, RemoteEnvironmentRequestError>;
  readonly clearConversationContext: (
    conversationId: VoiceConversationId,
    input: VoiceConversationClearContextInput,
  ) => Effect.Effect<VoiceConversationClearContextResult, RemoteEnvironmentRequestError>;
  readonly createMediaTicket: (
    input: VoiceMediaTicketRequest,
  ) => Effect.Effect<VoiceMediaTicket, RemoteEnvironmentRequestError>;
  readonly transcribe: (
    input: VoiceTranscriptionInput,
  ) => Stream.Stream<VoiceTranscriptionStreamEventType, VoiceMediaStreamError>;
  readonly synthesize: (
    input: VoiceSpeechInput,
  ) => Stream.Stream<Uint8Array, VoiceMediaStreamError>;
}

export interface MakeVoiceHttpClientInput {
  readonly prepared: PreparedConnection;
  readonly fetch: typeof globalThis.fetch;
  readonly uploadUri?: (input: VoiceUriUploadInput) => Promise<VoiceUriUploadResult>;
  readonly signer?: ManagedRelayDpopSigner["Service"];
  readonly timeoutMs?: number;
}

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

const controlRequest = <A, E>(input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly fetch: typeof globalThis.fetch;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly pathname: string;
  readonly search?: string;
  readonly timeoutMs: number;
  readonly run: (
    client: EnvironmentHttpClient,
    headers: { readonly authorization?: string; readonly dpop?: string },
  ) => Effect.Effect<A, E, HttpClient.HttpClient>;
}): Effect.Effect<A, RemoteEnvironmentRequestError> => {
  const endpoint = new URL(environmentEndpointUrl(input.prepared.httpBaseUrl, input.pathname));
  if (input.search !== undefined) endpoint.search = input.search;
  const requestUrl = endpoint.toString();
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      input.method,
      requestUrl,
      input.signer,
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs,
      withEnvironmentCredentials(input.prepared.httpAuthorization, input.run(client, headers)),
    );
  }).pipe(Effect.provide(remoteHttpClientLayer(input.fetch)));
};

const rawHeaders = Effect.fn("VoiceHttpClient.rawHeaders")(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly requestUrl: string;
  readonly ticket?: VoiceMediaTicket;
}) {
  if (input.ticket !== undefined) {
    return { [VOICE_TICKET_HEADER]: input.ticket.token };
  }
  return yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    input.requestUrl,
    input.signer,
  );
});

const mediaRequestHeaders = Effect.fn("VoiceHttpClient.mediaRequestHeaders")(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly requestUrl: string;
  readonly ticket?: VoiceMediaTicket;
  readonly contentType?: string;
}) {
  const authorization = yield* rawHeaders(input);
  const headers = new Headers();
  if ("authorization" in authorization && authorization.authorization !== undefined) {
    headers.set("authorization", authorization.authorization);
  }
  if ("dpop" in authorization && authorization.dpop !== undefined) {
    headers.set("dpop", authorization.dpop);
  }
  if (VOICE_TICKET_HEADER in authorization) {
    headers.set(VOICE_TICKET_HEADER, authorization[VOICE_TICKET_HEADER]);
  }
  if (input.contentType !== undefined) {
    headers.set("content-type", input.contentType);
  }
  return headers;
});

const fetchMediaResponse = (input: {
  readonly prepared: PreparedConnection;
  readonly fetch: typeof globalThis.fetch;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs: number;
  readonly requestUrl: string;
  readonly ticket?: VoiceMediaTicket;
  readonly send: (headers: Headers, signal: AbortSignal) => Promise<Response>;
  readonly contentType?: string;
}): Effect.Effect<Response, RemoteEnvironmentRequestError | VoiceHttpResponseError> =>
  Effect.gen(function* () {
    const headers = yield* mediaRequestHeaders(input);
    const response = yield* executeEnvironmentHttpRequest(
      input.requestUrl,
      input.timeoutMs,
      Effect.tryPromise({
        try: (signal) => input.send(headers, signal),
        catch: (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: `Failed to fetch voice media endpoint ${input.requestUrl}.`,
            cause,
          }),
      }),
    );
    if (!response.ok) {
      return yield* new VoiceHttpResponseError({
        method: "POST",
        requestUrl: input.requestUrl,
        status: response.status,
      });
    }
    return response;
  });

const uploadUriMediaResponse = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs: number;
  readonly requestUrl: string;
  readonly ticket?: VoiceMediaTicket;
  readonly upload: (headers: Headers, signal: AbortSignal) => Promise<VoiceUriUploadResult>;
}): Effect.Effect<VoiceUriUploadResult, RemoteEnvironmentRequestError | VoiceHttpResponseError> =>
  Effect.gen(function* () {
    const headers = yield* mediaRequestHeaders(input);
    const response = yield* executeEnvironmentHttpRequest(
      input.requestUrl,
      input.timeoutMs,
      Effect.tryPromise({
        try: (signal) => input.upload(headers, signal),
        catch: (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: `Failed to upload voice media to ${input.requestUrl}.`,
            cause,
          }),
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceHttpResponseError({
        method: "POST",
        requestUrl: input.requestUrl,
        status: response.status,
      });
    }
    return response;
  });

const responseByteStream = (
  response: Response,
  requestUrl: string,
): Stream.Stream<Uint8Array, VoiceHttpBodyUnavailableError | VoiceHttpStreamError> => {
  if (response.body === null) {
    return Stream.fail(new VoiceHttpBodyUnavailableError({ requestUrl }));
  }
  return Stream.fromReadableStream({
    evaluate: () => response.body!,
    onError: (cause) => new VoiceHttpStreamError({ requestUrl, cause }),
  });
};

const decodeTranscriptionLines = <E>(lines: Stream.Stream<string, E>, requestUrl: string) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.mapEffect((line) =>
      decodeTranscriptionEvent(line).pipe(
        Effect.mapError((cause) => new VoiceTranscriptionDecodeError({ requestUrl, cause })),
      ),
    ),
  );

export const makeVoiceHttpClient = (input: MakeVoiceHttpClientInput): VoiceHttpClient => {
  const signer = Option.fromNullishOr(input.signer);
  const timeoutMs = input.timeoutMs ?? DEFAULT_VOICE_HTTP_TIMEOUT_MS;
  const control = <A, E>(request: {
    readonly method: "GET" | "POST" | "PATCH" | "DELETE";
    readonly pathname: string;
    readonly search?: string;
    readonly run: (
      client: EnvironmentHttpClient,
      headers: { readonly authorization?: string; readonly dpop?: string },
    ) => Effect.Effect<A, E, HttpClient.HttpClient>;
  }) =>
    controlRequest({
      prepared: input.prepared,
      signer,
      fetch: input.fetch,
      timeoutMs,
      ...request,
    });

  return {
    createSession: (payload) =>
      control({
        method: "POST",
        pathname: "/api/voice/sessions",
        run: (client, headers) => client.voice.createSession({ headers, payload }),
      }),
    getSession: (sessionId) =>
      control({
        method: "GET",
        pathname: `/api/voice/sessions/${sessionId}`,
        run: (client, headers) => client.voice.getSession({ headers, params: { sessionId } }),
      }),
    heartbeatSession: (sessionId, leaseGeneration) =>
      control({
        method: "POST",
        pathname: `/api/voice/sessions/${sessionId}/heartbeat`,
        run: (client, headers) =>
          client.voice.heartbeatSession({
            headers,
            params: { sessionId },
            payload: { leaseGeneration },
          }),
      }),
    updateSessionFocus: (sessionId, leaseGeneration, focus) =>
      control({
        method: "POST",
        pathname: `/api/voice/sessions/${sessionId}/focus`,
        run: (client, headers) =>
          focus.projectId === undefined
            ? client.voice.updateSessionFocus({
                headers,
                params: { sessionId },
                payload: { leaseGeneration },
              })
            : client.voice.updateSessionFocus({
                headers,
                params: { sessionId },
                payload: {
                  leaseGeneration,
                  projectId: focus.projectId,
                  ...(focus.threadId === undefined ? {} : { threadId: focus.threadId }),
                },
              }),
      }),
    closeSession: (sessionId, leaseGeneration) =>
      control({
        method: "DELETE",
        pathname: `/api/voice/sessions/${sessionId}`,
        run: (client, headers) =>
          client.voice.closeSession({
            headers,
            params: { sessionId },
            payload: { leaseGeneration },
          }),
      }),
    offerSession: (payload) =>
      control({
        method: "POST",
        pathname: `/api/voice/sessions/${payload.sessionId}/webrtc-offer`,
        run: (client, headers) =>
          client.voice.offerSession({
            headers,
            params: { sessionId: payload.sessionId },
            payload,
          }),
      }),
    sessionEvents: (sessionId, afterSequence) =>
      control({
        method: "GET",
        pathname: `/api/voice/sessions/${sessionId}/events`,
        ...(afterSequence === undefined
          ? {}
          : {
              search: `afterSequence=${afterSequence}&waitMilliseconds=20000`,
            }),
        run: (client, headers) =>
          client.voice.sessionEvents({
            headers,
            params: { sessionId },
            query: afterSequence === undefined ? {} : { afterSequence, waitMilliseconds: 20_000 },
          }),
      }),
    decideConfirmation: (sessionId, confirmationId, decision) =>
      control({
        method: "POST",
        pathname: `/api/voice/sessions/${sessionId}/confirmations/${confirmationId}`,
        run: (client, headers) =>
          client.voice.decideVoiceConfirmation({
            headers,
            params: { sessionId, confirmationId },
            payload: { decision },
          }),
      }),
    capabilities: () =>
      control({
        method: "GET",
        pathname: "/api/voice/capabilities",
        run: (client, headers) => client.voice.capabilities({ headers }),
      }),
    createConversation: (payload) =>
      control({
        method: "POST",
        pathname: "/api/voice/conversations",
        run: (client, headers) => client.voice.createConversation({ headers, payload }),
      }),
    listConversations: (query = {}) => {
      const search = new URLSearchParams();
      if (query.cursor !== undefined) search.set("cursor", query.cursor);
      if (query.limit !== undefined) search.set("limit", String(query.limit));
      return control({
        method: "GET",
        pathname: "/api/voice/conversations",
        ...(search.size === 0 ? {} : { search: search.toString() }),
        run: (client, headers) => client.voice.listConversations({ headers, query }),
      });
    },
    getConversation: (conversationId) =>
      control({
        method: "GET",
        pathname: `/api/voice/conversations/${conversationId}`,
        run: (client, headers) =>
          client.voice.getConversation({ headers, params: { conversationId } }),
      }),
    updateConversation: (conversationId, payload) =>
      control({
        method: "PATCH",
        pathname: `/api/voice/conversations/${conversationId}`,
        run: (client, headers) =>
          client.voice.updateConversation({ headers, params: { conversationId }, payload }),
      }),
    getConversationTranscript: (conversationId, query = {}) => {
      const search = new URLSearchParams();
      if (query.cursor !== undefined) search.set("cursor", query.cursor);
      if (query.limit !== undefined) search.set("limit", String(query.limit));
      const suffix = search.size === 0 ? "" : `?${search.toString()}`;
      return control({
        method: "GET",
        pathname: `/api/voice/conversations/${conversationId}/transcript`,
        ...(suffix === "" ? {} : { search: suffix.slice(1) }),
        run: (client, headers) =>
          client.voice.getConversationTranscript({
            headers,
            params: { conversationId },
            query,
          }),
      });
    },
    deleteConversation: (conversationId) =>
      control({
        method: "DELETE",
        pathname: `/api/voice/conversations/${conversationId}`,
        run: (client, headers) =>
          client.voice.deleteConversation({
            headers,
            params: { conversationId },
          }),
      }),
    clearConversationContext: (conversationId, payload) =>
      control({
        method: "POST",
        pathname: `/api/voice/conversations/${conversationId}/clear-context`,
        run: (client, headers) =>
          client.voice.clearConversationContext({
            headers,
            params: { conversationId },
            payload,
          }),
      }),
    createMediaTicket: (payload) =>
      control({
        method: "POST",
        pathname: "/api/voice/media-tickets",
        run: (client, headers) => client.voice.mediaTicket({ headers, payload }),
      }),
    transcribe: (request) => {
      const requestUrl = environmentEndpointUrl(
        input.prepared.httpBaseUrl,
        "/api/voice/transcriptions",
      );
      const metadata = encodeTranscriptionMetadata(request.metadata);
      if (request.audio.kind === "uri") {
        if (input.uploadUri === undefined) {
          return Stream.fail(new VoiceUriUploadUnavailableError({ requestUrl }));
        }
        const audio = request.audio;
        return Stream.unwrap(
          uploadUriMediaResponse({
            prepared: input.prepared,
            signer,
            timeoutMs,
            requestUrl,
            upload: (headers, signal) =>
              input.uploadUri!({
                requestUrl,
                fileUri: audio.uri,
                fieldName: "audio",
                mimeType: request.metadata.format,
                parameters: { metadata },
                headers,
                signal,
              }),
            ...(request.ticket === undefined ? {} : { ticket: request.ticket }),
          }).pipe(
            Effect.map((response) =>
              decodeTranscriptionLines(
                Stream.fromIterable(response.body.split(/\r?\n/u)),
                requestUrl,
              ),
            ),
          ),
        );
      }
      const body = new FormData();
      body.append("audio", request.audio.value, request.audio.filename);
      body.append("metadata", metadata);
      return Stream.unwrap(
        fetchMediaResponse({
          prepared: input.prepared,
          fetch: input.fetch,
          signer,
          timeoutMs,
          requestUrl,
          send: (headers, signal) =>
            input.fetch(requestUrl, {
              method: "POST",
              headers,
              body,
              signal,
              ...(input.prepared.httpAuthorization === null && request.ticket === undefined
                ? { credentials: "include" as const }
                : {}),
            }),
          ...(request.ticket === undefined ? {} : { ticket: request.ticket }),
        }).pipe(
          Effect.map((response) =>
            decodeTranscriptionLines(
              responseByteStream(response, requestUrl).pipe(Stream.decodeText, Stream.splitLines),
              requestUrl,
            ),
          ),
        ),
      );
    },
    synthesize: (request) => {
      const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/voice/speech");
      const body = encodeSpeechRequest(request.request);
      return Stream.unwrap(
        fetchMediaResponse({
          prepared: input.prepared,
          fetch: input.fetch,
          signer,
          timeoutMs,
          requestUrl,
          send: (headers, signal) =>
            input.fetch(requestUrl, {
              method: "POST",
              headers,
              body,
              signal,
              ...(input.prepared.httpAuthorization === null && request.ticket === undefined
                ? { credentials: "include" as const }
                : {}),
            }),
          contentType: "application/json",
          ...(request.ticket === undefined ? {} : { ticket: request.ticket }),
        }).pipe(Effect.map((response) => responseByteStream(response, requestUrl))),
      );
    },
  };
};

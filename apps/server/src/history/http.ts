import {
  AuthOrchestrationReadScope,
  AuthVoiceUseScope,
  EnvironmentHistoryPrivacyBoundary,
  EnvironmentHistoryRequestError,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type EnvironmentResourceNotFoundError,
  type HistoryReadInput,
  type HistoryRequestInvalidReason,
  type HistorySearchInput,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";

import {
  currentEnvironmentTraceId,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import {
  HistorySearchService,
  type HistorySearchServiceError,
} from "./Services/HistorySearchService.ts";

const appendPrivateHistoryResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "cache-control": "no-store",
        pragma: "no-cache",
      }),
    ),
);

export const historyPrivacyBoundaryLayer = Layer.succeed(
  EnvironmentHistoryPrivacyBoundary,
  (httpEffect, { endpoint }) =>
    Effect.gen(function* () {
      yield* appendPrivateHistoryResponseHeaders;
      const traceId = yield* currentEnvironmentTraceId;
      yield* Effect.addFinalizer((exit) =>
        exit._tag === "Failure"
          ? Effect.logWarning("history api request failed", {
              endpoint: endpoint.name,
              traceId,
              errorTag: causeErrorTag(exit.cause),
            })
          : Effect.void,
      );
      yield* Effect.annotateLogsScoped({
        "history.endpoint": endpoint.name,
        traceId,
      });
      yield* Effect.annotateCurrentSpan({ "history.endpoint": endpoint.name });
      return yield* httpEffect.pipe(
        Effect.catchIf(HttpApiSchemaError.is, () => failHistoryInvalid("invalid_filters")),
      );
    }),
);

const annotateHistoryRequest = (input: {
  readonly endpoint: string;
  readonly sources: ReadonlyArray<"thread-message" | "voice-entry">;
  readonly hasProjectFilter: boolean;
  readonly hasThreadFilter: boolean;
  readonly hasVoiceScope: boolean;
  readonly hasCursor: boolean;
}) =>
  Effect.gen(function* () {
    yield* Effect.annotateLogsScoped({
      "history.endpoint": input.endpoint,
      "history.sourceCount": input.sources.length,
      "history.hasProjectFilter": input.hasProjectFilter,
      "history.hasThreadFilter": input.hasThreadFilter,
      "history.hasVoiceScope": input.hasVoiceScope,
      "history.hasCursor": input.hasCursor,
    });
    yield* Effect.annotateCurrentSpan({
      "history.endpoint": input.endpoint,
      "history.sourceCount": input.sources.length,
      "history.hasProjectFilter": input.hasProjectFilter,
      "history.hasThreadFilter": input.hasThreadFilter,
      "history.hasVoiceScope": input.hasVoiceScope,
      "history.hasCursor": input.hasCursor,
    });
  });

const failHistoryInvalid = (reason: HistoryRequestInvalidReason) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentHistoryRequestError({
          code: "history_request_invalid",
          reason,
          traceId,
        }),
      ),
    ),
  );

type HistoryHttpOperationError =
  | EnvironmentHistoryRequestError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError;

const mapHistoryError = (
  operation: "search" | "read",
  error: HistorySearchServiceError,
): Effect.Effect<never, HistoryHttpOperationError> => {
  switch (error._tag) {
    case "HistoryInvalidRequestError":
      return failHistoryInvalid(error.reason);
    case "HistoryItemNotFoundError":
      return failEnvironmentNotFound("history_item_not_found");
    case "HistorySearchUnavailableError":
      return failEnvironmentInternal(
        operation === "search" ? "history_search_failed" : "history_read_failed",
      );
  }
};

const requireSearchScopes = Effect.fn("environment.history.requireSearchScopes")(function* (
  input: HistorySearchInput,
) {
  const requiresThreads = input.sources.includes("thread-message");
  const requiresVoice = input.sources.includes("voice-entry");
  const principal = requiresThreads
    ? yield* requireEnvironmentScope(AuthOrchestrationReadScope)
    : yield* requireEnvironmentScope(AuthVoiceUseScope);
  if (requiresVoice) yield* requireEnvironmentScope(AuthVoiceUseScope);
  return principal;
});

const requireReadScope = Effect.fn("environment.history.requireReadScope")(function* (
  input: HistoryReadInput,
) {
  return yield* requireEnvironmentScope(
    input.ref.type === "thread-message" ? AuthOrchestrationReadScope : AuthVoiceUseScope,
  );
});

export const historyHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "history",
  Effect.fnUntraced(function* (handlers) {
    const history = yield* HistorySearchService;

    return handlers
      .handle(
        "search",
        Effect.fn("environment.history.search")(function* (args) {
          yield* annotateHistoryRequest({
            endpoint: args.endpoint.name,
            sources: args.payload.sources,
            hasProjectFilter: args.payload.projectId !== undefined,
            hasThreadFilter: args.payload.threadId !== undefined,
            hasVoiceScope: args.payload.voiceScope !== undefined,
            hasCursor: args.payload.cursor !== undefined,
          });
          const principal = yield* requireSearchScopes(args.payload);
          const uniqueSources = new Set(args.payload.sources);
          if (uniqueSources.size !== args.payload.sources.length) {
            return yield* failHistoryInvalid("invalid_filters");
          }
          const searchesThreads = uniqueSources.has("thread-message");
          const searchesVoice = uniqueSources.has("voice-entry");
          if (
            (!searchesThreads &&
              (args.payload.projectId !== undefined || args.payload.threadId !== undefined)) ||
            (searchesVoice && args.payload.voiceScope === undefined) ||
            (!searchesVoice && args.payload.voiceScope !== undefined)
          ) {
            return yield* failHistoryInvalid("invalid_filters");
          }
          return yield* history
            .search({ sessionId: principal.sessionId, scopes: principal.scopes }, args.payload)
            .pipe(Effect.catch((error) => mapHistoryError("search", error)));
        }),
      )
      .handle(
        "readHistory",
        Effect.fn("environment.history.read")(function* (args) {
          yield* annotateHistoryRequest({
            endpoint: args.endpoint.name,
            sources: [args.payload.ref.type],
            hasProjectFilter: args.payload.ref.type === "thread-message",
            hasThreadFilter: args.payload.ref.type === "thread-message",
            hasVoiceScope: args.payload.voiceScope !== undefined,
            hasCursor: false,
          });
          const principal = yield* requireReadScope(args.payload);
          if (
            (args.payload.ref.type === "thread-message" && args.payload.voiceScope !== undefined) ||
            (args.payload.ref.type === "voice-entry" && args.payload.voiceScope === undefined) ||
            (args.payload.ref.type === "voice-entry" &&
              args.payload.voiceScope?.type === "conversation" &&
              args.payload.voiceScope.conversationId !== args.payload.ref.conversationId)
          ) {
            return yield* failEnvironmentNotFound("history_item_not_found");
          }
          return yield* history
            .read({ sessionId: principal.sessionId, scopes: principal.scopes }, args.payload)
            .pipe(Effect.catch((error) => mapHistoryError("read", error)));
        }),
      );
  }),
);

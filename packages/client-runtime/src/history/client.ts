import type {
  HistoryReadInput,
  HistoryReadResult,
  HistorySearchInput,
  HistorySearchPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  remoteHttpClientLayer,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";

const DEFAULT_HISTORY_HTTP_TIMEOUT_MS = 30_000;

export interface HistoryHttpClient {
  readonly search: (
    input: HistorySearchInput,
  ) => Effect.Effect<HistorySearchPage, RemoteEnvironmentRequestError>;
  readonly read: (
    input: HistoryReadInput,
  ) => Effect.Effect<HistoryReadResult, RemoteEnvironmentRequestError>;
}

export interface MakeHistoryHttpClientInput {
  readonly prepared: PreparedConnection;
  readonly fetch: typeof globalThis.fetch;
  readonly signer?: ManagedRelayDpopSigner["Service"];
  readonly timeoutMs?: number;
}

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

export const makeHistoryHttpClient = (input: MakeHistoryHttpClientInput): HistoryHttpClient => {
  const signer = Option.fromNullishOr(input.signer);
  const timeoutMs = input.timeoutMs ?? DEFAULT_HISTORY_HTTP_TIMEOUT_MS;

  const post = <A, E>(request: {
    readonly pathname: "/api/history/search" | "/api/history/read";
    readonly run: (
      client: EnvironmentHttpClient,
      headers: { readonly authorization?: string; readonly dpop?: string },
    ) => Effect.Effect<A, E, HttpClient.HttpClient>;
  }): Effect.Effect<A, RemoteEnvironmentRequestError> => {
    const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, request.pathname);
    return Effect.gen(function* () {
      const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
      const headers = yield* buildEnvironmentAuthHeaders(
        input.prepared.httpAuthorization,
        "POST",
        requestUrl,
        signer,
      );
      return yield* executeEnvironmentHttpRequest(
        requestUrl,
        timeoutMs,
        withEnvironmentCredentials(input.prepared.httpAuthorization, request.run(client, headers)),
      );
    }).pipe(Effect.provide(remoteHttpClientLayer(input.fetch)));
  };

  return {
    search: (payload) =>
      post({
        pathname: "/api/history/search",
        run: (client, headers) => client.history.search({ headers, payload }),
      }),
    read: (payload) =>
      post({
        pathname: "/api/history/read",
        run: (client, headers) => client.history.readHistory({ headers, payload }),
      }),
  };
};

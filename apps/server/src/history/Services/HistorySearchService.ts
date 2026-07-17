import {
  AuthSessionId,
  HistoryReadInput,
  HistoryReadResult,
  HistoryRequestInvalidReason,
  HistorySearchInput,
  HistorySearchPage,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface HistoryPrincipal {
  readonly sessionId: AuthSessionId;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
}

export class HistoryInvalidRequestError extends Schema.TaggedErrorClass<HistoryInvalidRequestError>()(
  "HistoryInvalidRequestError",
  { reason: HistoryRequestInvalidReason },
) {}

export class HistoryItemNotFoundError extends Schema.TaggedErrorClass<HistoryItemNotFoundError>()(
  "HistoryItemNotFoundError",
  {},
) {}

export class HistorySearchUnavailableError extends Schema.TaggedErrorClass<HistorySearchUnavailableError>()(
  "HistorySearchUnavailableError",
  {
    operation: Schema.Literals(["search", "read"]),
    cause: Schema.Defect(),
  },
) {}

export type HistorySearchServiceError =
  | HistoryInvalidRequestError
  | HistoryItemNotFoundError
  | HistorySearchUnavailableError;

export interface HistorySearchServiceShape {
  readonly search: (
    principal: HistoryPrincipal,
    input: HistorySearchInput,
  ) => Effect.Effect<HistorySearchPage, HistorySearchServiceError>;
  readonly read: (
    principal: HistoryPrincipal,
    input: HistoryReadInput,
  ) => Effect.Effect<HistoryReadResult, HistorySearchServiceError>;
}

export class HistorySearchService extends Context.Service<
  HistorySearchService,
  HistorySearchServiceShape
>()("t3/history/Services/HistorySearchService") {}

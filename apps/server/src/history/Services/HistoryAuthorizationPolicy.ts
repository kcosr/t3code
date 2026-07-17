import {
  AuthOrchestrationReadScope,
  AuthVoiceUseScope,
  type HistoryReadInput,
  type HistorySearchInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { HistoryPrincipal } from "./HistorySearchService.ts";

export interface HistoryAuthorizationPolicyShape {
  readonly authorizeSearch: (
    principal: HistoryPrincipal,
    input: HistorySearchInput,
  ) => Effect.Effect<boolean>;
  readonly authorizeRead: (
    principal: HistoryPrincipal,
    input: HistoryReadInput,
  ) => Effect.Effect<boolean>;
}

export class HistoryAuthorizationPolicy extends Context.Service<
  HistoryAuthorizationPolicy,
  HistoryAuthorizationPolicyShape
>()("t3/history/Services/HistoryAuthorizationPolicy") {}

export const environmentHistoryAuthorizationPolicy: HistoryAuthorizationPolicyShape = {
  authorizeSearch: (principal, input) =>
    Effect.succeed(
      (!input.sources.includes("thread-message") ||
        principal.scopes.has(AuthOrchestrationReadScope)) &&
        (!input.sources.includes("voice-entry") || principal.scopes.has(AuthVoiceUseScope)),
    ),
  authorizeRead: (principal, input) =>
    Effect.succeed(
      input.ref.type === "thread-message"
        ? principal.scopes.has(AuthOrchestrationReadScope)
        : principal.scopes.has(AuthVoiceUseScope),
    ),
};

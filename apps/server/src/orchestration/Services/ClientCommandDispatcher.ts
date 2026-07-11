import type {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ClientCommandNormalizationError extends Schema.TaggedErrorClass<ClientCommandNormalizationError>()(
  "ClientCommandNormalizationError",
  { cause: Schema.Defect() },
) {}

export type ClientCommandDispatcherError =
  | ClientCommandNormalizationError
  | OrchestrationDispatchCommandError;

export interface ClientCommandDispatcherShape {
  readonly dispatch: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<DispatchResult, ClientCommandDispatcherError>;
}

export class ClientCommandDispatcher extends Context.Service<
  ClientCommandDispatcher,
  ClientCommandDispatcherShape
>()("t3/orchestration/Services/ClientCommandDispatcher") {}

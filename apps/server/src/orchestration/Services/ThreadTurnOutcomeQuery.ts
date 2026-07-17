import type { MessageId, OrchestrationMessageTurnResult, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export type ThreadTurnOutcomeLookup =
  | { readonly type: "thread-not-found" }
  | { readonly type: "message-not-found" }
  | {
      readonly type: "found";
      readonly result: OrchestrationMessageTurnResult;
    };

export interface ThreadTurnOutcomeQueryShape {
  readonly getByMessageId: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<ThreadTurnOutcomeLookup, ProjectionRepositoryError>;
}

/**
 * Resolves a dispatched user message to its exact projected turn outcome.
 *
 * Missing threads and messages remain distinct so callers do not poll an
 * arbitrary message identifier forever. A `pending` result means the exact
 * user message exists but its turn start has not projected yet.
 */
export class ThreadTurnOutcomeQuery extends Context.Service<
  ThreadTurnOutcomeQuery,
  ThreadTurnOutcomeQueryShape
>()("t3/orchestration/Services/ThreadTurnOutcomeQuery") {}

import { IsoDateTime, MessageId, NonNegativeInt, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { ProjectionTurnStartState } from "./ProjectionTurnStarts.ts";
import { ProjectionTurnState } from "./ProjectionTurns.ts";

export const GetProjectionThreadTurnOutcomeInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionThreadTurnOutcomeInput = typeof GetProjectionThreadTurnOutcomeInput.Type;

export const GetProjectionSettledAssistantInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  messageId: MessageId,
});
export type GetProjectionSettledAssistantInput = typeof GetProjectionSettledAssistantInput.Type;

/**
 * Narrow snapshot used by exact message/turn polling.
 *
 * The repository resolves thread and user-message validity in the same read as
 * turn correlation so each poll observes one database snapshot without loading
 * thread configuration, message bodies, attachments, or checkpoint metadata.
 */
export const ProjectionThreadTurnOutcome = Schema.Struct({
  threadExists: Schema.Boolean,
  messageExists: Schema.Boolean,
  latestTurnId: Schema.NullOr(TurnId),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  startState: Schema.NullOr(ProjectionTurnStartState),
  turnId: Schema.NullOr(TurnId),
  turnState: Schema.NullOr(ProjectionTurnState),
  assistantMessageId: Schema.NullOr(MessageId),
});
export type ProjectionThreadTurnOutcome = typeof ProjectionThreadTurnOutcome.Type;

export const ProjectionSettledAssistant = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  truncated: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionSettledAssistant = typeof ProjectionSettledAssistant.Type;

export interface ProjectionThreadTurnOutcomeRepositoryShape {
  readonly getByMessageId: (
    input: GetProjectionThreadTurnOutcomeInput,
  ) => Effect.Effect<ProjectionThreadTurnOutcome, ProjectionRepositoryError>;
  readonly getSettledAssistant: (
    input: GetProjectionSettledAssistantInput,
  ) => Effect.Effect<Option.Option<ProjectionSettledAssistant>, ProjectionRepositoryError>;
}

export class ProjectionThreadTurnOutcomeRepository extends Context.Service<
  ProjectionThreadTurnOutcomeRepository,
  ProjectionThreadTurnOutcomeRepositoryShape
>()("t3/persistence/Services/ProjectionThreadTurnOutcomes/ProjectionThreadTurnOutcomeRepository") {}

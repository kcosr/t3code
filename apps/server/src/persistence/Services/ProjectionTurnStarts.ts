import {
  IsoDateTime,
  MessageId,
  OrchestrationProposedPlanId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { ProjectionTurnById } from "./ProjectionTurns.ts";

export const ProjectionTurnStartState = Schema.Literals([
  "pending",
  "submitting",
  "accepted",
  "failed",
  "ambiguous",
]);
export type ProjectionTurnStartState = typeof ProjectionTurnStartState.Type;

export const ProjectionTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  state: ProjectionTurnStartState,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  requestedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTurnStart = typeof ProjectionTurnStart.Type;

export const ProjectionTurnStartOutcome = Schema.Struct({
  start: ProjectionTurnStart,
  turn: Schema.NullOr(ProjectionTurnById),
});
export type ProjectionTurnStartOutcome = typeof ProjectionTurnStartOutcome.Type;

export const GetProjectionTurnStartByMessageIdInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionTurnStartByMessageIdInput =
  typeof GetProjectionTurnStartByMessageIdInput.Type;

export const GetProjectionTurnStartByTurnIdInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetProjectionTurnStartByTurnIdInput = typeof GetProjectionTurnStartByTurnIdInput.Type;

export const DeleteProjectionTurnStartsByThreadInput = Schema.Struct({ threadId: ThreadId });
export type DeleteProjectionTurnStartsByThreadInput =
  typeof DeleteProjectionTurnStartsByThreadInput.Type;

export interface ProjectionTurnStartRepositoryShape {
  readonly upsert: (row: ProjectionTurnStart) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByMessageId: (
    input: GetProjectionTurnStartByMessageIdInput,
  ) => Effect.Effect<Option.Option<ProjectionTurnStart>, ProjectionRepositoryError>;
  readonly getOutcomeByMessageId: (
    input: GetProjectionTurnStartByMessageIdInput,
  ) => Effect.Effect<Option.Option<ProjectionTurnStartOutcome>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: DeleteProjectionTurnStartsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurnStart>, ProjectionRepositoryError>;
  readonly listUnresolved: () => Effect.Effect<
    ReadonlyArray<ProjectionTurnStart>,
    ProjectionRepositoryError
  >;
  readonly getEarliestByTurnId: (
    input: GetProjectionTurnStartByTurnIdInput,
  ) => Effect.Effect<Option.Option<ProjectionTurnStart>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionTurnStartsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTurnStartRepository extends Context.Service<
  ProjectionTurnStartRepository,
  ProjectionTurnStartRepositoryShape
>()("t3/persistence/Services/ProjectionTurnStarts/ProjectionTurnStartRepository") {}

import { VoiceHandoffFailureReason, VoiceHandoffFailureStage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const VoiceHandoffActionStatus = Schema.Literals([
  "prepared",
  "pending",
  "settled",
  "expired",
]);
export type VoiceHandoffActionStatus = typeof VoiceHandoffActionStatus.Type;

export const VoiceHandoffActionOutcome = Schema.Literals(["succeeded", "failed"]);
export type VoiceHandoffActionOutcome = typeof VoiceHandoffActionOutcome.Type;

export const DurableVoiceHandoffAction = Schema.Struct({
  actionId: Schema.String,
  authSessionId: Schema.String,
  realtimeSessionId: Schema.String,
  realtimeGeneration: Schema.Number,
  conversationId: Schema.String,
  contextEpoch: Schema.Number,
  projectId: Schema.String,
  threadId: Schema.String,
  autoRearm: Schema.Boolean,
  status: VoiceHandoffActionStatus,
  outcome: Schema.NullOr(VoiceHandoffActionOutcome),
  outcomeState: Schema.NullOr(Schema.String),
  outcomeStage: Schema.NullOr(VoiceHandoffFailureStage),
  outcomeReason: Schema.NullOr(VoiceHandoffFailureReason),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
});
export type DurableVoiceHandoffAction = typeof DurableVoiceHandoffAction.Type;

export const VoiceHandoffActionIdentity = Schema.Struct({
  actionId: Schema.String,
  authSessionId: Schema.String,
  realtimeSessionId: Schema.String,
  realtimeGeneration: Schema.Number,
  conversationId: Schema.String,
  contextEpoch: Schema.Number,
  projectId: Schema.String,
  threadId: Schema.String,
  autoRearm: Schema.Boolean,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type VoiceHandoffActionIdentity = typeof VoiceHandoffActionIdentity.Type;

export const VoiceHandoffActionResult = Schema.Struct({
  outcome: VoiceHandoffActionOutcome,
  outcomeState: Schema.NullOr(Schema.String),
  outcomeStage: Schema.NullOr(VoiceHandoffFailureStage),
  outcomeReason: Schema.NullOr(VoiceHandoffFailureReason),
});
export type VoiceHandoffActionResult = typeof VoiceHandoffActionResult.Type;

export class VoiceHandoffActionConflictError extends Schema.TaggedErrorClass<VoiceHandoffActionConflictError>()(
  "VoiceHandoffActionConflictError",
  { actionId: Schema.String, operation: Schema.String },
) {}

export class VoiceHandoffActionOwnershipError extends Schema.TaggedErrorClass<VoiceHandoffActionOwnershipError>()(
  "VoiceHandoffActionOwnershipError",
  { actionId: Schema.String },
) {}

export class VoiceHandoffActionNotFoundError extends Schema.TaggedErrorClass<VoiceHandoffActionNotFoundError>()(
  "VoiceHandoffActionNotFoundError",
  { actionId: Schema.String },
) {}

export type VoiceHandoffActionRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | VoiceHandoffActionConflictError
  | VoiceHandoffActionOwnershipError
  | VoiceHandoffActionNotFoundError;

export interface VoiceHandoffActionRepositoryShape {
  readonly create: (
    input: VoiceHandoffActionIdentity,
  ) => Effect.Effect<DurableVoiceHandoffAction, VoiceHandoffActionRepositoryError>;
  readonly get: (
    actionId: string,
  ) => Effect.Effect<
    Option.Option<DurableVoiceHandoffAction>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly activate: (input: {
    readonly actionId: string;
    readonly activatedAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<DurableVoiceHandoffAction, VoiceHandoffActionRepositoryError>;
  readonly listPending: (input: {
    readonly authSessionId: string;
    readonly realtimeSessionId: string;
    readonly realtimeGeneration: number;
    readonly now: string;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<DurableVoiceHandoffAction>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly acknowledge: (input: {
    readonly actionId: string;
    readonly authSessionId: string;
    readonly result: VoiceHandoffActionResult;
    readonly acknowledgedAt: string;
  }) => Effect.Effect<DurableVoiceHandoffAction, VoiceHandoffActionRepositoryError>;
  readonly expire: (input: {
    readonly now: string;
  }) => Effect.Effect<ReadonlyArray<DurableVoiceHandoffAction>, VoiceHandoffActionRepositoryError>;
}

export class VoiceHandoffActionRepository extends Context.Service<
  VoiceHandoffActionRepository,
  VoiceHandoffActionRepositoryShape
>()("t3/persistence/Services/VoiceHandoffActions/VoiceHandoffActionRepository") {}

import {
  CommandId,
  IsoDateTime,
  TrimmedNonEmptyString,
  VoiceConfirmationId,
  VoiceConversationId,
  VoiceSessionId,
  VoiceToolCallId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const VoiceToolCallStatus = Schema.Literals([
  "requested",
  "pending-confirmation",
  "succeeded",
  "failed",
  "rejected",
  "expired",
]);
export type VoiceToolCallStatus = typeof VoiceToolCallStatus.Type;

export const DurableVoiceToolCall = Schema.Struct({
  conversationId: VoiceConversationId,
  toolCallId: VoiceToolCallId,
  providerFunctionCallId: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  canonicalArgumentsJson: Schema.String,
  status: VoiceToolCallStatus,
  sessionId: VoiceSessionId,
  confirmationId: Schema.NullOr(VoiceConfirmationId),
  summary: Schema.NullOr(Schema.String),
  commandId: Schema.NullOr(CommandId),
  commandJson: Schema.NullOr(Schema.String),
  resultOutput: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type DurableVoiceToolCall = typeof DurableVoiceToolCall.Type;

export type VoiceToolCallRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface VoiceToolCallRepositoryShape {
  readonly createRequested: (input: {
    readonly conversationId: VoiceConversationId;
    readonly toolCallId: VoiceToolCallId;
    readonly providerFunctionCallId: string;
    readonly toolName: string;
    readonly canonicalArgumentsJson: string;
    readonly sessionId: VoiceSessionId;
    readonly createdAt: string;
  }) => Effect.Effect<
    { readonly call: DurableVoiceToolCall; readonly created: boolean },
    VoiceToolCallRepositoryError
  >;
  readonly get: (input: {
    readonly conversationId: VoiceConversationId;
    readonly toolCallId: VoiceToolCallId;
  }) => Effect.Effect<Option.Option<DurableVoiceToolCall>, VoiceToolCallRepositoryError>;
  readonly getByConfirmationId: (
    confirmationId: VoiceConfirmationId,
  ) => Effect.Effect<Option.Option<DurableVoiceToolCall>, VoiceToolCallRepositoryError>;
  readonly markPending: (input: {
    readonly conversationId: VoiceConversationId;
    readonly toolCallId: VoiceToolCallId;
    readonly sessionId: VoiceSessionId;
    readonly confirmationId: VoiceConfirmationId;
    readonly summary: string;
    readonly commandId: CommandId;
    readonly commandJson: string;
    readonly updatedAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<DurableVoiceToolCall, VoiceToolCallRepositoryError>;
  readonly markTerminal: (input: {
    readonly conversationId: VoiceConversationId;
    readonly toolCallId: VoiceToolCallId;
    readonly status: Extract<VoiceToolCallStatus, "succeeded" | "failed" | "rejected" | "expired">;
    readonly resultOutput: string;
    readonly updatedAt: string;
  }) => Effect.Effect<DurableVoiceToolCall, VoiceToolCallRepositoryError>;
}

export class VoiceToolCallRepository extends Context.Service<
  VoiceToolCallRepository,
  VoiceToolCallRepositoryShape
>()("t3/persistence/Services/VoiceToolCalls/VoiceToolCallRepository") {}

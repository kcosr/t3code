import type {
  AuthEnvironmentScope,
  AuthSessionId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  VoiceConfirmationDecision,
  VoiceConfirmationId,
  VoiceConversationId,
  VoiceSessionId,
  VoiceToolCallId,
  VoiceToolName,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VoiceError } from "../Errors.ts";

export interface VoiceToolCallInput {
  readonly authSessionId: AuthSessionId;
  readonly sessionId: VoiceSessionId;
  readonly conversationId: VoiceConversationId;
  readonly contextEpoch: number;
  readonly toolCallId: VoiceToolCallId;
  readonly providerFunctionCallId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly grantedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly requestClientAction: (request: {
    readonly actionId: VoiceClientActionId;
    readonly action: "activate-thread";
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<{
    readonly outcome: "succeeded" | "failed";
    readonly reason?: string;
  }>;
}

export interface VoiceToolCompletedResult {
  readonly type: "completed";
  readonly toolCallId: VoiceToolCallId;
  readonly providerFunctionCallId: string;
  readonly tool: VoiceToolName | "unknown";
  readonly outcome: "succeeded" | "failed" | "rejected" | "expired";
  readonly output: string;
  readonly submitOutput: boolean;
}

export interface VoiceToolConfirmationResult {
  readonly type: "confirmation-required";
  readonly confirmationId: VoiceConfirmationId;
  readonly toolCallId: VoiceToolCallId;
  readonly providerFunctionCallId: string;
  readonly tool: VoiceToolName;
  readonly summary: string;
  readonly expiresAt: string;
  readonly newlyCreated: boolean;
}

export type VoiceToolInvokeResult = VoiceToolCompletedResult | VoiceToolConfirmationResult;

export interface VoiceToolExecutorShape {
  readonly invoke: (input: VoiceToolCallInput) => Effect.Effect<VoiceToolInvokeResult, VoiceError>;
  readonly decide: (input: {
    readonly authSessionId: AuthSessionId;
    readonly sessionId: VoiceSessionId;
    readonly confirmationId: VoiceConfirmationId;
    readonly decision: VoiceConfirmationDecision;
  }) => Effect.Effect<VoiceToolCompletedResult, VoiceError>;
  readonly expire: (input: {
    readonly sessionId: VoiceSessionId;
    readonly confirmationId: VoiceConfirmationId;
  }) => Effect.Effect<VoiceToolCompletedResult | undefined>;
  readonly discardSession: (sessionId: VoiceSessionId) => Effect.Effect<void>;
}

export class VoiceToolExecutor extends Context.Service<VoiceToolExecutor, VoiceToolExecutorShape>()(
  "t3/voice/Services/VoiceToolExecutor",
) {}

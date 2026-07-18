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
  VoiceTerminalAction,
  VoiceTerminalActionRequest,
  VoiceToolCallId,
  VoiceToolName,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VoiceError } from "../Errors.ts";

const TERMINAL_VOICE_TOOL_BY_ACTION = {
  "stop-realtime": "stop_realtime_voice",
  "switch-to-thread": "switch_to_thread_voice",
} as const satisfies Record<VoiceTerminalAction, VoiceToolName>;

export type TerminalVoiceTool = (typeof TERMINAL_VOICE_TOOL_BY_ACTION)[VoiceTerminalAction];

export const terminalVoiceToolForAction = (action: VoiceTerminalAction): TerminalVoiceTool =>
  TERMINAL_VOICE_TOOL_BY_ACTION[action];

export function terminalActionForVoiceTool(tool: TerminalVoiceTool): VoiceTerminalAction;
export function terminalActionForVoiceTool(tool: string): VoiceTerminalAction | undefined;
export function terminalActionForVoiceTool(tool: string): VoiceTerminalAction | undefined {
  for (const action of Object.keys(TERMINAL_VOICE_TOOL_BY_ACTION) as VoiceTerminalAction[]) {
    if (TERMINAL_VOICE_TOOL_BY_ACTION[action] === tool) return action;
  }
  return undefined;
}

export const isTerminalVoiceTool = (tool: string): tool is TerminalVoiceTool =>
  terminalActionForVoiceTool(tool) !== undefined;

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

export interface VoiceToolTerminalResult {
  readonly type: "terminal-completed";
  readonly toolCallId: VoiceToolCallId;
  readonly providerFunctionCallId: string;
  readonly tool: TerminalVoiceTool;
  readonly outcome: "succeeded";
  readonly output: string;
  readonly terminalAction: VoiceTerminalActionRequest;
}

export type VoiceToolExecutionResult = VoiceToolCompletedResult | VoiceToolTerminalResult;

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

export type VoiceToolInvokeResult = VoiceToolExecutionResult | VoiceToolConfirmationResult;

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

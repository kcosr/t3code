/**
 * Narrow Pi RPC protocol shapes used by the T3 piAgent adapter.
 * Full protocol: stock Pi `packages/coding-agent/src/modes/rpc/rpc-types.ts`.
 */

import * as Schema from "effect/Schema";

import { PI_THINKING_LEVELS } from "./modelSlug.ts";

export const PiThinkingLevelSchema = Schema.Literals([...PI_THINKING_LEVELS]);

export const PiResumeCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  sessionPath: Schema.String,
  cwd: Schema.String,
});
export type PiResumeCursor = typeof PiResumeCursorSchema.Type;
export const isPiResumeCursor = Schema.is(PiResumeCursorSchema);

export const PiModelSchema = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.Number),
});
export type PiModel = typeof PiModelSchema.Type;

export const PiSessionStateSchema = Schema.Struct({
  model: Schema.optional(Schema.NullOr(Schema.Unknown)),
  thinkingLevel: Schema.optional(Schema.String),
  isStreaming: Schema.optional(Schema.Boolean),
  isCompacting: Schema.optional(Schema.Boolean),
  steeringMode: Schema.optional(Schema.String),
  followUpMode: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  sessionName: Schema.optional(Schema.String),
  autoCompactionEnabled: Schema.optional(Schema.Boolean),
  messageCount: Schema.optional(Schema.Number),
  pendingMessageCount: Schema.optional(Schema.Number),
});
export type PiSessionState = typeof PiSessionStateSchema.Type;

export const PiResponseEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.optional(Schema.String),
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export type PiResponseEnvelope = typeof PiResponseEnvelopeSchema.Type;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPiResponseEnvelope(value: unknown): value is PiResponseEnvelope {
  return (
    isRecord(value) &&
    value.type === "response" &&
    typeof value.command === "string" &&
    typeof value.success === "boolean"
  );
}

export function isPiExtensionUiRequest(value: unknown): value is Record<string, unknown> & {
  type: "extension_ui_request";
  id: string;
  method: string;
} {
  return (
    isRecord(value) &&
    value.type === "extension_ui_request" &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

export function isPiAgentEvent(value: unknown): value is Record<string, unknown> & {
  type: string;
} {
  return isRecord(value) && typeof value.type === "string" && value.type !== "response";
}

export type PiNativeOutbound =
  | { readonly type: string; readonly id?: string; readonly [key: string]: unknown }
  | Record<string, unknown>;

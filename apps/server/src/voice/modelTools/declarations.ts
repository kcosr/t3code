import type { VoiceTerminalAction } from "@t3tools/contracts";
import type { AnyModelToolDefinition } from "@t3tools/shared/model-tool";

import { COMMAND_META_TOOL_DECLARATIONS } from "./commandMeta.ts";
import {
  terminalToolNameForAction,
  VOICE_TOOL_DECLARATION_ORDER,
  VoiceModelTools,
} from "./definitions.ts";
import type { VoiceToolExposure } from "./exposure.ts";
import { normalizeProviderJsonSchema } from "./providerJsonSchema.ts";

export type RealtimeFunctionDeclaration = {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

const TERMINAL_TOOL_NAMES = new Set<string>(Object.values(terminalToolNameForAction));

function declarationFromDefinition(tool: AnyModelToolDefinition): RealtimeFunctionDeclaration {
  const parameters = normalizeProviderJsonSchema(tool.inputJsonSchema) as Record<string, unknown>;
  // Prefer empty `properties: {}` for empty objects so OpenAI matches historical shape.
  if (
    parameters.type === "object" &&
    parameters.properties === undefined &&
    parameters.additionalProperties === false
  ) {
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters,
  };
}

/**
 * Build OpenAI Realtime function declarations for a session.
 *
 * Migrated tools use generated (and normalized) JSON Schema from their
 * definitions. Command-listed tools are omitted from direct declarations and
 * replaced by meta-tools when the session command catalog is non-empty.
 * Terminal tools appear only when the session's terminal-action set allows them
 * and they are not command-only for this session.
 */
export function buildRealtimeToolDeclarations(input: {
  readonly terminalActions: ReadonlySet<VoiceTerminalAction>;
  readonly exposure: VoiceToolExposure;
}): ReadonlyArray<RealtimeFunctionDeclaration> {
  const directByName = new Map(
    input.exposure.directMigratedTools.map((tool) => [tool.name, tool] as const),
  );

  const tools: RealtimeFunctionDeclaration[] = [];
  for (const name of VOICE_TOOL_DECLARATION_ORDER) {
    if (TERMINAL_TOOL_NAMES.has(name)) continue;
    const tool = directByName.get(name);
    if (tool !== undefined) {
      tools.push(declarationFromDefinition(tool));
    }
  }

  if (input.exposure.commandMetaToolsEnabled) {
    for (const meta of COMMAND_META_TOOL_DECLARATIONS) {
      tools.push({
        type: "function",
        name: meta.name,
        description: meta.description,
        parameters: { ...meta.parameters } as Record<string, unknown>,
      });
    }
  }

  if (
    input.terminalActions.has("stop-realtime") &&
    directByName.has(terminalToolNameForAction["stop-realtime"])
  ) {
    tools.push(
      declarationFromDefinition(
        VoiceModelTools.require(terminalToolNameForAction["stop-realtime"]),
      ),
    );
  }
  if (
    input.terminalActions.has("switch-to-thread") &&
    directByName.has(terminalToolNameForAction["switch-to-thread"])
  ) {
    tools.push(
      declarationFromDefinition(
        VoiceModelTools.require(terminalToolNameForAction["switch-to-thread"]),
      ),
    );
  }

  return tools;
}

export function realtimeToolConfig(input: {
  readonly terminalActions: ReadonlySet<VoiceTerminalAction>;
  readonly exposure: VoiceToolExposure;
}) {
  return {
    tools: buildRealtimeToolDeclarations(input),
    tool_choice: "auto" as const,
    parallel_tool_calls: false,
  };
}

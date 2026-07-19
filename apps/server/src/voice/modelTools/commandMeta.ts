import type { AnyModelToolDefinition } from "@t3tools/shared/model-tool";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { VoiceToolExposure } from "./exposure.ts";
import { normalizeProviderJsonSchema } from "./providerJsonSchema.ts";

export const COMMAND_LIST_TOOL_NAME = "command_list" as const;
export const COMMAND_DESCRIBE_TOOL_NAME = "command_describe" as const;
export const COMMAND_EXECUTE_TOOL_NAME = "command_execute" as const;

export const COMMAND_META_TOOL_NAMES = [
  COMMAND_LIST_TOOL_NAME,
  COMMAND_DESCRIBE_TOOL_NAME,
  COMMAND_EXECUTE_TOOL_NAME,
] as const;

export type CommandMetaToolName = (typeof COMMAND_META_TOOL_NAMES)[number];

export const isCommandMetaToolName = (name: string): name is CommandMetaToolName =>
  name === COMMAND_LIST_TOOL_NAME ||
  name === COMMAND_DESCRIBE_TOOL_NAME ||
  name === COMMAND_EXECUTE_TOOL_NAME;

const CommandDescribeArguments = Schema.Struct({
  command: Schema.String.check(Schema.isNonEmpty()),
});

const CommandExecuteArguments = Schema.Struct({
  command: Schema.String.check(Schema.isNonEmpty()),
  payload: Schema.Unknown,
});

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const decodeCommandDescribeArguments = Schema.decodeUnknownExit(
  Schema.fromJsonString(CommandDescribeArguments),
  { onExcessProperty: "error" },
);
const decodeCommandExecuteArguments = Schema.decodeUnknownExit(
  Schema.fromJsonString(CommandExecuteArguments),
  { onExcessProperty: "error" },
);

/** Fixed OpenAI Realtime function declarations for command meta-tools. */
export const COMMAND_META_TOOL_DECLARATIONS = [
  {
    type: "function",
    name: COMMAND_LIST_TOOL_NAME,
    description:
      "List business commands available through the command wrapper for this voice session.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: COMMAND_DESCRIBE_TOOL_NAME,
    description:
      "Describe one command from the session command catalog, including its input schema.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: COMMAND_EXECUTE_TOOL_NAME,
    description:
      "Execute one command from the session command catalog. The payload is the command's business arguments.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        payload: { type: "object" },
      },
      required: ["command", "payload"],
      additionalProperties: false,
    },
  },
] as const;

export type CommandWrapperErrorCode =
  | "unknown_command"
  | "invalid_arguments"
  | "non_object_payload";

export interface CommandWrapperError {
  readonly error: {
    readonly code: CommandWrapperErrorCode;
    readonly message: string;
  };
}

export interface NormalizedCommandExecute {
  readonly type: "normalized";
  readonly name: string;
  readonly argumentsJson: string;
}

export type CommandExecuteNormalization =
  | NormalizedCommandExecute
  | {
      readonly type: "wrapper-error";
      readonly output: string;
    };

/**
 * Format the compact plain-text command catalog for `command_list`.
 * Deterministically ordered by name; contains no schemas.
 */
export function formatCommandList(catalog: ReadonlyArray<AnyModelToolDefinition>): string {
  return catalog.map((tool) => `${tool.name} — ${tool.description}`).join("\n");
}

/**
 * Format Markdown command description for `command_describe`.
 */
export function formatCommandDescribe(tool: AnyModelToolDefinition): string {
  const schemaJson = JSON.stringify(normalizeProviderJsonSchema(tool.inputJsonSchema), null, 2);
  return [
    `Command: ${tool.name}`,
    `Description: ${tool.description}`,
    "",
    "Input:",
    "",
    "```json",
    schemaJson,
    "```",
  ].join("\n");
}

export function commandWrapperErrorJson(code: CommandWrapperErrorCode, message: string): string {
  return encodeJson({
    error: { code, message },
  } satisfies CommandWrapperError);
}

/**
 * Handle `command_list` / `command_describe` meta-tools without entering the
 * business voice executor.
 */
export function handleCommandPresentation(
  name: CommandMetaToolName,
  argumentsJson: string,
  exposure: VoiceToolExposure,
): Effect.Effect<string, never> {
  return Effect.sync(() => {
    if (name === COMMAND_LIST_TOOL_NAME) {
      let args: unknown;
      try {
        args = decodeJson(argumentsJson);
      } catch {
        return commandWrapperErrorJson("invalid_arguments", "command_list arguments were invalid");
      }
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args as object).length > 0
      ) {
        return commandWrapperErrorJson(
          "invalid_arguments",
          "command_list does not accept arguments",
        );
      }
      return formatCommandList(exposure.commandCatalog);
    }

    if (name === COMMAND_DESCRIBE_TOOL_NAME) {
      const decoded = decodeCommandDescribeArguments(argumentsJson);
      if (decoded._tag === "Failure") {
        return commandWrapperErrorJson(
          "invalid_arguments",
          "command_describe arguments were invalid",
        );
      }
      const commandName = decoded.value.command;
      const tool = exposure.commandCatalog.find((entry) => entry.name === commandName);
      if (tool === undefined) {
        return commandWrapperErrorJson(
          "unknown_command",
          "Command is not available in this session",
        );
      }
      return formatCommandDescribe(tool);
    }

    return commandWrapperErrorJson("invalid_arguments", "Unsupported command meta-tool");
  });
}

/**
 * Normalize `command_execute` into the effective business-tool invocation.
 *
 * Wrapper lookup and outer-shape errors return a small JSON error object and do
 * not invoke the business executor. Valid calls reuse the outer tool-call IDs.
 */
export function normalizeCommandExecute(
  argumentsJson: string,
  exposure: VoiceToolExposure,
): CommandExecuteNormalization {
  const decoded = decodeCommandExecuteArguments(argumentsJson);
  if (decoded._tag === "Failure") {
    return {
      type: "wrapper-error",
      output: commandWrapperErrorJson(
        "invalid_arguments",
        "command_execute arguments were invalid",
      ),
    };
  }

  const { command, payload } = decoded.value;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      type: "wrapper-error",
      output: commandWrapperErrorJson(
        "non_object_payload",
        "command_execute payload must be an object",
      ),
    };
  }

  const tool = exposure.commandCatalog.find((entry) => entry.name === command);
  if (tool === undefined) {
    return {
      type: "wrapper-error",
      output: commandWrapperErrorJson(
        "unknown_command",
        "Command is not available in this session",
      ),
    };
  }

  return {
    type: "normalized",
    name: tool.name,
    argumentsJson: encodeJson(payload),
  };
}

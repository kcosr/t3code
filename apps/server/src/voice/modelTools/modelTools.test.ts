import { expect, it } from "@effect/vitest";
import { VoiceToolName } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import {
  COMMAND_DESCRIBE_TOOL_NAME,
  COMMAND_LIST_TOOL_NAME,
  COMMAND_META_TOOL_NAMES,
  formatCommandDescribe,
  formatCommandList,
  handleCommandPresentation,
  isCommandMetaToolName,
  normalizeCommandExecute,
} from "./commandMeta.ts";
import { buildRealtimeToolDeclarations } from "./declarations.ts";
import { CreateThreadTool, ListThreadsTool, VoiceModelTools } from "./definitions.ts";
import { resolveVoiceToolExposure } from "./exposure.ts";

describe("voice model tool definitions", () => {
  it("registers every public voice tool with object-root generated schemas", () => {
    expect(VoiceModelTools.names()).toEqual([
      "list_projects",
      "list_threads",
      "list_provider_models",
      "get_thread_status",
      "interrupt_thread",
      "archive_thread",
      "get_thread_messages",
      "wait_for_thread_turn",
      "search_history",
      "read_history",
      "activate_thread",
      "create_thread",
      "send_thread_message",
      "stop_realtime_voice",
      "switch_to_thread_voice",
    ]);
    expect(ListThreadsTool.inputJsonSchema.type).toBe("object");
    expect(ListThreadsTool.inputJsonSchema.additionalProperties).toBe(false);
    expect(ListThreadsTool.inputJsonSchema.required).toEqual(["projectId", "limit"]);
    expect(CreateThreadTool.inputJsonSchema.required).toEqual(["projectId"]);
    expect(CreateThreadTool.inputJsonSchema.additionalProperties).toBe(false);
  });
});

describe("voice tool exposure", () => {
  it("keeps all tools direct when commandTools is empty", () => {
    const exposure = resolveVoiceToolExposure([]);
    expect(exposure.commandMetaToolsEnabled).toBe(false);
    expect(exposure.directMigratedTools.map((tool) => tool.name)).toEqual(VoiceModelTools.names());
    expect(exposure.commandCatalog).toEqual([]);
  });

  it("suppresses direct declaration for each configured command tool", () => {
    const listOnly = resolveVoiceToolExposure(["list_threads"]);
    expect(listOnly.commandCatalog.map((tool) => tool.name)).toEqual(["list_threads"]);
    expect(listOnly.directMigratedTools.map((tool) => tool.name)).not.toContain("list_threads");
    expect(listOnly.commandMetaToolsEnabled).toBe(true);

    const many = resolveVoiceToolExposure(["create_thread", "list_threads", "send_thread_message"]);
    expect(many.commandCatalog.map((tool) => tool.name)).toEqual([
      "create_thread",
      "list_threads",
      "send_thread_message",
    ]);
    expect(many.directMigratedTools.map((tool) => tool.name)).not.toContain("send_thread_message");
  });
});

describe("realtime declarations", () => {
  it("omits command-listed tools and adds meta-tools once", () => {
    const empty = buildRealtimeToolDeclarations({
      terminalActions: new Set(),
      exposure: resolveVoiceToolExposure([]),
    });
    const emptyNames = empty.map((tool) => tool.name);
    expect(emptyNames).toContain("list_threads");
    expect(emptyNames).toContain("create_thread");
    expect(emptyNames).not.toContain(COMMAND_LIST_TOOL_NAME);

    const wrapped = buildRealtimeToolDeclarations({
      terminalActions: new Set(["stop-realtime"]),
      exposure: resolveVoiceToolExposure(["list_threads", "create_thread"]),
    });
    const wrappedNames = wrapped.map((tool) => tool.name);
    expect(wrappedNames).not.toContain("list_threads");
    expect(wrappedNames).not.toContain("create_thread");
    expect(wrappedNames.filter((name) => isCommandMetaToolName(name))).toEqual([
      ...COMMAND_META_TOOL_NAMES,
    ]);
    expect(wrappedNames).toContain("stop_realtime_voice");
    expect(wrappedNames).toContain("send_thread_message");
  });

  it("uses generated schemas for direct migrated tools with inline integer bounds", () => {
    const tools = buildRealtimeToolDeclarations({
      terminalActions: new Set(),
      exposure: resolveVoiceToolExposure([]),
    });
    const listThreads = tools.find((tool) => tool.name === "list_threads");
    expect(listThreads?.parameters).toMatchObject({
      type: "object",
      required: ["projectId", "limit"],
      additionalProperties: false,
      properties: {
        projectId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    });
    expect(listThreads?.parameters.properties).toBeDefined();
    const limit = (listThreads?.parameters.properties as Record<string, unknown>).limit as Record<
      string,
      unknown
    >;
    expect(limit.allOf).toBeUndefined();
    expect(tools.find((tool) => tool.name === "create_thread")?.parameters).toMatchObject({
      type: "object",
      required: ["projectId"],
      additionalProperties: false,
    });
  });
});

describe("command meta tools", () => {
  const exposure = resolveVoiceToolExposure(["list_threads", "create_thread"]);

  it.effect("formats list and describe from the command catalog", () =>
    Effect.gen(function* () {
      const list = yield* handleCommandPresentation(COMMAND_LIST_TOOL_NAME, "{}", exposure);
      expect(list).toBe(formatCommandList(exposure.commandCatalog));
      expect(list).toContain("create_thread —");
      expect(list).toContain("list_threads —");

      const describe = yield* handleCommandPresentation(
        COMMAND_DESCRIBE_TOOL_NAME,
        '{"command":"create_thread"}',
        exposure,
      );
      expect(describe).toBe(formatCommandDescribe(CreateThreadTool));
      expect(describe).toContain("Command: create_thread");
      expect(describe).toContain('"type": "object"');
    }),
  );

  it("normalizes command_execute to the business tool without wrapper identity", () => {
    const normalized = normalizeCommandExecute(
      JSON.stringify({
        command: "create_thread",
        payload: { projectId: "project-1", title: "From command" },
      }),
      exposure,
    );
    expect(normalized).toEqual({
      type: "normalized",
      name: "create_thread",
      argumentsJson: JSON.stringify({ projectId: "project-1", title: "From command" }),
    });
  });

  it("returns wrapper errors without invoking business tools", () => {
    const unknown = normalizeCommandExecute(
      JSON.stringify({ command: "send_thread_message", payload: {} }),
      exposure,
    );
    expect(unknown.type).toBe("wrapper-error");
    if (unknown.type === "wrapper-error") {
      expect(JSON.parse(unknown.output).error.code).toBe("unknown_command");
    }

    const nonObject = normalizeCommandExecute(
      JSON.stringify({ command: "list_threads", payload: "nope" }),
      exposure,
    );
    expect(nonObject.type).toBe("wrapper-error");
    if (nonObject.type === "wrapper-error") {
      expect(JSON.parse(nonObject.output).error.code).toBe("non_object_payload");
    }
  });

  it("never treats meta-tool names as public VoiceToolName values", () => {
    const decode = Schema.decodeUnknownOption(VoiceToolName);
    for (const name of COMMAND_META_TOOL_NAMES) {
      expect(isCommandMetaToolName(name)).toBe(true);
      expect(decode(name)._tag).toBe("None");
    }
  });

  it("keeps direct and command describe schemas semantically aligned", () => {
    const tools = buildRealtimeToolDeclarations({
      terminalActions: new Set(),
      exposure: resolveVoiceToolExposure([]),
    });
    const directList = tools.find((tool) => tool.name === "list_threads");
    const describe = formatCommandDescribe(ListThreadsTool);
    expect(describe).toContain('"minimum": 1');
    expect(describe).toContain('"maximum": 50');
    expect(describe).not.toContain('"allOf"');
    expect(describe).toContain(JSON.stringify(directList?.parameters, null, 2));
  });
});

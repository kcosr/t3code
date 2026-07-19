import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  decodeModelToolArgumentsJson,
  decodeModelToolArgumentsUnknown,
  defineModelTool,
  defineModelToolRegistry,
  generateInputJsonSchema,
} from "./modelTool.ts";

const ListThreadsArguments = Schema.Struct({
  projectId: Schema.String,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});

const CreateThreadArguments = Schema.Struct({
  projectId: Schema.String,
  title: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
});

describe("defineModelTool", () => {
  it("generates deterministic object-root JSON Schema with excess-property rejection", () => {
    const tool = defineModelTool({
      name: "list_threads",
      description: "List threads belonging to a T3 project.",
      inputSchema: ListThreadsArguments,
      execute: (_context: unknown, input) => Effect.succeed(input),
    });

    expect(tool.name).toBe("list_threads");
    expect(tool.description).toBe("List threads belonging to a T3 project.");
    expect(tool.inputJsonSchema.type).toBe("object");
    expect(tool.inputJsonSchema.additionalProperties).toBe(false);
    expect(tool.inputJsonSchema.required).toEqual(["projectId", "limit"]);
    expect(tool.inputJsonSchema.properties).toMatchObject({
      projectId: { type: "string" },
      limit: { type: "integer" },
    });
    expect(generateInputJsonSchema(ListThreadsArguments)).toEqual(tool.inputJsonSchema);
  });

  it("represents optional title and integer bounds for create_thread", () => {
    const tool = defineModelTool({
      name: "create_thread",
      description: "Create a thread in a T3 project.",
      inputSchema: CreateThreadArguments,
      execute: (_context: unknown, input) => Effect.succeed(input),
    });

    expect(tool.inputJsonSchema.required).toEqual(["projectId"]);
    expect(tool.inputJsonSchema.properties).toMatchObject({
      projectId: { type: "string" },
      title: { type: "string" },
    });
    expect(tool.inputJsonSchema.additionalProperties).toBe(false);
  });

  it("rejects empty names and descriptions", () => {
    expect(() =>
      defineModelTool({
        name: "  ",
        description: "ok",
        inputSchema: Schema.Struct({}),
        execute: () => Effect.void,
      }),
    ).toThrow(/name/i);
    expect(() =>
      defineModelTool({
        name: "tool",
        description: "  ",
        inputSchema: Schema.Struct({ id: Schema.String }),
        execute: () => Effect.void,
      }),
    ).toThrow(/description/i);
  });
});

describe("decodeModelToolArguments", () => {
  const tool = defineModelTool({
    name: "list_threads",
    description: "List threads.",
    inputSchema: ListThreadsArguments,
    execute: (_context: unknown, input) => Effect.succeed(input),
  });

  it.effect("decodes valid JSON arguments", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeModelToolArgumentsJson(tool, '{"projectId":"p1","limit":10}');
      expect(decoded).toEqual({ projectId: "p1", limit: 10 });
    }),
  );

  it.effect("rejects excess properties", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeModelToolArgumentsJson(tool, '{"projectId":"p1","limit":10,"extra":true}'),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects invalid bounds and missing required fields", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.exit(decodeModelToolArgumentsUnknown(tool, { limit: 10 }));
      const high = yield* Effect.exit(
        decodeModelToolArgumentsUnknown(tool, { projectId: "p1", limit: 51 }),
      );
      expect(Exit.isFailure(missing)).toBe(true);
      expect(Exit.isFailure(high)).toBe(true);
    }),
  );
});

describe("defineModelToolRegistry", () => {
  const listThreads = defineModelTool({
    name: "list_threads",
    description: "List threads belonging to a T3 project.",
    inputSchema: ListThreadsArguments,
    execute: (_context: unknown, input) => Effect.succeed(input),
  });
  const createThread = defineModelTool({
    name: "create_thread",
    description: "Create a thread in a T3 project.",
    inputSchema: CreateThreadArguments,
    execute: (_context: unknown, input) => Effect.succeed(input),
  });

  it("indexes tools by name and validates command-capable names", () => {
    const registry = defineModelToolRegistry([listThreads, createThread], {
      commandCapableNames: ["list_threads", "create_thread"],
    });
    expect(registry.names()).toEqual(["list_threads", "create_thread"]);
    expect(registry.require("list_threads")).toBe(listThreads);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects duplicate names and unknown command-capable names", () => {
    expect(() => defineModelToolRegistry([listThreads, listThreads])).toThrow(/Duplicate/);
    expect(() =>
      defineModelToolRegistry([listThreads], { commandCapableNames: ["create_thread"] }),
    ).toThrow(/not registered/);
  });
});

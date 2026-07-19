import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Object-root JSON Schema produced for model tool parameters.
 *
 * Providers receive this shape as the function `parameters` document.
 */
export type JsonSchemaObject = {
  readonly type: "object";
  readonly [key: string]: unknown;
};

/**
 * Immutable definition of one model-callable operation.
 *
 * Direct function tools and command-wrapper exposure are adapters over this
 * value. Business handlers, argument contracts, and results live here once.
 */
export interface ModelToolDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Context = unknown,
  Failure = unknown,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema.Codec<Input, unknown>;
  readonly inputJsonSchema: JsonSchemaObject;
  readonly execute: (context: Context, input: Input) => Effect.Effect<Output, Failure>;
}

export type AnyModelToolDefinition = ModelToolDefinition<string, any, any, any, any>;

export interface DefineModelToolInput<
  Name extends string,
  Input,
  Output,
  Context,
  Failure,
  S extends Schema.Codec<Input, unknown>,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: S;
  readonly execute: (context: Context, input: Input) => Effect.Effect<Output, Failure>;
}

/**
 * Create a model tool definition, generating and caching JSON Schema from the
 * Effect input schema. Generation failures throw; there is no hand-written
 * JSON Schema fallback.
 */
export function defineModelTool<
  Name extends string,
  Input,
  Output,
  Context,
  Failure,
  S extends Schema.Codec<Input, unknown>,
>(
  input: DefineModelToolInput<Name, Input, Output, Context, Failure, S>,
): ModelToolDefinition<Name, Input, Output, Context, Failure> {
  if (input.name.trim().length === 0) {
    throw new Error("Model tool name must be a non-empty string");
  }
  const description = input.description.trim();
  if (description.length === 0) {
    throw new Error(`Model tool "${input.name}" description must be a non-empty string`);
  }
  return {
    name: input.name,
    description,
    inputSchema: input.inputSchema,
    inputJsonSchema: generateInputJsonSchema(input.inputSchema, input.name),
    execute: input.execute,
  };
}

export interface ModelToolRegistry<Tools extends ReadonlyArray<AnyModelToolDefinition>> {
  readonly tools: Tools;
  readonly byName: ReadonlyMap<string, Tools[number]>;
  get(name: string): Tools[number] | undefined;
  require(name: string): Tools[number];
  names(): ReadonlyArray<Tools[number]["name"]>;
}

/**
 * Build an immutable registry of model tools with construction-time validation.
 *
 * Validates unique names, object-root JSON Schema, explicit excess-property
 * rejection in the generated schema, and successful JSON Schema generation.
 */
export function defineModelToolRegistry<const Tools extends ReadonlyArray<AnyModelToolDefinition>>(
  tools: Tools,
  options?: {
    readonly commandCapableNames?: ReadonlyArray<string>;
  },
): ModelToolRegistry<Tools> {
  const byName = new Map<string, Tools[number]>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate model tool name: ${tool.name}`);
    }
    assertObjectRootJsonSchema(tool.inputJsonSchema, tool.name);
    assertExplicitExcessPropertyRejection(tool.inputJsonSchema, tool.name);
    byName.set(tool.name, tool);
  }

  if (options?.commandCapableNames !== undefined) {
    for (const name of options.commandCapableNames) {
      if (!byName.has(name)) {
        throw new Error(
          `Configured command tool "${name}" is not registered in the model tool registry`,
        );
      }
    }
  }

  return {
    tools,
    byName,
    get(name) {
      return byName.get(name);
    },
    require(name) {
      const tool = byName.get(name);
      if (tool === undefined) {
        throw new Error(`Unknown model tool: ${name}`);
      }
      return tool;
    },
    names() {
      return tools.map((tool) => tool.name);
    },
  };
}

/**
 * Decode tool arguments from a JSON string using the definition's Effect schema.
 * Excess properties are always rejected.
 */
export function decodeModelToolArgumentsJson<Input>(
  tool: ModelToolDefinition<string, Input, unknown, unknown, unknown>,
  argumentsJson: string,
): Effect.Effect<Input, Schema.SchemaError> {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(tool.inputSchema), {
    onExcessProperty: "error",
  })(argumentsJson);
}

/**
 * Decode tool arguments from an unknown JSON value using the definition's Effect schema.
 * Excess properties are always rejected.
 */
export function decodeModelToolArgumentsUnknown<Input>(
  tool: ModelToolDefinition<string, Input, unknown, unknown, unknown>,
  argumentsValue: unknown,
): Effect.Effect<Input, Schema.SchemaError> {
  return Schema.decodeUnknownEffect(tool.inputSchema, {
    onExcessProperty: "error",
  })(argumentsValue);
}

export function generateInputJsonSchema(schema: Schema.Top, toolName = "tool"): JsonSchemaObject {
  let document: ReturnType<typeof Schema.toJsonSchemaDocument>;
  try {
    document = Schema.toJsonSchemaDocument(schema);
  } catch (cause) {
    throw new Error(
      `Failed to generate JSON Schema for model tool "${toolName}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const root =
    document.definitions && Object.keys(document.definitions).length > 0
      ? { ...document.schema, $defs: document.definitions }
      : document.schema;
  assertObjectRootJsonSchema(root, toolName);
  assertExplicitExcessPropertyRejection(root, toolName);
  return root;
}

function assertObjectRootJsonSchema(
  schema: unknown,
  toolName: string,
): asserts schema is JsonSchemaObject {
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema) ||
    (schema as { readonly type?: unknown }).type !== "object"
  ) {
    throw new Error(
      `Model tool "${toolName}" input JSON Schema must have an object root (type: "object")`,
    );
  }
}

function assertExplicitExcessPropertyRejection(schema: JsonSchemaObject, toolName: string): void {
  if (schema.additionalProperties !== false) {
    throw new Error(
      `Model tool "${toolName}" input JSON Schema must set additionalProperties: false`,
    );
  }
}

import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  type ClientOrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type VoiceCommandToolName,
} from "@t3tools/contracts";
import {
  defineModelTool,
  defineModelToolRegistry,
  type ModelToolDefinition,
} from "@t3tools/shared/model-tool";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { VoiceError } from "../Errors.ts";

export const VOICE_COMMAND_CAPABLE_TOOL_NAMES = [
  "list_threads",
  "create_thread",
] as const satisfies ReadonlyArray<VoiceCommandToolName>;

export const ListThreadsArguments = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
export type ListThreadsArguments = typeof ListThreadsArguments.Type;

export const CreateThreadArguments = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CreateThreadArguments = typeof CreateThreadArguments.Type;

export interface ListThreadsResult {
  readonly threads: ReadonlyArray<ReturnType<typeof threadProjection>>;
}

export interface CreateThreadPrepared {
  readonly summary: string;
  readonly command: Extract<ClientOrchestrationCommand, { readonly type: "thread.create" }>;
}

export type ListThreadsToolFailure = ProjectionRepositoryError;
export type CreateThreadToolFailure = ProjectionRepositoryError | VoiceError;

export interface ListThreadsToolContext {
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;
}

export interface CreateThreadToolContext {
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;
  readonly makeCommandId: Effect.Effect<CommandId>;
  readonly makeThreadId: Effect.Effect<ThreadId>;
  readonly nowIso: Effect.Effect<string>;
  readonly projectNotFound: (projectId: ProjectId) => VoiceError;
}

const threadProjection = (thread: OrchestrationThreadShell) => ({
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  runtimeMode: thread.runtimeMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  turnState: thread.latestTurn?.state ?? null,
  sessionStatus: thread.session?.status ?? "stopped",
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  updatedAt: thread.updatedAt,
});

export const ListThreadsTool: ModelToolDefinition<
  "list_threads",
  ListThreadsArguments,
  ListThreadsResult,
  ListThreadsToolContext,
  ListThreadsToolFailure
> = defineModelTool({
  name: "list_threads",
  description: "List threads in a T3 project.",
  inputSchema: ListThreadsArguments,
  execute: (context, input) =>
    Effect.gen(function* () {
      const snapshot = yield* context.getShellSnapshot();
      return {
        threads: snapshot.threads
          .filter((thread) => thread.projectId === input.projectId)
          .slice(0, input.limit)
          .map(threadProjection),
      } satisfies ListThreadsResult;
    }),
});

export const CreateThreadTool: ModelToolDefinition<
  "create_thread",
  CreateThreadArguments,
  CreateThreadPrepared,
  CreateThreadToolContext,
  CreateThreadToolFailure
> = defineModelTool({
  name: "create_thread",
  description:
    "Dispatch creation of a T3 thread immediately and return accepted command metadata. The receipt does not mean downstream initialization is complete.",
  inputSchema: CreateThreadArguments,
  execute: (context, input) =>
    Effect.gen(function* () {
      const project = yield* context.getProjectShellById(input.projectId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(context.projectNotFound(input.projectId)),
            onSome: Effect.succeed,
          }),
        ),
      );
      const commandId = yield* context.makeCommandId;
      const threadId = yield* context.makeThreadId;
      const createdAt = yield* context.nowIso;
      const title = input.title ?? "Voice thread";
      return {
        summary: `Create thread "${title}" in project "${project.title}"`,
        command: {
          type: "thread.create",
          commandId,
          threadId,
          projectId: project.id,
          title,
          modelSelection: project.defaultModelSelection ?? {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        },
      } satisfies CreateThreadPrepared;
    }),
});

export const VoiceModelTools = defineModelToolRegistry([ListThreadsTool, CreateThreadTool], {
  commandCapableNames: VOICE_COMMAND_CAPABLE_TOOL_NAMES,
});

export type VoiceMigratedToolName = (typeof VOICE_COMMAND_CAPABLE_TOOL_NAMES)[number];

export { threadProjection as voiceThreadProjection };

import {
  CommandId,
  EventId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "../Normalizer.ts";
import {
  ClientCommandDispatcher,
  ClientCommandNormalizationError,
  type ClientCommandDispatcherShape,
} from "../Services/ClientCommandDispatcher.ts";
import * as OrchestrationEngine from "../Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

export interface ClientCommandDispatcherDependencies {
  readonly normalize: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError>;
  readonly orchestrationEngine: Pick<OrchestrationEngine.OrchestrationEngineShape, "dispatch">;
  readonly projectionSnapshotQuery: Pick<
    ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
    "getThreadShellById"
  >;
  readonly gitWorkflow: Pick<
    GitWorkflowService.GitWorkflowService["Service"],
    "fetchRemote" | "resolveRemoteTrackingCommit" | "createWorktree"
  >;
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  readonly terminalManager: Pick<TerminalManager.TerminalManager["Service"], "close">;
  readonly vcsStatusBroadcaster: Pick<
    VcsStatusBroadcaster.VcsStatusBroadcaster["Service"],
    "refreshStatus"
  >;
  readonly startup: Pick<ServerRuntimeStartup.ServerRuntimeStartup["Service"], "enqueueCommand">;
  readonly randomUUID: Effect.Effect<string, OrchestrationDispatchCommandError>;
  readonly nowIso: Effect.Effect<string>;
}

export function makeClientCommandDispatcher(
  dependencies: ClientCommandDispatcherDependencies,
): ClientCommandDispatcherShape {
  const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
    isOrchestrationDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });
  const randomUUID = dependencies.randomUUID.pipe(
    Effect.mapError((cause) =>
      toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const refreshGitStatus = (cwd: string) =>
    dependencies.vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        dependencies.orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return isOrchestrationDispatchCommandError(error)
      ? error
      : new OrchestrationDispatchCommandError({
          message:
            error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
          cause,
        });
  };

  const dispatchBootstrapTurnStart = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread
          ? serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                dependencies.orchestrationEngine.dispatch({
                  type: "thread.delete",
                  commandId,
                  threadId: command.threadId,
                }),
              ),
              Effect.ignoreCause({ log: true }),
            )
          : Effect.void;

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = projectSetupScriptCompatibilityDetail(input.error);
        return appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: input.requestedAt,
          payload: { detail, worktreePath: input.worktreePath },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* dependencies.nowIso;
          const payload = {
            scriptId: input.scriptId,
            scriptName: input.scriptName,
            terminalId: input.terminalId,
            worktreePath: input.worktreePath,
          };
          yield* Effect.all([
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: input.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.started",
              summary: "Setup script started",
              createdAt: startedAt,
              payload,
              tone: "info",
            }),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  scriptId: input.scriptId,
                  terminalId: input.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        });

      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) return;
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* dependencies.nowIso;
          yield* dependencies.projectSetupScriptRunner
            .runForThread({
              threadId: command.threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({ error, requestedAt, worktreePath }),
                onSuccess: (setupResult) =>
                  setupResult.status !== "started"
                    ? Effect.void
                    : recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      }),
              }),
            );
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          yield* dependencies.orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: yield* serverCommandId("bootstrap-thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            createdAt: bootstrap.createThread.createdAt,
          });
          createdThread = true;
        }

        if (bootstrap?.prepareWorktree) {
          let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
          if (bootstrap.prepareWorktree.startFromOrigin) {
            yield* dependencies.gitWorkflow.fetchRemote({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            });
            const resolvedRemoteBase = yield* dependencies.gitWorkflow.resolveRemoteTrackingCommit({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              fallbackRemoteName: "origin",
            });
            worktreeBaseRef = resolvedRemoteBase.commitSha;
          }
          const worktree = yield* dependencies.gitWorkflow.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: worktreeBaseRef,
            newRefName: bootstrap.prepareWorktree.branch,
            baseRefName: bootstrap.prepareWorktree.baseBranch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          yield* dependencies.orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();
        return yield* dependencies.orchestrationEngine.dispatch(finalTurnStartCommand);
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          return Cause.hasInterruptsOnly(cause)
            ? Effect.fail(dispatchError)
            : cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
        }),
      );
    });

  const dispatchNormalizedCommand = (
    normalizedCommand: OrchestrationCommand,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
    const dispatchEffect =
      normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
        ? dispatchBootstrapTurnStart(normalizedCommand)
        : dependencies.orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
              ),
            );
    return dependencies.startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );
  };

  const dispatch: ClientCommandDispatcherShape["dispatch"] = Effect.fn(
    "ClientCommandDispatcher.dispatch",
  )(function* (command) {
    const normalizedCommand = yield* dependencies
      .normalize(command)
      .pipe(Effect.mapError((cause) => new ClientCommandNormalizationError({ cause })));
    const shouldStopSessionAfterArchive =
      normalizedCommand.type === "thread.archive"
        ? yield* dependencies.projectionSnapshotQuery
            .getThreadShellById(normalizedCommand.threadId)
            .pipe(
              Effect.map(
                Option.match({
                  onNone: () => false,
                  onSome: (thread) =>
                    thread.session !== null && thread.session.status !== "stopped",
                }),
              ),
              Effect.orElseSucceed(() => false),
            )
        : false;
    const result = yield* dispatchNormalizedCommand(normalizedCommand);
    if (normalizedCommand.type !== "thread.archive") return result;

    if (shouldStopSessionAfterArchive) {
      yield* Effect.gen(function* () {
        const stopCommand = yield* dependencies.normalize({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-archive:${normalizedCommand.commandId}`),
          threadId: normalizedCommand.threadId,
          createdAt: yield* dependencies.nowIso,
        });
        yield* dispatchNormalizedCommand(stopCommand);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to stop provider session during archive", {
            threadId: normalizedCommand.threadId,
            cause,
          }),
        ),
      );
    }

    yield* dependencies.terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to close thread terminals after archive", {
          threadId: normalizedCommand.threadId,
          error: error.message,
        }),
      ),
    );
    return result;
  });

  return ClientCommandDispatcher.of({ dispatch });
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const normalize = (command: ClientOrchestrationCommand) =>
    normalizeDispatchCommand(command).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
      Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePaths),
    );

  return makeClientCommandDispatcher({
    normalize,
    orchestrationEngine,
    projectionSnapshotQuery,
    gitWorkflow,
    projectSetupScriptRunner,
    terminalManager,
    vcsStatusBroadcaster,
    startup,
    randomUUID: crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to generate orchestration command identifier.",
            cause,
          }),
      ),
    ),
    nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
  });
});

export const ClientCommandDispatcherLive = Layer.effect(ClientCommandDispatcher, make);

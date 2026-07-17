import {
  CommandId,
  MessageId,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ClientCommandNormalizationError,
  type ClientCommandDispatcherShape,
} from "../Services/ClientCommandDispatcher.ts";
import {
  makeClientCommandDispatcher,
  type ClientCommandDispatcherDependencies,
} from "./ClientCommandDispatcher.ts";

const createdAt = "2026-07-10T12:00:00.000Z";
const projectId = ProjectId.make("project-client-command-dispatcher");
const threadId = ThreadId.make("thread-client-command-dispatcher");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

function threadShell(sessionStatus: OrchestrationThreadShell["session"] = null) {
  return {
    id: threadId,
    projectId,
    title: "Dispatcher thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    session: sessionStatus,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } satisfies OrchestrationThreadShell;
}

function makeHarness(input?: {
  readonly dispatch?: ClientCommandDispatcherDependencies["orchestrationEngine"]["dispatch"];
  readonly getThreadShellById?: ClientCommandDispatcherDependencies["projectionSnapshotQuery"]["getThreadShellById"];
  readonly normalize?: ClientCommandDispatcherDependencies["normalize"];
}) {
  const commands: Array<OrchestrationCommand> = [];
  const terminalCloses: Array<string> = [];
  const statusRefreshes: Array<string> = [];
  let uuid = 0;
  const dispatch =
    input?.dispatch ??
    ((command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }));
  const normalize =
    input?.normalize ??
    ((command: ClientOrchestrationCommand) =>
      decodeOrchestrationCommand(command).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: "Test command normalization failed.",
              cause,
            }),
        ),
      ));
  const dependencies: ClientCommandDispatcherDependencies = {
    normalize,
    orchestrationEngine: { dispatch },
    projectionSnapshotQuery: {
      getThreadShellById:
        input?.getThreadShellById ??
        (() => Effect.succeed(Option.none<OrchestrationThreadShell>())),
    },
    gitWorkflow: {
      fetchRemote: () => Effect.void,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "origin-commit", remoteRefName: "origin/main" }),
      createWorktree: () =>
        Effect.succeed({
          worktree: { path: "/tmp/dispatcher-worktree", refName: "feature/dispatcher" },
        }),
    },
    projectSetupScriptRunner: {
      runForThread: () => Effect.succeed({ status: "no-script" }),
    },
    terminalManager: {
      close: ({ threadId: closingThreadId }) =>
        Effect.sync(() => {
          terminalCloses.push(closingThreadId);
        }),
    },
    vcsStatusBroadcaster: {
      refreshStatus: (cwd) =>
        Effect.sync(() => {
          statusRefreshes.push(cwd);
          return {
            isRepo: false,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          };
        }),
    },
    startup: {
      enqueueCommand: (effect) => effect,
    },
    randomUUID: Effect.sync(() => `uuid-${++uuid}`),
    nowIso: Effect.succeed(createdAt),
  };
  return {
    dispatcher: makeClientCommandDispatcher(dependencies),
    commands,
    terminalCloses,
    statusRefreshes,
  };
}

const projectCreateCommand = (): ClientOrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make("command-project-create"),
  projectId,
  title: "Dispatcher project",
  workspaceRoot: "/tmp/dispatcher-project",
  createdAt,
});

const bootstrapTurnCommand = (): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("command-bootstrap-turn"),
  threadId,
  message: {
    messageId: MessageId.make("message-bootstrap-turn"),
    role: "user",
    text: "Start the task",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId,
      title: "Dispatcher thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
    prepareWorktree: {
      projectCwd: "/tmp/dispatcher-project",
      baseBranch: "main",
      branch: "feature/dispatcher",
    },
  },
  createdAt,
});

it.effect("normalizes and dispatches ordinary client commands through the startup gate", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* harness.dispatcher.dispatch(projectCreateCommand());

    assert.equal(result.sequence, 1);
    assert.deepEqual(
      harness.commands.map((command) => command.type),
      ["project.create"],
    );
  }),
);

it.effect("runs bootstrap creation, worktree preparation, and final turn in order", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* harness.dispatcher.dispatch(bootstrapTurnCommand());

    assert.deepEqual(
      harness.commands.map((command) => command.type),
      ["thread.create", "thread.meta.update", "thread.turn.start"],
    );
    const metaUpdate = harness.commands[1];
    assert.equal(metaUpdate?.type, "thread.meta.update");
    if (metaUpdate?.type === "thread.meta.update") {
      assert.equal(metaUpdate.branch, "feature/dispatcher");
      assert.equal(metaUpdate.worktreePath, "/tmp/dispatcher-worktree");
    }
  }),
);

it.effect("deletes a bootstrap-created thread when the final turn fails", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const failure = new Error("turn failed");
    const harness = makeHarness({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return command.type;
        }).pipe(
          Effect.flatMap((type) =>
            type === "thread.turn.start"
              ? Effect.die(failure)
              : Effect.succeed({ sequence: commands.length }),
          ),
        ),
    });

    const error = yield* Effect.flip(harness.dispatcher.dispatch(bootstrapTurnCommand()));
    assert.equal(error._tag, "OrchestrationDispatchCommandError");
    assert.include(error.message, "turn failed");
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.create", "thread.meta.update", "thread.turn.start", "thread.delete"],
    );
  }),
);

it.effect("archives, stops an active provider session, and closes terminals", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      getThreadShellById: () =>
        Effect.succeed(
          Option.some(
            threadShell({
              threadId,
              status: "ready",
              providerName: "Codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            }),
          ),
        ),
    });
    yield* harness.dispatcher.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command-thread-archive"),
      threadId,
    });

    assert.deepEqual(
      harness.commands.map((command) => command.type),
      ["thread.archive", "thread.session.stop"],
    );
    const stop = harness.commands[1];
    assert.equal(stop?.commandId, "session-stop-for-archive:command-thread-archive");
    assert.deepEqual(harness.terminalCloses, [threadId]);
  }),
);

it.effect("distinguishes normalization failures from dispatch failures", () =>
  Effect.gen(function* () {
    const cause = new OrchestrationDispatchCommandError({ message: "invalid workspace" });
    const dispatcher: ClientCommandDispatcherShape = makeHarness({
      normalize: () => Effect.fail(cause),
    }).dispatcher;

    const error = yield* Effect.flip(dispatcher.dispatch(projectCreateCommand()));
    assert.isTrue(Schema.is(ClientCommandNormalizationError)(error));
    if (Schema.is(ClientCommandNormalizationError)(error)) assert.equal(error.cause, cause);
  }),
);

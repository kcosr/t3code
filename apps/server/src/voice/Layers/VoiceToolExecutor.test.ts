import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthVoiceUseScope,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceConversationId,
  VoiceSessionId,
  VoiceToolCallId,
  type AuthEnvironmentScope,
  type ClientOrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ClientCommandDispatcher } from "../../orchestration/Services/ClientCommandDispatcher.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type DurableVoiceToolCall,
  VoiceToolCallRepository,
} from "../../persistence/Services/VoiceToolCalls.ts";
import { VoiceConversationService } from "../Services/VoiceConversationService.ts";
import { VoiceToolExecutor } from "../Services/VoiceToolExecutor.ts";
import { VoiceToolExecutorLive } from "./VoiceToolExecutor.ts";

const projectId = ProjectId.make("project-one");
const threadId = ThreadId.make("thread-one");
const sessionId = VoiceSessionId.make("voice-session-one");
const conversationId = VoiceConversationId.make("voice-conversation-one");
const now = "2026-07-10T12:00:00.000Z";

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "T3 Code",
  workspaceRoot: "/work/t3code",
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-test",
  },
  scripts: [],
  createdAt: now,
  updatedAt: now,
};

const thread: OrchestrationThreadShell = {
  id: threadId,
  projectId,
  title: "Voice implementation",
  modelSelection: project.defaultModelSelection!,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/voice",
  worktreePath: "/work/t3code",
  latestTurn: {
    turnId: "turn-one" as never,
    state: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  session: null,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 8,
  projects: [project],
  threads: [thread],
  updatedAt: now,
};
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString) as (
  input: string,
) => Record<string, unknown>;

const makeTest = Effect.fn("test.makeVoiceToolExecutor")(function* (
  retention: "durable" | "ephemeral" = "durable",
) {
  const commands = yield* Ref.make<Array<ClientOrchestrationCommand>>([]);
  const journal = yield* Ref.make<
    Array<{ readonly entryId?: string; readonly kind: string; readonly payload: unknown }>
  >([]);
  const durableCalls = yield* Ref.make(new Map<string, DurableVoiceToolCall>());
  const query = {
    getShellSnapshot: () => Effect.succeed(snapshot),
    getProjectShellById: (id: ProjectId) =>
      Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    getThreadShellById: (id: ThreadId) =>
      Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const dispatcher = ClientCommandDispatcher.of({
    dispatch: (command) =>
      Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 42 })),
  });
  const conversations = VoiceConversationService.of({
    create: () => Effect.die("unused"),
    listDurable: Effect.die("unused"),
    get: () =>
      Effect.succeed(
        Option.some({
          conversationId,
          retention,
          title: null,
          activeEpoch: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    delete: () => Effect.die("unused"),
    clearContext: () => Effect.die("unused"),
    listContext: () => Effect.die("unused"),
    appendContext: (entry) =>
      Ref.update(journal, (all) => [...all, entry]).pipe(
        Effect.as({
          entryId: `entry-${entry.kind}`,
          conversationId,
          epoch: 1,
          sequence: 1,
          kind: entry.kind,
          payload: entry.payload,
          occurredAt: now,
        }),
      ),
    appendContextIdempotent: (entry) =>
      Ref.modify(journal, (all) => {
        const existing = all.find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "entryId" in item &&
            item.entryId === entry.entryId,
        );
        const next = existing === undefined ? [...all, entry] : all;
        return [
          {
            entryId: entry.entryId,
            conversationId,
            epoch: 1,
            sequence: next.length,
            kind: entry.kind,
            payload: entry.payload,
            occurredAt: now,
          },
          next,
        ] as const;
      }),
  });
  const durableKey = (input: { readonly conversationId: string; readonly toolCallId: string }) =>
    `${input.conversationId}:${input.toolCallId}`;
  const toolCallRepository = VoiceToolCallRepository.of({
    createRequested: (input) =>
      Ref.modify(
        durableCalls,
        (
          calls,
        ): readonly [
          { readonly call: DurableVoiceToolCall; readonly created: boolean },
          Map<string, DurableVoiceToolCall>,
        ] => {
          const key = durableKey(input);
          const existing = calls.get(key);
          if (existing !== undefined) return [{ call: existing, created: false }, calls] as const;
          const call: DurableVoiceToolCall = {
            ...input,
            status: "requested",
            confirmationId: null,
            summary: null,
            commandId: null,
            commandJson: null,
            resultOutput: null,
            updatedAt: input.createdAt,
            expiresAt: null,
          };
          return [{ call, created: true }, new Map(calls).set(key, call)] as const;
        },
      ),
    get: (input) =>
      Ref.get(durableCalls).pipe(
        Effect.map((calls) => Option.fromUndefinedOr(calls.get(durableKey(input)))),
      ),
    getByConfirmationId: (confirmationId) =>
      Ref.get(durableCalls).pipe(
        Effect.map((calls) =>
          Option.fromUndefinedOr(
            [...calls.values()].find((call) => call.confirmationId === confirmationId),
          ),
        ),
      ),
    markPending: (input) =>
      Ref.modify(durableCalls, (calls) => {
        const key = durableKey(input);
        const existing = calls.get(key)!;
        const call: DurableVoiceToolCall = {
          ...existing,
          status: "pending-confirmation",
          sessionId: input.sessionId,
          confirmationId: input.confirmationId,
          summary: input.summary,
          commandId: input.commandId,
          commandJson: input.commandJson,
          updatedAt: input.updatedAt,
          expiresAt: input.expiresAt,
        };
        return [call, new Map(calls).set(key, call)] as const;
      }),
    markTerminal: (input) =>
      Ref.modify(durableCalls, (calls) => {
        const key = durableKey(input);
        const existing = calls.get(key)!;
        const call: DurableVoiceToolCall = {
          ...existing,
          status: input.status,
          resultOutput: input.resultOutput,
          updatedAt: input.updatedAt,
        };
        return [call, new Map(calls).set(key, call)] as const;
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, query),
    Layer.succeed(ClientCommandDispatcher, dispatcher),
    Layer.succeed(VoiceConversationService, conversations),
    Layer.succeed(VoiceToolCallRepository, toolCallRepository),
    NodeServices.layer,
  );
  return {
    commands,
    journal,
    durableCalls,
    dependencies,
    layer: VoiceToolExecutorLive.pipe(Layer.provide(dependencies)),
  };
});

const call = (
  name: string,
  argumentsJson: string,
  id = name,
  grantedScopes: ReadonlySet<AuthEnvironmentScope> = new Set([
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
  ]),
) => ({
  sessionId,
  conversationId,
  toolCallId: VoiceToolCallId.make(id),
  providerFunctionCallId: id,
  name,
  argumentsJson,
  grantedScopes,
});

it.effect("executes read tools, strictly decodes arguments, and deduplicates provider calls", () =>
  Effect.gen(function* () {
    const test = yield* makeTest();
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const projects = yield* tools.invoke(call("list_projects", '{"limit":10}'));
      expect(projects.type).toBe("completed");
      if (projects.type !== "completed") return;
      expect(decodeJson(projects.output)).toEqual({
        projects: [{ projectId, title: "T3 Code", workspaceRoot: "/work/t3code" }],
      });
      expect(projects.outcome).toBe("succeeded");

      const duplicate = yield* tools.invoke(call("list_projects", '{"limit":10}'));
      expect(duplicate.type === "completed" && duplicate.submitOutput).toBe(false);
      expect(yield* Ref.get(test.journal)).toHaveLength(2);

      const threads = yield* tools.invoke(
        call("list_threads", encodeJson({ projectId, limit: 10 })),
      );
      expect(threads.type === "completed" && decodeJson(threads.output).threads).toHaveLength(1);

      const status = yield* tools.invoke(call("get_thread_status", encodeJson({ threadId })));
      const statusOutput = status.type === "completed" ? decodeJson(status.output) : undefined;
      expect(
        statusOutput !== undefined &&
          typeof statusOutput.thread === "object" &&
          statusOutput.thread !== null &&
          "turnState" in statusOutput.thread
          ? statusOutput.thread.turnState
          : undefined,
      ).toBe("running");

      const invalid = yield* tools.invoke(
        call("list_projects", '{"limit":10,"extra":true}', "bad"),
      );
      expect(invalid.type === "completed" && invalid.outcome).toBe("failed");
      expect(yield* Ref.get(test.commands)).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("enforces the orchestration scope required by each tool class", () =>
  Effect.gen(function* () {
    const test = yield* makeTest();
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const voiceOnly = new Set<AuthEnvironmentScope>([AuthVoiceUseScope]);

      const deniedRead = yield* tools.invoke(
        call("list_projects", '{"limit":10}', "denied-read", voiceOnly),
      );
      expect(deniedRead.type === "completed" && deniedRead.outcome).toBe("failed");
      expect(deniedRead.type === "completed" ? decodeJson(deniedRead.output) : undefined).toEqual({
        error: "Voice tool requires orchestration:read",
      });

      const deniedWrite = yield* tools.invoke(
        call(
          "archive_thread",
          encodeJson({ threadId }),
          "denied-write",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(deniedWrite.type === "completed" && deniedWrite.outcome).toBe("failed");
      expect(yield* Ref.get(test.commands)).toHaveLength(0);

      const allowedRead = yield* tools.invoke(
        call(
          "list_projects",
          '{"limit":10}',
          "allowed-read",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(allowedRead.type === "completed" && allowedRead.outcome).toBe("succeeded");

      const allowedWrite = yield* tools.invoke(
        call(
          "archive_thread",
          encodeJson({ threadId }),
          "allowed-write",
          new Set([AuthOrchestrationOperateScope]),
        ),
      );
      expect(allowedWrite.type).toBe("confirmation-required");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect(
  "requires confirmation and dispatches every mutation through the canonical dispatcher",
  () =>
    Effect.gen(function* () {
      const test = yield* makeTest();
      yield* Effect.gen(function* () {
        const tools = yield* VoiceToolExecutor;
        const mutations = [
          call("create_thread", encodeJson({ projectId, title: "From voice" })),
          call("send_thread_message", encodeJson({ threadId, message: "Run the tests" })),
          call("interrupt_thread", encodeJson({ threadId })),
          call("archive_thread", encodeJson({ threadId })),
        ];
        const expectedTypes = [
          "thread.create",
          "thread.turn.start",
          "thread.turn.interrupt",
          "thread.archive",
        ];
        for (const mutation of mutations) {
          const pending = yield* tools.invoke(mutation);
          expect(pending.type).toBe("confirmation-required");
          if (pending.type !== "confirmation-required") continue;
          const duplicate = yield* tools.invoke(mutation);
          expect(duplicate.type === "confirmation-required" && duplicate.newlyCreated).toBe(false);
          const completed = yield* tools.decide({
            sessionId,
            confirmationId: pending.confirmationId,
            decision: "approve",
          });
          expect(completed.outcome).toBe("succeeded");
          expect(decodeJson(completed.output)).toMatchObject({ sequence: 42 });
          expect(decodeJson(completed.output).threadId).toBeTruthy();
          const repeated = yield* tools
            .decide({ sessionId, confirmationId: pending.confirmationId, decision: "approve" })
            .pipe(Effect.flip);
          expect(repeated.reason).toBe("confirmation-expired");
        }
        expect((yield* Ref.get(test.commands)).map((command) => command.type)).toEqual(
          expectedTypes,
        );
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("rejects without dispatch and expires pending calls exactly once", () =>
  Effect.gen(function* () {
    const test = yield* makeTest();
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const rejected = yield* tools.invoke(
        call("archive_thread", encodeJson({ threadId }), "reject-call"),
      );
      if (rejected.type !== "confirmation-required") return;
      const rejection = yield* tools.decide({
        sessionId,
        confirmationId: rejected.confirmationId,
        decision: "reject",
      });
      expect(rejection.outcome).toBe("rejected");
      expect(yield* Ref.get(test.commands)).toHaveLength(0);

      const expiring = yield* tools.invoke(
        call("send_thread_message", encodeJson({ threadId, message: "Do it" }), "expire-call"),
      );
      if (expiring.type !== "confirmation-required") return;
      yield* TestClock.adjust("31 seconds");
      const expired = yield* tools.expire({
        sessionId,
        confirmationId: expiring.confirmationId,
      });
      expect(expired?.outcome).toBe("expired");
      expect(
        yield* tools.expire({ sessionId, confirmationId: expiring.confirmationId }),
      ).toBeUndefined();
      const decision = yield* tools
        .decide({ sessionId, confirmationId: expiring.confirmationId, decision: "approve" })
        .pipe(Effect.flip);
      expect(decision.reason).toBe("confirmation-expired");
      expect(yield* Ref.get(test.commands)).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("survives executor restart and reuses the deterministic orchestration command", () =>
  Effect.gen(function* () {
    const test = yield* makeTest();
    const mutation = call(
      "send_thread_message",
      encodeJson({ threadId, message: "Resume safely" }),
      "restart-call",
    );
    const pending = yield* Effect.gen(function* () {
      return yield* (yield* VoiceToolExecutor).invoke(mutation);
    }).pipe(Effect.provide(test.layer));
    expect(pending.type).toBe("confirmation-required");
    if (pending.type !== "confirmation-required") return;

    const restartedLayer = VoiceToolExecutorLive.pipe(Layer.provide(test.dependencies));
    const result = yield* Effect.gen(function* () {
      return yield* (yield* VoiceToolExecutor).decide({
        sessionId,
        confirmationId: pending.confirmationId,
        decision: "approve",
      });
    }).pipe(Effect.provide(restartedLayer));
    expect(result.outcome).toBe("succeeded");

    const afterSecondRestart = yield* Effect.gen(function* () {
      return yield* (yield* VoiceToolExecutor).invoke(mutation);
    }).pipe(Effect.provide(VoiceToolExecutorLive.pipe(Layer.provide(test.dependencies))));
    expect(afterSecondRestart.type === "completed" && afterSecondRestart.submitOutput).toBe(true);
    const commands = yield* Ref.get(test.commands);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandId).toBe(`voice:${conversationId}:restart-call`);
  }),
);

it.effect("canonicalizes arguments and rejects changed reuse of a durable tool-call id", () =>
  Effect.gen(function* () {
    const test = yield* makeTest();
    const first = call("list_projects", '{"limit":10}', "canonical-call");
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      yield* tools.invoke(first);
      const reordered = yield* tools.invoke(
        call("list_projects", '{ "limit" : 10 }', "canonical-call"),
      );
      expect(reordered.type).toBe("completed");
      const conflict = yield* tools
        .invoke(call("list_projects", '{"limit":11}', "canonical-call"))
        .pipe(Effect.flip);
      expect(conflict.operation).toBe("tool.idempotency");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("keeps ephemeral conversation tool calls out of durable persistence", () =>
  Effect.gen(function* () {
    const test = yield* makeTest("ephemeral");
    yield* Effect.gen(function* () {
      const result = yield* (yield* VoiceToolExecutor).invoke(
        call("list_projects", '{"limit":10}', "ephemeral-call"),
      );
      expect(result.type === "completed" && result.outcome).toBe("succeeded");
    }).pipe(Effect.provide(test.layer));
    expect((yield* Ref.get(test.durableCalls)).size).toBe(0);
  }),
);

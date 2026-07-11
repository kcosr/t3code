import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthVoiceUseScope,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VoiceConversationId,
  VoiceConversationEntryId,
  VoiceSessionId,
  VoiceToolCallId,
  type AuthEnvironmentScope,
  type ClientOrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ClientCommandDispatcher } from "../../orchestration/Services/ClientCommandDispatcher.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";
import {
  type ProjectionTurnStartOutcome,
  ProjectionTurnStartRepository,
} from "../../persistence/Services/ProjectionTurnStarts.ts";
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
const nextMinute = "2026-07-10T12:01:00.000Z";
const turnId = TurnId.make("turn-from-voice-message");

const projectionMessage = (input: {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly turnId?: TurnId | null;
  readonly isStreaming?: boolean;
}): ProjectionThreadMessage => ({
  messageId: input.messageId,
  threadId,
  turnId: input.turnId ?? null,
  role: input.role,
  text: input.text,
  isStreaming: input.isStreaming ?? false,
  createdAt: input.createdAt,
  updatedAt: input.createdAt,
});

const projectionTurn = (input: {
  readonly pendingMessageId: MessageId;
  readonly state: ProjectionTurn["state"];
  readonly assistantMessageId?: MessageId | null;
  readonly turnId?: TurnId;
}): ProjectionTurnStartOutcome => ({
  start: {
    threadId,
    messageId: input.pendingMessageId,
    turnId: input.turnId ?? turnId,
    state: "accepted",
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    requestedAt: now,
    resolvedAt: now,
  },
  turn: {
    threadId,
    turnId: input.turnId ?? turnId,
    assistantMessageId: input.assistantMessageId ?? null,
    state: input.state,
    requestedAt: now,
    startedAt: now,
    completedAt:
      input.state === "completed" || input.state === "interrupted" || input.state === "error"
        ? nextMinute
        : null,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
  },
});

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
  projection?: {
    readonly messages?: ReadonlyArray<ProjectionThreadMessage>;
    readonly turns?: ReadonlyArray<ProjectionTurnStartOutcome>;
    readonly thread?: OrchestrationThreadShell;
    readonly blockMessagePage?: boolean;
    readonly blockTurnLookupAfterFirst?: boolean;
  },
) {
  const commands = yield* Ref.make<Array<ClientOrchestrationCommand>>([]);
  const journal = yield* Ref.make<
    Array<{ readonly entryId?: string; readonly kind: string; readonly payload: unknown }>
  >([]);
  const durableCalls = yield* Ref.make(new Map<string, DurableVoiceToolCall>());
  const projectionMessages = yield* Ref.make([...(projection?.messages ?? [])]);
  const projectionTurns = yield* Ref.make([...(projection?.turns ?? [])]);
  const turnLookupCount = yield* Ref.make(0);
  const turnLookupStarted = yield* Deferred.make<void>();
  const messagePageStarted = yield* Deferred.make<void>();
  const messagePageRelease = yield* Deferred.make<void>();
  const threadShell = yield* Ref.make(projection?.thread ?? thread);
  const query = {
    getShellSnapshot: () => Effect.succeed(snapshot),
    getProjectShellById: (id: ProjectId) =>
      Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    getThreadShellById: (id: ThreadId) =>
      Ref.get(threadShell).pipe(
        Effect.map((current) => (id === threadId ? Option.some(current) : Option.none())),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const dispatcher = ClientCommandDispatcher.of({
    dispatch: (command) =>
      Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 42 })),
  });
  const messageRepository = {
    upsert: () => Effect.die("unused"),
    getByMessageId: ({ messageId }: { readonly messageId: MessageId }) =>
      Ref.get(projectionMessages).pipe(
        Effect.map((all) =>
          Option.fromUndefinedOr(all.find((item) => item.messageId === messageId)),
        ),
      ),
    listByThreadId: () => Effect.die("unused"),
    listPageByThreadId: (input: {
      readonly threadId: ThreadId;
      readonly limit: number;
      readonly before?: { readonly createdAt: string; readonly messageId: MessageId };
      readonly includeStreaming?: boolean;
    }) =>
      (projection?.blockMessagePage === true
        ? Deferred.succeed(messagePageStarted, undefined).pipe(
            Effect.andThen(Deferred.await(messagePageRelease)),
          )
        : Effect.void
      ).pipe(
        Effect.andThen(Ref.get(projectionMessages)),
        Effect.map((all) => {
          const candidates = all
            .filter(
              (item) =>
                item.threadId === input.threadId &&
                (item.role === "user" || item.role === "assistant") &&
                (input.includeStreaming === true || !item.isStreaming) &&
                (input.before === undefined ||
                  item.createdAt < input.before.createdAt ||
                  (item.createdAt === input.before.createdAt &&
                    item.messageId < input.before.messageId)),
            )
            .toSorted((left, right) =>
              right.createdAt === left.createdAt
                ? right.messageId.localeCompare(left.messageId)
                : right.createdAt.localeCompare(left.createdAt),
            );
          const selected = candidates.slice(0, input.limit);
          const oldest = selected.at(-1);
          return {
            messages: selected.toReversed(),
            nextCursor:
              candidates.length > input.limit && oldest !== undefined
                ? { createdAt: oldest.createdAt, messageId: oldest.messageId }
                : null,
          };
        }),
      ),
    deleteByThreadId: () => Effect.die("unused"),
  } as unknown as ProjectionThreadMessageRepository["Service"];
  const turnStartRepository = {
    upsert: () => Effect.die("unused"),
    getByMessageId: () => Effect.die("unused"),
    getOutcomeByMessageId: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) =>
      Deferred.succeed(turnLookupStarted, undefined).pipe(
        Effect.andThen(Ref.getAndUpdate(turnLookupCount, (count) => count + 1)),
        Effect.flatMap((lookupCount) =>
          projection?.blockTurnLookupAfterFirst === true && lookupCount > 0
            ? Effect.never
            : Ref.get(projectionTurns),
        ),
        Effect.map((all) =>
          Option.fromUndefinedOr(
            all.find(
              (item) =>
                item.start.threadId === input.threadId && item.start.messageId === input.messageId,
            ),
          ),
        ),
      ),
    listByThreadId: () => Effect.die("unused"),
    deleteByThreadId: () => Effect.die("unused"),
  } as unknown as ProjectionTurnStartRepository["Service"];
  const conversations = VoiceConversationService.of({
    create: () => Effect.die("unused"),
    listDurable: () => Effect.die("unused"),
    get: () =>
      Effect.succeed(
        Option.some({
          conversationId,
          retention,
          title: null,
          activeEpoch: 1,
          lastCallAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    updateTitle: () => Effect.die("unused"),
    markCallStarted: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    clearContext: () => Effect.die("unused"),
    listTranscript: () => Effect.die("unused"),
    listContext: () => Effect.die("unused"),
    appendContext: (entry) =>
      Ref.update(journal, (all) => [...all, entry]).pipe(
        Effect.as({
          entryId: VoiceConversationEntryId.make(`entry-${entry.kind}`),
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
    terminalizeSession: (input) =>
      Ref.update(
        durableCalls,
        (calls) =>
          new Map(
            [...calls.entries()].map(([key, call]) => [
              key,
              call.sessionId === input.sessionId &&
              (call.status === "requested" || call.status === "pending-confirmation")
                ? {
                    ...call,
                    status: "failed" as const,
                    resultOutput: input.resultOutput,
                    updatedAt: input.updatedAt,
                  }
                : call,
            ]),
          ),
      ),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, query),
    Layer.succeed(ProjectionThreadMessageRepository, messageRepository),
    Layer.succeed(ProjectionTurnStartRepository, turnStartRepository),
    Layer.succeed(ClientCommandDispatcher, dispatcher),
    Layer.succeed(VoiceConversationService, conversations),
    Layer.succeed(VoiceToolCallRepository, toolCallRepository),
    NodeServices.layer,
  );
  return {
    commands,
    journal,
    durableCalls,
    projectionMessages,
    projectionTurns,
    turnLookupCount,
    turnLookupStarted,
    messagePageStarted,
    messagePageRelease,
    threadShell,
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
  contextEpoch: 1,
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

it.effect("reads bounded message pages with opaque cursors and excludes streaming messages", () =>
  Effect.gen(function* () {
    const oldestMessageId = MessageId.make("message-oldest");
    const newestMessageId = MessageId.make("message-newest");
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: oldestMessageId,
          role: "user",
          text: "older question",
          createdAt: now,
        }),
        projectionMessage({
          messageId: newestMessageId,
          role: "assistant",
          text: "x".repeat(5_000),
          createdAt: nextMinute,
          turnId,
        }),
        projectionMessage({
          messageId: MessageId.make("message-streaming"),
          role: "assistant",
          text: "not authoritative yet",
          createdAt: "2026-07-10T12:02:00.000Z",
          turnId,
          isStreaming: true,
        }),
        {
          ...projectionMessage({
            messageId: MessageId.make("message-system"),
            role: "assistant",
            text: "internal system context",
            createdAt: "2026-07-10T12:03:00.000Z",
          }),
          role: "system",
        },
      ],
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const first = yield* tools.invoke(
        call(
          "get_thread_messages",
          encodeJson({ threadId, limit: 1 }),
          "messages-first",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(first.type).toBe("completed");
      if (first.type !== "completed") return;
      const firstOutput = decodeJson(first.output);
      const firstMessages = firstOutput.messages as Array<Record<string, unknown>>;
      expect(firstMessages).toHaveLength(1);
      expect(firstMessages[0]).toMatchObject({
        messageId: newestMessageId,
        role: "assistant",
        truncated: true,
      });
      expect((firstMessages[0]!.text as string).length).toBe(4_000);
      expect(typeof firstOutput.nextCursor).toBe("string");
      expect(firstMessages.some((message) => message.role === "system")).toBe(false);

      const second = yield* tools.invoke(
        call(
          "get_thread_messages",
          encodeJson({ threadId, limit: 1, cursor: firstOutput.nextCursor }),
          "messages-second",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      const secondOutput = second.type === "completed" ? decodeJson(second.output) : {};
      expect(secondOutput.messages).toEqual([
        expect.objectContaining({ messageId: oldestMessageId, text: "older question" }),
      ]);
      expect(secondOutput.nextCursor).toBeNull();

      const invalid = yield* tools.invoke(
        call(
          "get_thread_messages",
          encodeJson({ threadId, limit: 1, cursor: "not-a-cursor" }),
          "messages-invalid-cursor",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(invalid.type === "completed" && invalid.outcome).toBe("failed");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("keeps messages excluded by the page character budget reachable by cursor", () =>
  Effect.gen(function* () {
    const messageIds = Array.from({ length: 6 }, (_, index) =>
      MessageId.make(`message-budget-${index + 1}`),
    );
    const test = yield* makeTest("durable", {
      messages: messageIds.map((messageId, index) =>
        projectionMessage({
          messageId,
          role: index % 2 === 0 ? "user" : "assistant",
          text: String(index + 1).repeat(4_000),
          createdAt: `2026-07-10T12:0${index}:00.000Z`,
        }),
      ),
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const first = yield* tools.invoke(
        call(
          "get_thread_messages",
          encodeJson({ threadId, limit: 6 }),
          "messages-budget-first",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      const firstOutput = first.type === "completed" ? decodeJson(first.output) : {};
      expect(
        (firstOutput.messages as Array<{ readonly messageId: MessageId }>).map(
          (message) => message.messageId,
        ),
      ).toEqual(messageIds.slice(2));
      expect(typeof firstOutput.nextCursor).toBe("string");

      const second = yield* tools.invoke(
        call(
          "get_thread_messages",
          encodeJson({ threadId, limit: 6, cursor: firstOutput.nextCursor }),
          "messages-budget-second",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      const secondOutput = second.type === "completed" ? decodeJson(second.output) : {};
      expect(
        (secondOutput.messages as Array<{ readonly messageId: MessageId }>).map(
          (message) => message.messageId,
        ),
      ).toEqual(messageIds.slice(0, 2));
      expect(secondOutput.nextCursor).toBeNull();
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("waits for the exact dispatched message and returns its terminal assistant output", () =>
  Effect.gen(function* () {
    const userMessageId = MessageId.make("message-user-wait");
    const assistantMessageId = MessageId.make("message-assistant-wait");
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: userMessageId,
          role: "user",
          text: "Run the tests",
          createdAt: now,
        }),
        projectionMessage({
          messageId: assistantMessageId,
          role: "assistant",
          text: "All tests passed.",
          createdAt: nextMinute,
          turnId,
        }),
      ],
      turns: [
        projectionTurn({
          pendingMessageId: userMessageId,
          assistantMessageId,
          state: "completed",
        }),
      ],
    });
    yield* Effect.gen(function* () {
      const result = yield* (yield* VoiceToolExecutor).invoke(
        call(
          "wait_for_thread_turn",
          encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 1_000 }),
          "wait-completed",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(result.type).toBe("completed");
      expect(result.type === "completed" ? decodeJson(result.output) : undefined).toEqual({
        state: "completed",
        turnId,
        assistantMessage: {
          messageId: assistantMessageId,
          text: "All tests passed.",
          truncated: false,
          createdAt: nextMinute,
          updatedAt: nextMinute,
        },
      });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("waits for the canonical assistant message to finish projecting", () =>
  Effect.gen(function* () {
    const userMessageId = MessageId.make("message-user-finalizing");
    const assistantMessageId = MessageId.make("message-assistant-finalizing");
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: userMessageId,
          role: "user",
          text: "Summarize the result",
          createdAt: now,
        }),
      ],
      turns: [
        projectionTurn({
          pendingMessageId: userMessageId,
          assistantMessageId,
          state: "completed",
        }),
      ],
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const waiting = yield* tools
        .invoke(
          call(
            "wait_for_thread_turn",
            encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 1_000 }),
            "wait-finalizing-assistant",
            new Set([AuthOrchestrationReadScope]),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(test.turnLookupStarted);

      yield* Ref.update(test.projectionMessages, (all) => [
        ...all,
        projectionMessage({
          messageId: assistantMessageId,
          role: "assistant",
          text: "Partial",
          createdAt: nextMinute,
          turnId,
          isStreaming: true,
        }),
      ]);
      yield* TestClock.adjust("250 millis");
      yield* Ref.update(test.projectionMessages, (all) =>
        all.map((message) =>
          message.messageId === assistantMessageId
            ? { ...message, text: "Final answer", isStreaming: false }
            : message,
        ),
      );
      yield* TestClock.adjust("250 millis");

      const result = yield* Fiber.join(waiting);
      expect(result.type === "completed" ? decodeJson(result.output) : undefined).toEqual({
        state: "completed",
        turnId,
        assistantMessage: {
          messageId: assistantMessageId,
          text: "Final answer",
          truncated: false,
          createdAt: nextMinute,
          updatedAt: nextMinute,
        },
      });
      const persisted = [...(yield* Ref.get(test.durableCalls)).values()];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.resultOutput).toBe(result.type === "completed" ? result.output : null);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("rejects a wait for a message owned by another thread", () =>
  Effect.gen(function* () {
    const userMessageId = MessageId.make("message-from-another-thread");
    const test = yield* makeTest("durable", {
      messages: [
        {
          ...projectionMessage({
            messageId: userMessageId,
            role: "user",
            text: "Do not cross thread boundaries",
            createdAt: now,
          }),
          threadId: ThreadId.make("thread-two"),
        },
      ],
    });
    yield* Effect.gen(function* () {
      const result = yield* (yield* VoiceToolExecutor).invoke(
        call(
          "wait_for_thread_turn",
          encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 1_000 }),
          "wait-wrong-thread",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(result.type === "completed" ? result.outcome : undefined).toBe("failed");
      expect(result.type === "completed" ? decodeJson(result.output) : undefined).toEqual({
        error:
          "Voice tool.wait-for-thread-turn failed (invalid-phase): The dispatched thread message was not found",
      });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("rejects a wait for a non-user message in the requested thread", () =>
  Effect.gen(function* () {
    const assistantMessageId = MessageId.make("message-assistant-not-dispatch");
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: assistantMessageId,
          role: "assistant",
          text: "Not a dispatched user message",
          createdAt: now,
        }),
      ],
    });
    yield* Effect.gen(function* () {
      const result = yield* (yield* VoiceToolExecutor).invoke(
        call(
          "wait_for_thread_turn",
          encodeJson({ threadId, messageId: assistantMessageId, waitMilliseconds: 1_000 }),
          "wait-non-user-message",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(result.type === "completed" ? result.outcome : undefined).toBe("failed");
      expect(result.type === "completed" ? decodeJson(result.output) : undefined).toEqual({
        error:
          "Voice tool.wait-for-thread-turn failed (invalid-phase): The dispatched thread message was not found",
      });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect(
  "maps terminal failures, preserves interruptions, and ignores unrelated interaction flags",
  () =>
    Effect.gen(function* () {
      const failedMessageId = MessageId.make("message-user-failed");
      const interruptedMessageId = MessageId.make("message-user-interrupted");
      const failedAssistantMessageId = MessageId.make("message-assistant-failed");
      const failedTurnId = TurnId.make("turn-failed");
      const interruptedTurnId = TurnId.make("turn-interrupted");
      const test = yield* makeTest("durable", {
        messages: [
          projectionMessage({
            messageId: failedMessageId,
            role: "user",
            text: "Run a failing task",
            createdAt: now,
          }),
          projectionMessage({
            messageId: interruptedMessageId,
            role: "user",
            text: "Run then interrupt",
            createdAt: now,
          }),
          projectionMessage({
            messageId: failedAssistantMessageId,
            role: "assistant",
            text: "x".repeat(9_000),
            createdAt: nextMinute,
            turnId: failedTurnId,
          }),
        ],
        turns: [
          projectionTurn({
            pendingMessageId: failedMessageId,
            assistantMessageId: failedAssistantMessageId,
            state: "error",
            turnId: failedTurnId,
          }),
          projectionTurn({
            pendingMessageId: interruptedMessageId,
            state: "interrupted",
            turnId: interruptedTurnId,
          }),
        ],
        thread: { ...thread, hasPendingApprovals: true, hasPendingUserInput: true },
      });
      yield* Effect.gen(function* () {
        const tools = yield* VoiceToolExecutor;
        const failed = yield* tools.invoke(
          call(
            "wait_for_thread_turn",
            encodeJson({ threadId, messageId: failedMessageId, waitMilliseconds: 1_000 }),
            "wait-failed",
            new Set([AuthOrchestrationReadScope]),
          ),
        );

        const failedOutput = failed.type === "completed" ? decodeJson(failed.output) : {};
        expect(failedOutput).toMatchObject({
          state: "failed",
          turnId: failedTurnId,
          assistantMessage: { messageId: failedAssistantMessageId, truncated: true },
        });
        expect(
          ((failedOutput.assistantMessage as { readonly text: string }).text as string).length,
        ).toBe(8_000);

        const interrupted = yield* tools.invoke(
          call(
            "wait_for_thread_turn",
            encodeJson({ threadId, messageId: interruptedMessageId, waitMilliseconds: 1_000 }),
            "wait-interrupted",
            new Set([AuthOrchestrationReadScope]),
          ),
        );

        expect(
          interrupted.type === "completed" ? decodeJson(interrupted.output) : undefined,
        ).toEqual({
          state: "interrupted",
          turnId: interruptedTurnId,
          assistantMessage: null,
        });
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("preserves terminal state when assistant output is partial or missing", () =>
  Effect.gen(function* () {
    const failedMessageId = MessageId.make("message-user-failed-partial");
    const interruptedMessageId = MessageId.make("message-user-interrupted-missing");
    const partialAssistantMessageId = MessageId.make("message-assistant-failed-partial");
    const missingAssistantMessageId = MessageId.make("message-assistant-interrupted-missing");
    const failedTurnId = TurnId.make("turn-failed-partial");
    const interruptedTurnId = TurnId.make("turn-interrupted-missing");
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: failedMessageId,
          role: "user",
          text: "Fail after partial output",
          createdAt: now,
        }),
        projectionMessage({
          messageId: interruptedMessageId,
          role: "user",
          text: "Interrupt before output finalizes",
          createdAt: now,
        }),
        projectionMessage({
          messageId: partialAssistantMessageId,
          role: "assistant",
          text: "Partial output",
          createdAt: nextMinute,
          turnId: failedTurnId,
          isStreaming: true,
        }),
      ],
      turns: [
        projectionTurn({
          pendingMessageId: failedMessageId,
          assistantMessageId: partialAssistantMessageId,
          state: "error",
          turnId: failedTurnId,
        }),
        projectionTurn({
          pendingMessageId: interruptedMessageId,
          assistantMessageId: missingAssistantMessageId,
          state: "interrupted",
          turnId: interruptedTurnId,
        }),
      ],
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const failed = yield* tools.invoke(
        call(
          "wait_for_thread_turn",
          encodeJson({ threadId, messageId: failedMessageId, waitMilliseconds: 1_000 }),
          "wait-failed-partial",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(failed.type === "completed" ? decodeJson(failed.output) : undefined).toEqual({
        state: "failed",
        turnId: failedTurnId,
        assistantMessage: null,
      });

      const interrupted = yield* tools.invoke(
        call(
          "wait_for_thread_turn",
          encodeJson({ threadId, messageId: interruptedMessageId, waitMilliseconds: 1_000 }),
          "wait-interrupted-missing",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(interrupted.type === "completed" ? decodeJson(interrupted.output) : undefined).toEqual(
        {
          state: "interrupted",
          turnId: interruptedTurnId,
          assistantMessage: null,
        },
      );
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("reports pending, accepted-without-lifecycle, failed, and ambiguous starts", () =>
  Effect.gen(function* () {
    const pendingMessageId = MessageId.make("message-start-pending");
    const acceptedMessageId = MessageId.make("message-start-accepted");
    const failedMessageId = MessageId.make("message-start-failed");
    const ambiguousMessageId = MessageId.make("message-start-ambiguous");
    const acceptedTurnId = TurnId.make("turn-accepted-before-lifecycle");
    const start = (
      messageId: MessageId,
      state: "pending" | "accepted" | "failed" | "ambiguous",
      acceptedId: TurnId | null,
    ) => ({
      start: {
        threadId,
        messageId,
        turnId: acceptedId,
        state,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: now,
        resolvedAt: state === "pending" ? null : nextMinute,
      },
      turn: null,
    });
    const test = yield* makeTest("durable", {
      messages: [pendingMessageId, acceptedMessageId, failedMessageId, ambiguousMessageId].map(
        (messageId) =>
          projectionMessage({ messageId, role: "user", text: "Run it", createdAt: now }),
      ),
      turns: [
        start(pendingMessageId, "pending", null),
        start(acceptedMessageId, "accepted", acceptedTurnId),
        start(failedMessageId, "failed", null),
        start(ambiguousMessageId, "ambiguous", null),
      ],
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const invokeBounded = (messageId: MessageId, id: string) =>
        tools.invoke(
          call(
            "wait_for_thread_turn",
            encodeJson({ threadId, messageId, waitMilliseconds: 250 }),
            id,
            new Set([AuthOrchestrationReadScope]),
          ),
        );

      const pendingFiber = yield* invokeBounded(pendingMessageId, "wait-start-pending").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      const pending = yield* Fiber.join(pendingFiber);
      expect(pending.type === "completed" ? decodeJson(pending.output) : undefined).toEqual({
        state: "pending",
        turnId: null,
      });

      const acceptedFiber = yield* invokeBounded(acceptedMessageId, "wait-start-accepted").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      const accepted = yield* Fiber.join(acceptedFiber);
      expect(accepted.type === "completed" ? decodeJson(accepted.output) : undefined).toEqual({
        state: "running",
        turnId: acceptedTurnId,
      });

      const failed = yield* invokeBounded(failedMessageId, "wait-start-failed");
      expect(failed.type === "completed" ? decodeJson(failed.output) : undefined).toEqual({
        state: "failed",
        turnId: null,
        assistantMessage: null,
        ambiguous: false,
      });

      const ambiguous = yield* invokeBounded(ambiguousMessageId, "wait-start-ambiguous");
      expect(ambiguous.type === "completed" ? decodeJson(ambiguous.output) : undefined).toEqual({
        state: "failed",
        turnId: null,
        assistantMessage: null,
        ambiguous: true,
      });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("returns interaction-required state and bounds a still-running wait", () =>
  Effect.gen(function* () {
    const userMessageId = MessageId.make("message-user-running");
    const runningTurn = projectionTurn({ pendingMessageId: userMessageId, state: "running" });
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: userMessageId,
          role: "user",
          text: "Deploy it",
          createdAt: now,
        }),
      ],
      turns: [runningTurn],
      thread: {
        ...thread,
        latestTurn: thread.latestTurn === null ? null : { ...thread.latestTurn, turnId },
        hasPendingApprovals: true,
      },
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const approval = yield* tools.invoke(
        call(
          "wait_for_thread_turn",
          encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 1_000 }),
          "wait-approval",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(approval.type === "completed" ? decodeJson(approval.output) : undefined).toEqual({
        state: "approval-required",
        turnId,
      });

      yield* Ref.set(test.threadShell, {
        ...thread,
        latestTurn: thread.latestTurn === null ? null : { ...thread.latestTurn, turnId },
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      });
      const userInput = yield* tools.invoke(
        call(
          "wait_for_thread_turn",
          encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 1_000 }),
          "wait-user-input",
          new Set([AuthOrchestrationReadScope]),
        ),
      );
      expect(userInput.type === "completed" ? decodeJson(userInput.output) : undefined).toEqual({
        state: "user-input-required",
        turnId,
      });

      yield* Ref.set(test.threadShell, {
        ...thread,
        latestTurn: thread.latestTurn === null ? null : { ...thread.latestTurn, turnId },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      });
      const waiting = yield* Effect.forkScoped(
        tools.invoke(
          call(
            "wait_for_thread_turn",
            encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 500 }),
            "wait-timeout",
            new Set([AuthOrchestrationReadScope]),
          ),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("750 millis");
      const timedOut = yield* Fiber.join(waiting);
      expect(timedOut.type === "completed" ? decodeJson(timedOut.output) : undefined).toEqual({
        state: "running",
        turnId,
      });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("returns the last observed state when a later lookup remains blocked at timeout", () =>
  Effect.gen(function* () {
    const userMessageId = MessageId.make("message-user-blocked-final-read");
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: userMessageId,
          role: "user",
          text: "Keep waiting with a stalled projection query",
          createdAt: now,
        }),
      ],
      turns: [projectionTurn({ pendingMessageId: userMessageId, state: "running" })],
      blockTurnLookupAfterFirst: true,
    });
    yield* Effect.gen(function* () {
      const waiting = yield* (yield* VoiceToolExecutor)
        .invoke(
          call(
            "wait_for_thread_turn",
            encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 500 }),
            "wait-blocked-final-read",
            new Set([AuthOrchestrationReadScope]),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(test.turnLookupStarted);
      yield* TestClock.adjust("250 millis");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(test.turnLookupCount)).toBe(2);
      yield* TestClock.adjust("500 millis");

      const result = yield* Fiber.join(waiting);
      expect(result.type === "completed" ? decodeJson(result.output) : undefined).toEqual({
        state: "running",
        turnId,
      });
      expect(yield* Ref.get(test.turnLookupCount)).toBe(2);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("does not serialize other tools behind a blocked turn wait", () =>
  Effect.gen(function* () {
    const userMessageId = MessageId.make("message-user-concurrent-wait");
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: userMessageId,
          role: "user",
          text: "Keep working",
          createdAt: now,
        }),
      ],
      turns: [projectionTurn({ pendingMessageId: userMessageId, state: "running" })],
      thread: {
        ...thread,
        latestTurn: thread.latestTurn === null ? null : { ...thread.latestTurn, turnId },
      },
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const waitingInput = call(
        "wait_for_thread_turn",
        encodeJson({ threadId, messageId: userMessageId, waitMilliseconds: 500 }),
        "wait-concurrent",
        new Set([AuthOrchestrationReadScope]),
      );
      const firstWait = yield* Effect.forkScoped(tools.invoke(waitingInput));
      yield* Deferred.await(test.turnLookupStarted);

      const duplicateWait = yield* Effect.forkScoped(tools.invoke(waitingInput));
      const unrelated = yield* Effect.forkScoped(
        tools.invoke(
          call(
            "list_projects",
            '{"limit":10}',
            "list-during-wait",
            new Set([AuthOrchestrationReadScope]),
          ),
        ),
      );
      yield* Effect.yieldNow;
      expect(unrelated.pollUnsafe()).toBeDefined();
      const unrelatedResult = yield* Fiber.join(unrelated);
      expect(unrelatedResult.type === "completed" && unrelatedResult.outcome).toBe("succeeded");

      yield* TestClock.adjust("750 millis");
      const firstResult = yield* Fiber.join(firstWait);
      const duplicateResult = yield* Fiber.join(duplicateWait);
      expect(firstResult.type === "completed" && firstResult.submitOutput).toBe(true);
      expect(duplicateResult.type === "completed" && duplicateResult.submitOutput).toBe(false);
      expect(firstResult.type === "completed" ? decodeJson(firstResult.output) : undefined).toEqual(
        {
          state: "running",
          turnId,
        },
      );
      expect(yield* Ref.get(test.journal)).toHaveLength(4);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("does not serialize other tools behind a blocked thread-history read", () =>
  Effect.gen(function* () {
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: MessageId.make("message-blocked-history"),
          role: "user",
          text: "History",
          createdAt: now,
        }),
      ],
      blockMessagePage: true,
    });
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const history = yield* Effect.forkScoped(
        tools.invoke(
          call(
            "get_thread_messages",
            encodeJson({ threadId, limit: 10 }),
            "blocked-history",
            new Set([AuthOrchestrationReadScope]),
          ),
        ),
      );
      yield* Deferred.await(test.messagePageStarted);

      const unrelated = yield* Effect.forkScoped(
        tools.invoke(
          call(
            "list_projects",
            '{"limit":10}',
            "list-during-history",
            new Set([AuthOrchestrationReadScope]),
          ),
        ),
      );
      yield* Effect.yieldNow;
      expect(unrelated.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(unrelated)).type).toBe("completed");

      yield* Deferred.succeed(test.messagePageRelease, undefined);
      const historyResult = yield* Fiber.join(history);
      expect(historyResult.type === "completed" && historyResult.outcome).toBe("succeeded");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("keeps mixed-scope duplicates local during execution and after restart", () =>
  Effect.gen(function* () {
    const test = yield* makeTest("durable", {
      messages: [
        projectionMessage({
          messageId: MessageId.make("message-mixed-scope"),
          role: "user",
          text: "History",
          createdAt: now,
        }),
      ],
      blockMessagePage: true,
    });
    const input = call(
      "get_thread_messages",
      encodeJson({ threadId, limit: 10 }),
      "mixed-scope-history",
      new Set([AuthOrchestrationReadScope]),
    );
    const deniedInput = {
      ...input,
      grantedScopes: new Set<AuthEnvironmentScope>([AuthVoiceUseScope]),
    };

    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const authorized = yield* Effect.forkScoped(tools.invoke(input));
      yield* Deferred.await(test.messagePageStarted);

      const denied = yield* tools.invoke(deniedInput);
      expect(denied.type === "completed" ? decodeJson(denied.output) : undefined).toEqual({
        error: "Voice tool requires orchestration:read",
      });
      expect([...(yield* Ref.get(test.durableCalls)).values()].map((call) => call.status)).toEqual([
        "requested",
      ]);

      yield* Deferred.succeed(test.messagePageRelease, undefined);
      const completed = yield* Fiber.join(authorized);
      expect(completed.type === "completed" && completed.outcome).toBe("succeeded");
      expect([...(yield* Ref.get(test.durableCalls)).values()].map((call) => call.status)).toEqual([
        "succeeded",
      ]);
    }).pipe(Effect.provide(test.layer));

    const restartedLayer = VoiceToolExecutorLive.pipe(Layer.provide(test.dependencies));
    const deniedAfterRestart = yield* Effect.gen(function* () {
      return yield* (yield* VoiceToolExecutor).invoke(deniedInput);
    }).pipe(Effect.provide(restartedLayer));
    expect(
      deniedAfterRestart.type === "completed" ? decodeJson(deniedAfterRestart.output) : undefined,
    ).toEqual({ error: "Voice tool requires orchestration:read" });
    expect([...(yield* Ref.get(test.durableCalls)).values()].map((call) => call.status)).toEqual([
      "succeeded",
    ]);

    const authorizedAfterRestart = yield* Effect.gen(function* () {
      return yield* (yield* VoiceToolExecutor).invoke(input);
    }).pipe(Effect.provide(VoiceToolExecutorLive.pipe(Layer.provide(test.dependencies))));
    expect(authorizedAfterRestart.type === "completed" && authorizedAfterRestart.outcome).toBe(
      "succeeded",
    );
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
      const cachedWithoutScope = yield* tools.invoke(
        call("list_projects", '{"limit":10}', "allowed-read", voiceOnly),
      );
      expect(
        cachedWithoutScope.type === "completed" ? decodeJson(cachedWithoutScope.output) : undefined,
      ).toEqual({ error: "Voice tool requires orchestration:read" });

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
          if (mutation.name === "send_thread_message") {
            expect(decodeJson(completed.output)).toMatchObject({
              commandId: `voice:${conversationId}:send_thread_message`,
              messageId: `voice-message:${conversationId}:send_thread_message`,
            });
          }
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

it.effect("terminalizes durable pending calls when their voice session is discarded", () =>
  Effect.gen(function* () {
    const test = yield* makeTest();
    yield* Effect.gen(function* () {
      const tools = yield* VoiceToolExecutor;
      const pending = yield* tools.invoke(
        call("archive_thread", encodeJson({ threadId }), "discard-call"),
      );
      expect(pending.type).toBe("confirmation-required");

      yield* tools.discardSession(sessionId);

      const durable = (yield* Ref.get(test.durableCalls)).get(`${conversationId}:discard-call`);
      expect(durable?.status).toBe("failed");
      expect(durable?.contextEpoch).toBe(1);
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
      yield* Ref.update(test.durableCalls, (calls) => {
        const key = `${conversationId}:canonical-call`;
        const durable = calls.get(key)!;
        return new Map(calls).set(key, { ...durable, contextEpoch: 2 });
      });
      const epochConflict = yield* tools.invoke(first).pipe(Effect.flip);
      expect(epochConflict.operation).toBe("tool.idempotency");
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

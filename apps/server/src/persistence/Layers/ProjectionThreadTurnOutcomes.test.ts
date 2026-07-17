import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadTurnOutcomeRepository } from "../Services/ProjectionThreadTurnOutcomes.ts";
import { ProjectionTurnStartRepository } from "../Services/ProjectionTurnStarts.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionThreadTurnOutcomeRepositoryLive } from "./ProjectionThreadTurnOutcomes.ts";
import { ProjectionTurnStartRepositoryLive } from "./ProjectionTurnStarts.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";

const repositories = Layer.mergeAll(
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadRepositoryLive,
  ProjectionThreadTurnOutcomeRepositoryLive,
  ProjectionTurnStartRepositoryLive,
  ProjectionTurnRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(repositories)("ProjectionThreadTurnOutcomeRepository", (it) => {
  it.effect("reads one narrow exact snapshot and bounds only the settled assistant body", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionThreadMessageRepository;
      const threads = yield* ProjectionThreadRepository;
      const outcomes = yield* ProjectionThreadTurnOutcomeRepository;
      const starts = yield* ProjectionTurnStartRepository;
      const turns = yield* ProjectionTurnRepository;
      const projectId = ProjectId.make("project-outcome");
      const threadId = ThreadId.make("thread-outcome");
      const otherThreadId = ThreadId.make("thread-other");
      const messageId = MessageId.make("message-outcome");
      const wrongThreadMessageId = MessageId.make("message-wrong-thread");
      const nonUserMessageId = MessageId.make("message-non-user");
      const assistantMessageId = MessageId.make("assistant-outcome");
      const turnId = TurnId.make("turn-outcome");
      const now = "2026-07-17T00:00:00.000Z";

      assert.deepStrictEqual(yield* outcomes.getByMessageId({ threadId, messageId }), {
        threadExists: false,
        messageExists: false,
        latestTurnId: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        startState: null,
        turnId: null,
        turnState: null,
        assistantMessageId: null,
      });

      const activeThread = {
        threadId,
        projectId,
        title: "Exact outcome",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: turnId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: now,
        pendingApprovalCount: 1,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      } as const;
      yield* threads.upsert(activeThread);

      yield* threads.upsert({ ...activeThread, archivedAt: now });
      assert.isFalse((yield* outcomes.getByMessageId({ threadId, messageId })).threadExists);
      yield* threads.upsert({ ...activeThread, deletedAt: now });
      assert.isFalse((yield* outcomes.getByMessageId({ threadId, messageId })).threadExists);
      yield* threads.upsert(activeThread);

      yield* messages.upsert({
        messageId: wrongThreadMessageId,
        threadId: otherThreadId,
        turnId: null,
        role: "user",
        text: "Wrong thread",
        attachments: [],
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });
      yield* messages.upsert({
        messageId: nonUserMessageId,
        threadId,
        turnId: turnId,
        role: "assistant",
        text: "Not a dispatched message",
        attachments: [],
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });
      assert.isFalse(
        (yield* outcomes.getByMessageId({ threadId, messageId: wrongThreadMessageId }))
          .messageExists,
      );
      assert.isFalse(
        (yield* outcomes.getByMessageId({ threadId, messageId: nonUserMessageId })).messageExists,
      );

      yield* messages.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "x".repeat(100_000),
        attachments: [],
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });

      assert.deepStrictEqual(yield* outcomes.getByMessageId({ threadId, messageId }), {
        threadExists: true,
        messageExists: true,
        latestTurnId: turnId,
        pendingApprovalCount: 1,
        pendingUserInputCount: 0,
        startState: null,
        turnId: null,
        turnState: null,
        assistantMessageId: null,
      });

      const pendingStart = {
        threadId,
        messageId,
        turnId: null,
        state: "pending" as const,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: now,
        resolvedAt: null,
      };
      yield* starts.upsert(pendingStart);
      yield* starts.upsert({ ...pendingStart, state: "submitting" });
      yield* starts.upsert({
        ...pendingStart,
        state: "accepted",
        turnId,
        resolvedAt: now,
      });
      yield* turns.upsertByTurnId({
        threadId,
        turnId,
        assistantMessageId: null,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [
          {
            path: "large-checkpoint-should-not-be-read",
            kind: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
      });

      assert.deepStrictEqual(yield* outcomes.getByMessageId({ threadId, messageId }), {
        threadExists: true,
        messageExists: true,
        latestTurnId: turnId,
        pendingApprovalCount: 1,
        pendingUserInputCount: 0,
        startState: "accepted",
        turnId,
        turnState: "running",
        assistantMessageId: null,
      });

      yield* turns.upsertByTurnId({
        threadId,
        turnId,
        assistantMessageId,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      const terminal = yield* outcomes.getByMessageId({ threadId, messageId });
      assert.deepStrictEqual(terminal, {
        threadExists: true,
        messageExists: true,
        latestTurnId: turnId,
        pendingApprovalCount: 1,
        pendingUserInputCount: 0,
        startState: "accepted",
        turnId,
        turnState: "completed",
        assistantMessageId,
      });

      const assistantText = "a".repeat(ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS + 7);
      yield* messages.upsert({
        messageId: assistantMessageId,
        threadId,
        turnId,
        role: "assistant",
        text: assistantText,
        attachments: [],
        isStreaming: true,
        createdAt: now,
        updatedAt: now,
      });
      assert.isTrue(
        Option.isNone(
          yield* outcomes.getSettledAssistant({ threadId, turnId, messageId: assistantMessageId }),
        ),
      );

      yield* messages.upsert({
        messageId: assistantMessageId,
        threadId,
        turnId,
        role: "assistant",
        text: assistantText,
        attachments: [],
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const assistant = Option.getOrThrow(
        yield* outcomes.getSettledAssistant({ threadId, turnId, messageId: assistantMessageId }),
      );
      assert.equal(assistant.text.length, ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS);
      assert.isTrue(assistant.truncated);

      const surrogateBoundaryText = `${"a".repeat(
        ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS - 1,
      )}😀`;
      yield* messages.upsert({
        messageId: assistantMessageId,
        threadId,
        turnId,
        role: "assistant",
        text: surrogateBoundaryText,
        attachments: [],
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const surrogateBoundaryAssistant = Option.getOrThrow(
        yield* outcomes.getSettledAssistant({ threadId, turnId, messageId: assistantMessageId }),
      );
      assert.equal(
        surrogateBoundaryAssistant.text.length,
        ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS - 1,
      );
      assert.equal(surrogateBoundaryAssistant.text, surrogateBoundaryText.slice(0, -2));
      assert.isTrue(surrogateBoundaryAssistant.truncated);
      assert.isTrue(
        Option.isNone(
          yield* outcomes.getSettledAssistant({
            threadId,
            turnId: TurnId.make("wrong-turn"),
            messageId: assistantMessageId,
          }),
        ),
      );
    }),
  );
});

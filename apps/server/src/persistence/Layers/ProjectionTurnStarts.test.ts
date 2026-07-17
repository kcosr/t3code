import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionTurnStartRepository } from "../Services/ProjectionTurnStarts.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionTurnStartRepositoryLive } from "./ProjectionTurnStarts.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";

const repositories = Layer.mergeAll(
  ProjectionTurnRepositoryLive,
  ProjectionTurnStartRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const layer = it.layer(repositories);

layer("ProjectionTurnStartRepository", (it) => {
  it.effect("preserves overlapping starts and many messages correlated to one steered turn", () =>
    Effect.gen(function* () {
      const starts = yield* ProjectionTurnStartRepository;
      const turns = yield* ProjectionTurnRepository;
      const threadId = ThreadId.make("thread-steer");
      const firstMessageId = MessageId.make("message-first");
      const secondMessageId = MessageId.make("message-second");
      const turnId = TurnId.make("provider-turn-shared");

      for (const [messageId, requestedAt] of [
        [firstMessageId, "2026-07-11T08:00:00.000Z"],
        [secondMessageId, "2026-07-11T08:00:01.000Z"],
      ] as const) {
        yield* starts.upsert({
          threadId,
          messageId,
          turnId: null,
          state: "pending",
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt,
          resolvedAt: null,
        });
      }

      yield* starts.upsert({
        ...(yield* starts.getByMessageId({ threadId, messageId: secondMessageId })).pipe(
          Option.getOrThrow,
        ),
        state: "submitting",
      });
      yield* starts.upsert({
        ...(yield* starts.getByMessageId({ threadId, messageId: secondMessageId })).pipe(
          Option.getOrThrow,
        ),
        turnId,
        state: "accepted",
        resolvedAt: "2026-07-11T08:00:02.000Z",
      });
      const firstPending = yield* starts.getByMessageId({
        threadId,
        messageId: firstMessageId,
      });
      assert.equal(Option.getOrThrow(firstPending).state, "pending");

      yield* starts.upsert({
        ...Option.getOrThrow(firstPending),
        state: "submitting",
      });
      yield* starts.upsert({
        ...Option.getOrThrow(yield* starts.getByMessageId({ threadId, messageId: firstMessageId })),
        turnId,
        state: "accepted",
        resolvedAt: "2026-07-11T08:00:03.000Z",
      });
      yield* turns.upsertByTurnId({
        threadId,
        turnId,
        assistantMessageId: MessageId.make("assistant-final"),
        state: "completed",
        requestedAt: "2026-07-11T08:00:00.000Z",
        startedAt: "2026-07-11T08:00:00.500Z",
        completedAt: "2026-07-11T08:00:05.000Z",
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });

      const first = yield* starts.getOutcomeByMessageId({ threadId, messageId: firstMessageId });
      const second = yield* starts.getOutcomeByMessageId({ threadId, messageId: secondMessageId });
      const earliest = yield* starts.getEarliestByTurnId({ threadId, turnId });
      assert.equal(Option.getOrThrow(first).turn?.turnId, turnId);
      assert.equal(Option.getOrThrow(second).turn?.turnId, turnId);
      assert.equal(Option.getOrThrow(first).turn?.state, "completed");
      assert.equal(Option.getOrThrow(earliest).messageId, firstMessageId);
    }),
  );

  it.effect("fails one exact start without changing another", () =>
    Effect.gen(function* () {
      const starts = yield* ProjectionTurnStartRepository;
      const threadId = ThreadId.make("thread-failure");
      const failedMessageId = MessageId.make("message-failed");
      const pendingMessageId = MessageId.make("message-pending");
      for (const messageId of [failedMessageId, pendingMessageId]) {
        yield* starts.upsert({
          threadId,
          messageId,
          turnId: null,
          state: "pending",
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: "2026-07-11T09:00:00.000Z",
          resolvedAt: null,
        });
      }
      yield* starts.upsert({
        ...Option.getOrThrow(
          yield* starts.getByMessageId({ threadId, messageId: failedMessageId }),
        ),
        state: "failed",
        resolvedAt: "2026-07-11T09:00:01.000Z",
      });
      assert.equal(
        Option.getOrThrow(yield* starts.getByMessageId({ threadId, messageId: failedMessageId }))
          .state,
        "failed",
      );
      assert.equal(
        Option.getOrThrow(yield* starts.getByMessageId({ threadId, messageId: pendingMessageId }))
          .state,
        "pending",
      );
      const failedOutcome = Option.getOrThrow(
        yield* starts.getOutcomeByMessageId({ threadId, messageId: failedMessageId }),
      );
      const pendingOutcome = Option.getOrThrow(
        yield* starts.getOutcomeByMessageId({ threadId, messageId: pendingMessageId }),
      );
      assert.equal(failedOutcome.start.state, "failed");
      assert.isNull(failedOutcome.turn);
      assert.equal(pendingOutcome.start.state, "pending");
      assert.isNull(pendingOutcome.turn);
      assert.isTrue(
        Option.isNone(
          yield* starts.getOutcomeByMessageId({
            threadId,
            messageId: MessageId.make("message-missing"),
          }),
        ),
      );
    }),
  );

  it.effect("rejects regression and conflicting provider turn correlation", () =>
    Effect.gen(function* () {
      const starts = yield* ProjectionTurnStartRepository;
      const threadId = ThreadId.make("thread-monotonic");
      const messageId = MessageId.make("message-monotonic");
      const requestedAt = "2026-07-11T10:00:00.000Z";
      yield* starts.upsert({
        threadId,
        messageId,
        turnId: null,
        state: "pending",
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt,
        resolvedAt: null,
      });
      yield* starts.upsert({
        threadId,
        messageId,
        turnId: null,
        state: "submitting",
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt,
        resolvedAt: null,
      });
      yield* starts.upsert({
        threadId,
        messageId,
        turnId: TurnId.make("turn-one"),
        state: "accepted",
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt,
        resolvedAt: "2026-07-11T10:00:01.000Z",
      });

      const regression = yield* Effect.exit(
        starts.upsert({
          threadId,
          messageId,
          turnId: null,
          state: "submitting",
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt,
          resolvedAt: null,
        }),
      );
      const conflict = yield* Effect.exit(
        starts.upsert({
          threadId,
          messageId,
          turnId: TurnId.make("turn-two"),
          state: "accepted",
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt,
          resolvedAt: "2026-07-11T10:00:01.000Z",
        }),
      );
      assert.isTrue(regression._tag === "Failure");
      assert.isTrue(conflict._tag === "Failure");
      assert.equal(
        Option.getOrThrow(yield* starts.getByMessageId({ threadId, messageId })).turnId,
        "turn-one",
      );
    }),
  );
});

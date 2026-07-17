import {
  ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS,
  type OrchestrationMessageTurnResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnStartRepositoryLive } from "../../persistence/Layers/ProjectionTurnStarts.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnStartRepository } from "../../persistence/Services/ProjectionTurnStarts.ts";
import { ThreadTurnOutcomeQuery } from "../Services/ThreadTurnOutcomeQuery.ts";

const boundedAssistant = (message: {
  readonly messageId: OrchestrationMessageTurnResult["messageId"];
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}) => ({
  messageId: message.messageId,
  text: message.text.slice(0, ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS),
  truncated: message.text.length > ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

const make = Effect.gen(function* () {
  const threads = yield* ProjectionThreadRepository;
  const messages = yield* ProjectionThreadMessageRepository;
  const turnStarts = yield* ProjectionTurnStartRepository;

  const getByMessageId: ThreadTurnOutcomeQuery["Service"]["getByMessageId"] = Effect.fn(
    "ThreadTurnOutcomeQuery.getByMessageId",
  )(function* (input) {
    const [thread, dispatchedMessage, outcome] = yield* Effect.all([
      threads.getById({ threadId: input.threadId }),
      messages.getByMessageId({ messageId: input.messageId }),
      turnStarts.getOutcomeByMessageId(input),
    ]);
    if (
      Option.isNone(thread) ||
      thread.value.deletedAt !== null ||
      thread.value.archivedAt !== null
    ) {
      return { type: "thread-not-found" } as const;
    }
    if (
      Option.isNone(dispatchedMessage) ||
      dispatchedMessage.value.threadId !== input.threadId ||
      dispatchedMessage.value.role !== "user"
    ) {
      return { type: "message-not-found" } as const;
    }

    const result = (
      state: OrchestrationMessageTurnResult["state"],
      turnId: OrchestrationMessageTurnResult["turnId"],
      assistantMessage: OrchestrationMessageTurnResult["assistantMessage"] = null,
    ) =>
      ({
        type: "found",
        result: {
          messageId: input.messageId,
          state,
          turnId,
          assistantMessage,
        },
      }) as const;

    if (
      Option.isNone(outcome) ||
      outcome.value.start.state === "pending" ||
      outcome.value.start.state === "submitting"
    ) {
      return result("pending", null);
    }
    if (outcome.value.start.state === "failed") {
      return result("failed", null);
    }
    if (outcome.value.start.state === "ambiguous") {
      return result("ambiguous", null);
    }

    const turn = outcome.value.turn;
    if (turn === null) {
      return result("running", outcome.value.start.turnId);
    }

    if (turn.state === "running") {
      const isActiveTurn = thread.value.latestTurnId === turn.turnId;
      if (isActiveTurn && thread.value.pendingApprovalCount > 0) {
        return result("approval-required", turn.turnId);
      }
      if (isActiveTurn && thread.value.pendingUserInputCount > 0) {
        return result("user-input-required", turn.turnId);
      }
      return result("running", turn.turnId);
    }

    const assistant =
      turn.assistantMessageId === null
        ? Option.none()
        : yield* messages.getByMessageId({ messageId: turn.assistantMessageId });
    const matchingAssistant = Option.filter(
      assistant,
      (message) =>
        message.threadId === input.threadId && message.role === "assistant" && !message.isStreaming,
    );

    // A completed turn can project before its final assistant message. Keep
    // polling rather than reporting a terminal result without the response.
    if (
      turn.state === "completed" &&
      turn.assistantMessageId !== null &&
      Option.isNone(matchingAssistant)
    ) {
      return result("running", turn.turnId);
    }

    const finalAssistant = Option.match(matchingAssistant, {
      onNone: () => null,
      onSome: boundedAssistant,
    });
    return result(turn.state === "error" ? "failed" : turn.state, turn.turnId, finalAssistant);
  });

  return ThreadTurnOutcomeQuery.of({ getByMessageId });
});

export const ThreadTurnOutcomeQueryLive = Layer.effect(ThreadTurnOutcomeQuery, make);

export const ThreadTurnOutcomePersistenceLive = Layer.mergeAll(
  ProjectionThreadRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionTurnStartRepositoryLive,
);

export const ThreadTurnOutcomeQueryConfiguredLive = ThreadTurnOutcomeQueryLive.pipe(
  Layer.provide(ThreadTurnOutcomePersistenceLive),
);

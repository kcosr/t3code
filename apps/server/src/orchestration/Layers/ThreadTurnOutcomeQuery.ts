import { type OrchestrationMessageTurnResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadTurnOutcomeRepositoryLive } from "../../persistence/Layers/ProjectionThreadTurnOutcomes.ts";
import { ProjectionThreadTurnOutcomeRepository } from "../../persistence/Services/ProjectionThreadTurnOutcomes.ts";
import { ThreadTurnOutcomeQuery } from "../Services/ThreadTurnOutcomeQuery.ts";

const make = Effect.gen(function* () {
  const outcomes = yield* ProjectionThreadTurnOutcomeRepository;

  const getByMessageId: ThreadTurnOutcomeQuery["Service"]["getByMessageId"] = Effect.fn(
    "ThreadTurnOutcomeQuery.getByMessageId",
  )(function* (input) {
    const outcome = yield* outcomes.getByMessageId(input);
    if (!outcome.threadExists) {
      return { type: "thread-not-found" } as const;
    }
    if (!outcome.messageExists) {
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
      outcome.startState === null ||
      outcome.startState === "pending" ||
      outcome.startState === "submitting"
    ) {
      return result("pending", null);
    }
    if (outcome.startState === "failed") {
      return result("failed", null);
    }
    if (outcome.startState === "ambiguous") {
      return result("ambiguous", null);
    }

    if (outcome.turnState === null || outcome.turnId === null) {
      return result("running", outcome.turnId);
    }

    if (outcome.turnState === "running") {
      const isActiveTurn = outcome.latestTurnId === outcome.turnId;
      if (isActiveTurn && outcome.pendingApprovalCount > 0) {
        return result("approval-required", outcome.turnId);
      }
      if (isActiveTurn && outcome.pendingUserInputCount > 0) {
        return result("user-input-required", outcome.turnId);
      }
      return result("running", outcome.turnId);
    }

    const assistant =
      outcome.assistantMessageId === null
        ? Option.none()
        : yield* outcomes.getSettledAssistant({
            threadId: input.threadId,
            turnId: outcome.turnId,
            messageId: outcome.assistantMessageId,
          });

    // A completed turn can project before its final assistant message. Keep
    // polling rather than reporting a terminal result without the response.
    if (
      outcome.turnState === "completed" &&
      outcome.assistantMessageId !== null &&
      Option.isNone(assistant)
    ) {
      return result("running", outcome.turnId);
    }

    const finalAssistant = Option.match(assistant, {
      onNone: () => null,
      onSome: (message) => message,
    });
    return result(
      outcome.turnState === "error" ? "failed" : outcome.turnState,
      outcome.turnId,
      finalAssistant,
    );
  });

  return ThreadTurnOutcomeQuery.of({ getByMessageId });
});

export const ThreadTurnOutcomeQueryLive = Layer.effect(ThreadTurnOutcomeQuery, make);

export const ThreadTurnOutcomePersistenceLive = ProjectionThreadTurnOutcomeRepositoryLive;

export const ThreadTurnOutcomeQueryConfiguredLive = ThreadTurnOutcomeQueryLive.pipe(
  Layer.provide(ThreadTurnOutcomePersistenceLive),
);

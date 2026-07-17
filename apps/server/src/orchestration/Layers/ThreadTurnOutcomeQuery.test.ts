import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProjectionThreadTurnOutcomeRepository,
  type ProjectionSettledAssistant,
  type ProjectionThreadTurnOutcome,
} from "../../persistence/Services/ProjectionThreadTurnOutcomes.ts";
import { ThreadTurnOutcomeQuery } from "../Services/ThreadTurnOutcomeQuery.ts";
import { ThreadTurnOutcomeQueryLive } from "./ThreadTurnOutcomeQuery.ts";

const threadId = ThreadId.make("thread-one");
const messageId = MessageId.make("message-one");
const assistantMessageId = MessageId.make("assistant-one");
const turnId = TurnId.make("turn-one");
const otherTurnId = TurnId.make("turn-other");
const now = "2026-07-16T12:00:00.000Z";

const outcome = (input?: {
  readonly threadExists?: boolean;
  readonly messageExists?: boolean;
  readonly latestTurnId?: TurnId | null;
  readonly approvals?: boolean;
  readonly userInput?: boolean;
  readonly startState?: ProjectionThreadTurnOutcome["startState"];
  readonly turnState?: ProjectionThreadTurnOutcome["turnState"];
  readonly assistantMessageId?: MessageId | null;
  readonly includeTurn?: boolean;
}): ProjectionThreadTurnOutcome => {
  const startState = input?.startState === undefined ? "accepted" : input.startState;
  const includeTurn = input?.includeTurn !== false && startState === "accepted";
  return {
    threadExists: input?.threadExists ?? true,
    messageExists: input?.messageExists ?? true,
    latestTurnId: input?.latestTurnId === undefined ? turnId : input.latestTurnId,
    pendingApprovalCount: input?.approvals === true ? 1 : 0,
    pendingUserInputCount: input?.userInput === true ? 1 : 0,
    startState,
    turnId: includeTurn ? turnId : null,
    turnState: includeTurn ? (input?.turnState ?? "running") : null,
    assistantMessageId: includeTurn ? (input?.assistantMessageId ?? null) : null,
  };
};

const assistant = (text: string): ProjectionSettledAssistant => ({
  messageId: assistantMessageId,
  text: text.slice(0, ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS),
  truncated: text.length > ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS,
  createdAt: now,
  updatedAt: now,
});

const makeLayer = (input?: {
  readonly threadExists?: boolean;
  readonly messageExists?: boolean;
  readonly outcome?: ProjectionThreadTurnOutcome;
  readonly assistant?: ProjectionSettledAssistant | null;
}) => {
  const base = input?.outcome ?? outcome({ startState: null, includeTurn: false });
  const outcomes = ProjectionThreadTurnOutcomeRepository.of({
    getByMessageId: () =>
      Effect.succeed({
        ...base,
        threadExists: input?.threadExists ?? base.threadExists,
        messageExists: input?.messageExists ?? base.messageExists,
      }),
    getSettledAssistant: () =>
      Effect.succeed(
        input?.assistant === undefined || input.assistant === null
          ? Option.none()
          : Option.some(input.assistant),
      ),
  });

  return ThreadTurnOutcomeQueryLive.pipe(
    Layer.provide(Layer.succeed(ProjectionThreadTurnOutcomeRepository, outcomes)),
  );
};

const load = (layer: ReturnType<typeof makeLayer>) =>
  ThreadTurnOutcomeQuery.pipe(
    Effect.flatMap((query) => query.getByMessageId({ threadId, messageId })),
    Effect.provide(layer),
  );

describe("ThreadTurnOutcomeQuery", () => {
  it.effect("distinguishes missing threads and messages from a pending exact message", () =>
    Effect.gen(function* () {
      const missing = yield* load(makeLayer({ threadExists: false }));
      assert.deepStrictEqual(missing, { type: "thread-not-found" });

      const missingMessage = yield* load(makeLayer({ messageExists: false }));
      assert.deepStrictEqual(missingMessage, { type: "message-not-found" });

      const projectionGap = yield* load(makeLayer());
      assert.deepStrictEqual(projectionGap, {
        type: "found",
        result: {
          messageId,
          state: "pending",
          turnId: null,
          assistantMessage: null,
        },
      });
    }),
  );

  it.effect("keeps pending and submitting starts non-terminal", () =>
    Effect.gen(function* () {
      for (const startState of ["pending", "submitting"] as const) {
        const lookup = yield* load(makeLayer({ outcome: outcome({ startState }) }));
        assert.equal(lookup.type, "found");
        if (lookup.type !== "found") return;
        assert.equal(lookup.result.state, "pending");
        assert.isNull(lookup.result.turnId);
      }
    }),
  );

  it.effect("distinguishes failed and ambiguous starts", () =>
    Effect.gen(function* () {
      const failed = yield* load(makeLayer({ outcome: outcome({ startState: "failed" }) }));
      const ambiguous = yield* load(makeLayer({ outcome: outcome({ startState: "ambiguous" }) }));
      assert.equal(failed.type === "found" ? failed.result.state : failed.type, "failed");
      assert.equal(
        ambiguous.type === "found" ? ambiguous.result.state : ambiguous.type,
        "ambiguous",
      );
    }),
  );

  it.effect("reports attention only for the exact active turn", () =>
    Effect.gen(function* () {
      const approval = yield* load(
        makeLayer({
          outcome: outcome({ turnState: "running", approvals: true }),
        }),
      );
      assert.equal(
        approval.type === "found" ? approval.result.state : approval.type,
        "approval-required",
      );

      const userInput = yield* load(
        makeLayer({
          outcome: outcome({ turnState: "running", userInput: true }),
        }),
      );
      assert.equal(
        userInput.type === "found" ? userInput.result.state : userInput.type,
        "user-input-required",
      );

      const unrelated = yield* load(
        makeLayer({
          outcome: outcome({ turnState: "running", latestTurnId: otherTurnId, approvals: true }),
        }),
      );
      assert.equal(unrelated.type === "found" ? unrelated.result.state : unrelated.type, "running");
    }),
  );

  it.effect("waits for the final assistant projection and bounds its text", () =>
    Effect.gen(function* () {
      const streaming = yield* load(
        makeLayer({
          outcome: outcome({ turnState: "completed", assistantMessageId }),
          assistant: null,
        }),
      );
      assert.equal(streaming.type === "found" ? streaming.result.state : streaming.type, "running");

      const text = "x".repeat(ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS + 1);
      const completed = yield* load(
        makeLayer({
          outcome: outcome({ turnState: "completed", assistantMessageId }),
          assistant: assistant(text),
        }),
      );
      assert.equal(completed.type, "found");
      if (completed.type !== "found") return;
      assert.equal(completed.result.state, "completed");
      assert.equal(completed.result.turnId, turnId);
      assert.equal(
        completed.result.assistantMessage?.text.length,
        ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS,
      );
      assert.isTrue(completed.result.assistantMessage?.truncated);
    }),
  );

  it.effect("maps terminal turn states without borrowing another message", () =>
    Effect.gen(function* () {
      const interrupted = yield* load(
        makeLayer({ outcome: outcome({ turnState: "interrupted" }) }),
      );
      const errored = yield* load(makeLayer({ outcome: outcome({ turnState: "error" }) }));
      assert.equal(
        interrupted.type === "found" ? interrupted.result.state : interrupted.type,
        "interrupted",
      );
      assert.equal(errored.type === "found" ? errored.result.state : errored.type, "failed");
      if (errored.type === "found") assert.isNull(errored.result.assistantMessage);
    }),
  );
});

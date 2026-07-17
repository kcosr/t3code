import { assert, describe, it } from "@effect/vitest";
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

import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import {
  ProjectionTurnStartRepository,
  type ProjectionTurnStartOutcome,
  type ProjectionTurnStartState,
} from "../../persistence/Services/ProjectionTurnStarts.ts";
import type { ProjectionTurnState } from "../../persistence/Services/ProjectionTurns.ts";
import { ThreadTurnOutcomeQuery } from "../Services/ThreadTurnOutcomeQuery.ts";
import { ThreadTurnOutcomeQueryLive } from "./ThreadTurnOutcomeQuery.ts";

const projectId = ProjectId.make("project-one");
const threadId = ThreadId.make("thread-one");
const messageId = MessageId.make("message-one");
const assistantMessageId = MessageId.make("assistant-one");
const turnId = TurnId.make("turn-one");
const otherTurnId = TurnId.make("turn-other");
const now = "2026-07-16T12:00:00.000Z";

const thread = (input?: {
  readonly latestTurnId?: TurnId;
  readonly approvals?: boolean;
  readonly userInput?: boolean;
}): ProjectionThread => ({
  threadId,
  projectId,
  title: "Voice thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurnId: input?.latestTurnId ?? turnId,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  latestUserMessageAt: now,
  pendingApprovalCount: input?.approvals === true ? 1 : 0,
  pendingUserInputCount: input?.userInput === true ? 1 : 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
});

const outcome = (input: {
  readonly startState?: ProjectionTurnStartState;
  readonly turnState?: ProjectionTurnState;
  readonly assistantMessageId?: MessageId | null;
  readonly includeTurn?: boolean;
}): ProjectionTurnStartOutcome => ({
  start: {
    threadId,
    messageId,
    turnId: input.startState === "pending" || input.startState === "submitting" ? null : turnId,
    state: input.startState ?? "accepted",
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    requestedAt: now,
    resolvedAt: input.startState === "pending" ? null : now,
  },
  turn:
    input.includeTurn === false ||
    (input.startState !== undefined && input.startState !== "accepted")
      ? null
      : {
          threadId,
          turnId,
          assistantMessageId: input.assistantMessageId ?? null,
          state: input.turnState ?? "running",
          requestedAt: now,
          startedAt: now,
          completedAt: input.turnState === "running" ? null : now,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        },
});

const assistant = (text: string, isStreaming = false): ProjectionThreadMessage => ({
  messageId: assistantMessageId,
  threadId,
  turnId,
  role: "assistant",
  text,
  attachments: [],
  isStreaming,
  createdAt: now,
  updatedAt: now,
});

const userMessage: ProjectionThreadMessage = {
  messageId,
  threadId,
  turnId: null,
  role: "user",
  text: "Run the exact voice turn",
  attachments: [],
  isStreaming: false,
  createdAt: now,
  updatedAt: now,
};

const makeLayer = (input?: {
  readonly thread?: ProjectionThread | null;
  readonly outcome?: ProjectionTurnStartOutcome | null;
  readonly messages?: ReadonlyArray<ProjectionThreadMessage>;
}) => {
  const threads = {
    getById: ({ threadId: requestedThreadId }: { readonly threadId: ThreadId }) =>
      Effect.succeed(
        requestedThreadId === threadId && input?.thread !== null
          ? Option.some(input?.thread ?? thread())
          : Option.none(),
      ),
  } as unknown as ProjectionThreadRepository["Service"];
  const turnStarts = {
    getOutcomeByMessageId: () =>
      Effect.succeed(Option.fromUndefinedOr(input?.outcome ?? undefined)),
  } as unknown as ProjectionTurnStartRepository["Service"];
  const messages = {
    getByMessageId: ({ messageId: requestedMessageId }: { readonly messageId: MessageId }) =>
      Effect.succeed(
        Option.fromUndefinedOr(
          (input?.messages ?? [userMessage]).find(
            (message) => message.messageId === requestedMessageId,
          ),
        ),
      ),
  } as unknown as ProjectionThreadMessageRepository["Service"];

  return ThreadTurnOutcomeQueryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectionThreadRepository, threads),
        Layer.succeed(ProjectionTurnStartRepository, turnStarts),
        Layer.succeed(ProjectionThreadMessageRepository, messages),
      ),
    ),
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
      const missing = yield* load(makeLayer({ thread: null }));
      assert.deepStrictEqual(missing, { type: "thread-not-found" });

      const missingMessage = yield* load(makeLayer({ messages: [] }));
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
          thread: thread({ approvals: true }),
          outcome: outcome({ turnState: "running" }),
        }),
      );
      assert.equal(
        approval.type === "found" ? approval.result.state : approval.type,
        "approval-required",
      );

      const userInput = yield* load(
        makeLayer({
          thread: thread({ userInput: true }),
          outcome: outcome({ turnState: "running" }),
        }),
      );
      assert.equal(
        userInput.type === "found" ? userInput.result.state : userInput.type,
        "user-input-required",
      );

      const unrelated = yield* load(
        makeLayer({
          thread: thread({ latestTurnId: otherTurnId, approvals: true }),
          outcome: outcome({ turnState: "running" }),
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
          messages: [userMessage, assistant("partial", true)],
        }),
      );
      assert.equal(streaming.type === "found" ? streaming.result.state : streaming.type, "running");

      const text = "x".repeat(ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS + 1);
      const completed = yield* load(
        makeLayer({
          outcome: outcome({ turnState: "completed", assistantMessageId }),
          messages: [userMessage, assistant(text)],
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

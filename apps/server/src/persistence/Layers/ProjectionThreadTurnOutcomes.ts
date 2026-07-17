import { ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionSettledAssistantInput,
  GetProjectionThreadTurnOutcomeInput,
  ProjectionSettledAssistant,
  ProjectionThreadTurnOutcome,
  ProjectionThreadTurnOutcomeRepository,
  type ProjectionThreadTurnOutcomeRepositoryShape,
} from "../Services/ProjectionThreadTurnOutcomes.ts";

const ProjectionThreadTurnOutcomeDbRow = ProjectionThreadTurnOutcome.mapFields(
  Struct.assign({
    threadExists: Schema.Number,
    messageExists: Schema.Number,
  }),
);

const ProjectionSettledAssistantDbRow = ProjectionSettledAssistant.mapFields(
  Struct.assign({
    truncated: Schema.Number,
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function boundAssistantText(text: string): string {
  const bounded = text.slice(0, ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  const nextCodeUnit = text.charCodeAt(bounded.length);
  const splitsSurrogatePair =
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff;
  return splitsSurrogatePair ? bounded.slice(0, -1) : bounded;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getOutcomeRow = SqlSchema.findOne({
    Request: GetProjectionThreadTurnOutcomeInput,
    Result: ProjectionThreadTurnOutcomeDbRow,
    execute: ({ threadId, messageId }) => sql`
      SELECT
        CASE
          WHEN threads.thread_id IS NOT NULL
            AND threads.archived_at IS NULL
            AND threads.deleted_at IS NULL
          THEN 1 ELSE 0
        END AS "threadExists",
        CASE
          WHEN messages.message_id IS NOT NULL
            AND messages.thread_id = ${threadId}
            AND messages.role = 'user'
          THEN 1 ELSE 0
        END AS "messageExists",
        threads.latest_turn_id AS "latestTurnId",
        COALESCE(threads.pending_approval_count, 0) AS "pendingApprovalCount",
        COALESCE(threads.pending_user_input_count, 0) AS "pendingUserInputCount",
        starts.state AS "startState",
        starts.turn_id AS "turnId",
        turns.state AS "turnState",
        turns.assistant_message_id AS "assistantMessageId"
      FROM (SELECT 1) AS singleton
      LEFT JOIN projection_threads AS threads
        ON threads.thread_id = ${threadId}
      LEFT JOIN projection_thread_messages AS messages
        ON messages.message_id = ${messageId}
      LEFT JOIN projection_turn_starts AS starts
        ON starts.thread_id = ${threadId}
        AND starts.message_id = ${messageId}
      LEFT JOIN projection_turns AS turns
        ON turns.thread_id = starts.thread_id
        AND turns.turn_id = starts.turn_id
      LIMIT 1
    `,
  });

  const getSettledAssistantRow = SqlSchema.findOneOption({
    Request: GetProjectionSettledAssistantInput,
    Result: ProjectionSettledAssistantDbRow,
    execute: ({ threadId, turnId, messageId }) => sql`
      SELECT
        message_id AS "messageId",
        substr(text, 1, ${ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS}) AS text,
        CASE
          WHEN length(text) > ${ORCHESTRATION_MESSAGE_TURN_ASSISTANT_MAX_CHARS}
          THEN 1 ELSE 0
        END AS truncated,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE message_id = ${messageId}
        AND thread_id = ${threadId}
        AND turn_id = ${turnId}
        AND role = 'assistant'
        AND is_streaming = 0
      LIMIT 1
    `,
  });

  const getByMessageId: ProjectionThreadTurnOutcomeRepositoryShape["getByMessageId"] = (input) =>
    getOutcomeRow(input).pipe(
      Effect.map((row) => ({
        ...row,
        threadExists: row.threadExists === 1,
        messageExists: row.messageExists === 1,
      })),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadTurnOutcomeRepository.getByMessageId:query",
          "ProjectionThreadTurnOutcomeRepository.getByMessageId:decodeRow",
        ),
      ),
    );

  const getSettledAssistant: ProjectionThreadTurnOutcomeRepositoryShape["getSettledAssistant"] = (
    input,
  ) =>
    getSettledAssistantRow(input).pipe(
      Effect.map(
        Option.map((row) => {
          const text = boundAssistantText(row.text);
          return {
            ...row,
            text,
            truncated: row.truncated === 1 || text.length < row.text.length,
          };
        }),
      ),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadTurnOutcomeRepository.getSettledAssistant:query",
          "ProjectionThreadTurnOutcomeRepository.getSettledAssistant:decodeRow",
        ),
      ),
    );

  return ProjectionThreadTurnOutcomeRepository.of({ getByMessageId, getSettledAssistant });
});

export const ProjectionThreadTurnOutcomeRepositoryLive = Layer.effect(
  ProjectionThreadTurnOutcomeRepository,
  make,
);

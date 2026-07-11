import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionTurnStartsByThreadInput,
  GetProjectionTurnStartByMessageIdInput,
  GetProjectionTurnStartByTurnIdInput,
  ProjectionTurnStart,
  ProjectionTurnStartRepository,
  type ProjectionTurnStartRepositoryShape,
} from "../Services/ProjectionTurnStarts.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";

const isPersistenceSqlError = Schema.is(PersistenceSqlError);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const turns = yield* ProjectionTurnRepository;

  const upsertRow = SqlSchema.void({
    Request: ProjectionTurnStart,
    execute: (row) => sql`
      INSERT INTO projection_turn_starts (
        thread_id, message_id, turn_id, state,
        source_proposed_plan_thread_id, source_proposed_plan_id,
        requested_at, resolved_at
      ) VALUES (
        ${row.threadId}, ${row.messageId}, ${row.turnId}, ${row.state},
        ${row.sourceProposedPlanThreadId}, ${row.sourceProposedPlanId},
        ${row.requestedAt}, ${row.resolvedAt}
      )
      ON CONFLICT (thread_id, message_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        state = excluded.state,
        source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
        source_proposed_plan_id = excluded.source_proposed_plan_id,
        requested_at = excluded.requested_at,
        resolved_at = excluded.resolved_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionTurnStartByMessageIdInput,
    Result: ProjectionTurnStart,
    execute: ({ threadId, messageId }) => sql`
      SELECT
        thread_id AS "threadId", message_id AS "messageId", turn_id AS "turnId", state,
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        requested_at AS "requestedAt", resolved_at AS "resolvedAt"
      FROM projection_turn_starts
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
      LIMIT 1
    `,
  });
  const getEarliestTurnRow = SqlSchema.findOneOption({
    Request: GetProjectionTurnStartByTurnIdInput,
    Result: ProjectionTurnStart,
    execute: ({ threadId, turnId }) => sql`
      SELECT
        thread_id AS "threadId", message_id AS "messageId", turn_id AS "turnId", state,
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        requested_at AS "requestedAt", resolved_at AS "resolvedAt"
      FROM projection_turn_starts
      WHERE thread_id = ${threadId} AND turn_id = ${turnId} AND state = 'accepted'
      ORDER BY requested_at ASC, message_id ASC
      LIMIT 1
    `,
  });

  const deleteRows = SqlSchema.void({
    Request: DeleteProjectionTurnStartsByThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_turn_starts WHERE thread_id = ${threadId}
    `,
  });
  const listRows = SqlSchema.findAll({
    Request: DeleteProjectionTurnStartsByThreadInput,
    Result: ProjectionTurnStart,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId", message_id AS "messageId", turn_id AS "turnId", state,
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        requested_at AS "requestedAt", resolved_at AS "resolvedAt"
      FROM projection_turn_starts
      WHERE thread_id = ${threadId}
      ORDER BY requested_at ASC, message_id ASC
    `,
  });
  const listUnresolvedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTurnStart,
    execute: () => sql`
      SELECT
        thread_id AS "threadId", message_id AS "messageId", turn_id AS "turnId", state,
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        requested_at AS "requestedAt", resolved_at AS "resolvedAt"
      FROM projection_turn_starts
      WHERE state IN ('pending', 'submitting')
      ORDER BY requested_at ASC, thread_id ASC, message_id ASC
    `,
  });

  const upsert: ProjectionTurnStartRepositoryShape["upsert"] = (row) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* getRow({ threadId: row.threadId, messageId: row.messageId });
          if (Option.isSome(existing)) {
            const current = existing.value;
            const immutableFieldsMatch =
              current.threadId === row.threadId &&
              current.messageId === row.messageId &&
              current.sourceProposedPlanThreadId === row.sourceProposedPlanThreadId &&
              current.sourceProposedPlanId === row.sourceProposedPlanId &&
              current.requestedAt === row.requestedAt;
            const idempotent =
              current.state === row.state &&
              current.turnId === row.turnId &&
              current.resolvedAt === row.resolvedAt;
            const validResolution =
              (current.state === "pending" &&
                (row.state === "submitting" || row.state === "failed")) ||
              (current.state === "submitting" &&
                (row.state === "accepted" || row.state === "failed" || row.state === "ambiguous"));
            if (!immutableFieldsMatch || (!idempotent && !validResolution)) {
              return yield* new PersistenceSqlError({
                operation: "ProjectionTurnStartRepository.upsert",
                detail: `Rejected non-monotonic turn-start transition '${current.state}' -> '${row.state}'.`,
                correlation: { threadId: row.threadId },
              });
            }
          }
          yield* upsertRow(row);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isPersistenceSqlError(cause)
            ? cause
            : toPersistenceSqlOrDecodeError(
                "ProjectionTurnStartRepository.upsert:query",
                "ProjectionTurnStartRepository.upsert:encodeRequest",
              )(cause),
        ),
      );
  const getByMessageId: ProjectionTurnStartRepositoryShape["getByMessageId"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnStartRepository.getByMessageId:query",
          "ProjectionTurnStartRepository.getByMessageId:decodeRow",
        ),
      ),
    );
  const getEarliestByTurnId: ProjectionTurnStartRepositoryShape["getEarliestByTurnId"] = (input) =>
    getEarliestTurnRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnStartRepository.getEarliestByTurnId:query",
          "ProjectionTurnStartRepository.getEarliestByTurnId:decodeRow",
        ),
      ),
    );
  const getOutcomeByMessageId: ProjectionTurnStartRepositoryShape["getOutcomeByMessageId"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const start = yield* getByMessageId(input);
      if (Option.isNone(start)) {
        return Option.none();
      }
      const turn =
        start.value.turnId === null
          ? Option.none()
          : yield* turns.getByTurnId({ threadId: input.threadId, turnId: start.value.turnId });
      return Option.some({ start: start.value, turn: Option.getOrNull(turn) });
    });
  const deleteByThreadId: ProjectionTurnStartRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnStartRepository.deleteByThreadId:query"),
      ),
    );
  const listByThreadId: ProjectionTurnStartRepositoryShape["listByThreadId"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnStartRepository.listByThreadId:query",
          "ProjectionTurnStartRepository.listByThreadId:decodeRows",
        ),
      ),
    );
  const listUnresolved: ProjectionTurnStartRepositoryShape["listUnresolved"] = () =>
    listUnresolvedRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnStartRepository.listUnresolved:query",
          "ProjectionTurnStartRepository.listUnresolved:decodeRows",
        ),
      ),
    );

  return ProjectionTurnStartRepository.of({
    upsert,
    getByMessageId,
    getEarliestByTurnId,
    getOutcomeByMessageId,
    listByThreadId,
    listUnresolved,
    deleteByThreadId,
  });
});

export const ProjectionTurnStartRepositoryLive = Layer.effect(ProjectionTurnStartRepository, make);

import { VoiceHandoffFailureReason, VoiceHandoffFailureStage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  type DurableVoiceHandoffAction,
  VoiceHandoffActionConflictError,
  VoiceHandoffActionNotFoundError,
  VoiceHandoffActionOwnershipError,
  VoiceHandoffActionRepository,
  type VoiceHandoffActionRepositoryShape,
  type VoiceHandoffActionResult,
} from "../Services/VoiceHandoffActions.ts";

const VoiceHandoffActionRow = Schema.Struct({
  actionId: Schema.String,
  authSessionId: Schema.String,
  realtimeSessionId: Schema.String,
  realtimeGeneration: Schema.Number,
  conversationId: Schema.String,
  contextEpoch: Schema.Number,
  projectId: Schema.String,
  threadId: Schema.String,
  autoRearm: Schema.Number,
  status: Schema.Literals(["prepared", "pending", "settled", "expired"]),
  outcome: Schema.NullOr(Schema.Literals(["succeeded", "failed"])),
  outcomeState: Schema.NullOr(Schema.String),
  outcomeStage: Schema.NullOr(VoiceHandoffFailureStage),
  outcomeReason: Schema.NullOr(VoiceHandoffFailureReason),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
});

const selectColumns = `
  action_id AS "actionId", auth_session_id AS "authSessionId",
  realtime_session_id AS "realtimeSessionId",
  realtime_generation AS "realtimeGeneration", conversation_id AS "conversationId",
  context_epoch AS "contextEpoch", project_id AS "projectId", thread_id AS "threadId",
  auto_rearm AS "autoRearm", status, outcome, outcome_state AS "outcomeState",
  outcome_stage AS "outcomeStage", outcome_reason AS "outcomeReason",
  created_at AS "createdAt", updated_at AS "updatedAt", expires_at AS "expiresAt",
  settled_at AS "settledAt"
`;

const mapRow = (row: typeof VoiceHandoffActionRow.Type): DurableVoiceHandoffAction => ({
  ...row,
  autoRearm: row.autoRearm === 1,
});

const sameResult = (action: DurableVoiceHandoffAction, result: VoiceHandoffActionResult) =>
  action.outcome === result.outcome &&
  action.outcomeState === result.outcomeState &&
  action.outcomeStage === result.outcomeStage &&
  action.outcomeReason === result.outcomeReason;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const find = SqlSchema.findOneOption({
    Request: Schema.Struct({ actionId: Schema.String }),
    Result: VoiceHandoffActionRow,
    execute: ({ actionId }) =>
      sql.unsafe(`SELECT ${selectColumns} FROM voice_handoff_actions WHERE action_id = ? LIMIT 1`, [
        actionId,
      ]),
  });
  const findPending = SqlSchema.findAll({
    Request: Schema.Struct({
      authSessionId: Schema.String,
      realtimeSessionId: Schema.String,
      realtimeGeneration: Schema.Number,
      now: Schema.String,
      limit: Schema.Number,
    }),
    Result: VoiceHandoffActionRow,
    execute: (input) =>
      sql.unsafe(
        `SELECT ${selectColumns}
       FROM voice_handoff_actions
       WHERE auth_session_id = ? AND realtime_session_id = ? AND realtime_generation = ?
         AND status = 'pending' AND expires_at > ?
       ORDER BY created_at ASC, action_id ASC
       LIMIT ?`,
        [
          input.authSessionId,
          input.realtimeSessionId,
          input.realtimeGeneration,
          input.now,
          input.limit,
        ],
      ),
  });
  const findExpired = SqlSchema.findAll({
    Request: Schema.Struct({ now: Schema.String }),
    Result: VoiceHandoffActionRow,
    execute: ({ now }) =>
      sql.unsafe(
        `SELECT ${selectColumns}
       FROM voice_handoff_actions
       WHERE status = 'pending' AND expires_at <= ?
       ORDER BY expires_at ASC, action_id ASC`,
        [now],
      ),
  });

  const get: VoiceHandoffActionRepositoryShape["get"] = (actionId) =>
    find({ actionId }).pipe(
      Effect.map(Option.map(mapRow)),
      Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.get:query")),
    );

  const requireAction = (actionId: string) =>
    get(actionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new VoiceHandoffActionNotFoundError({ actionId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const create: VoiceHandoffActionRepositoryShape["create"] = Effect.fn(
    "VoiceHandoffActionRepository.create",
  )(function* (input) {
    yield* sql`
      INSERT INTO voice_handoff_actions (
        action_id, auth_session_id, realtime_session_id,
        realtime_generation, conversation_id, context_epoch, project_id, thread_id,
        auto_rearm, status, created_at, updated_at, expires_at
      ) VALUES (
        ${input.actionId}, ${input.authSessionId},
        ${input.realtimeSessionId}, ${input.realtimeGeneration}, ${input.conversationId},
        ${input.contextEpoch}, ${input.projectId}, ${input.threadId},
        ${input.autoRearm ? 1 : 0}, 'prepared', ${input.createdAt}, ${input.createdAt},
        ${input.expiresAt}
      ) ON CONFLICT (action_id) DO NOTHING
    `.pipe(Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.create:insert")));
    const action = yield* requireAction(input.actionId);
    const matches =
      action.authSessionId === input.authSessionId &&
      action.realtimeSessionId === input.realtimeSessionId &&
      action.realtimeGeneration === input.realtimeGeneration &&
      action.conversationId === input.conversationId &&
      action.contextEpoch === input.contextEpoch &&
      action.projectId === input.projectId &&
      action.threadId === input.threadId &&
      action.autoRearm === input.autoRearm;
    if (!matches) {
      return yield* new VoiceHandoffActionConflictError({
        actionId: input.actionId,
        operation: "create",
      });
    }
    return action;
  });

  const activate: VoiceHandoffActionRepositoryShape["activate"] = Effect.fn(
    "VoiceHandoffActionRepository.activate",
  )(function* (input) {
    const action = yield* requireAction(input.actionId);
    if (action.status === "pending") return action;
    if (action.status !== "prepared") {
      return yield* new VoiceHandoffActionConflictError({
        actionId: input.actionId,
        operation: "activate",
      });
    }
    yield* sql`
      UPDATE voice_handoff_actions
      SET status = 'pending', updated_at = ${input.activatedAt}, expires_at = ${input.expiresAt}
      WHERE action_id = ${input.actionId} AND status = 'prepared'
    `.pipe(Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.activate:update")));
    const activated = yield* requireAction(input.actionId);
    if (activated.status !== "pending") {
      return yield* new VoiceHandoffActionConflictError({
        actionId: input.actionId,
        operation: "activate-race",
      });
    }
    return activated;
  });

  const listPending: VoiceHandoffActionRepositoryShape["listPending"] = (input) =>
    findPending(input).pipe(
      Effect.map((rows) => rows.map(mapRow)),
      Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.listPending:query")),
    );

  const acknowledge: VoiceHandoffActionRepositoryShape["acknowledge"] = Effect.fn(
    "VoiceHandoffActionRepository.acknowledge",
  )(function* (input) {
    const action = yield* requireAction(input.actionId);
    if (action.authSessionId !== input.authSessionId) {
      return yield* new VoiceHandoffActionOwnershipError({
        actionId: input.actionId,
      });
    }
    if (action.status === "settled" && sameResult(action, input.result)) return action;
    if (action.status === "expired") return action;
    if (
      action.status !== "pending" &&
      !(action.status === "prepared" && input.result.outcome === "failed")
    ) {
      return yield* new VoiceHandoffActionConflictError({
        actionId: input.actionId,
        operation: "acknowledge",
      });
    }
    if (action.status === "pending" && action.expiresAt <= input.acknowledgedAt) {
      yield* sql`
        UPDATE voice_handoff_actions
        SET status = 'expired', outcome = 'failed', outcome_stage = 'recognition-start',
            outcome_reason = 'operation-timeout', updated_at = ${input.acknowledgedAt},
            settled_at = ${input.acknowledgedAt}
        WHERE action_id = ${input.actionId} AND status = 'pending'
      `.pipe(
        Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.acknowledge:expire")),
      );
      const terminal = yield* requireAction(input.actionId);
      if (terminal.status === "expired") return terminal;
      if (terminal.status === "settled" && sameResult(terminal, input.result)) return terminal;
      return yield* new VoiceHandoffActionConflictError({
        actionId: input.actionId,
        operation: "acknowledge-expiry-race",
      });
    }
    yield* sql`
      UPDATE voice_handoff_actions
      SET status = 'settled', outcome = ${input.result.outcome},
          outcome_state = ${input.result.outcomeState}, outcome_stage = ${input.result.outcomeStage},
          outcome_reason = ${input.result.outcomeReason}, updated_at = ${input.acknowledgedAt},
          settled_at = ${input.acknowledgedAt}
      WHERE action_id = ${input.actionId}
        AND (status = 'pending' OR (status = 'prepared' AND ${input.result.outcome} = 'failed'))
    `.pipe(
      Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.acknowledge:update")),
    );
    const settled = yield* requireAction(input.actionId);
    if (settled.status !== "settled" || !sameResult(settled, input.result)) {
      return yield* new VoiceHandoffActionConflictError({
        actionId: input.actionId,
        operation: "acknowledge-race",
      });
    }
    return settled;
  });

  const expire: VoiceHandoffActionRepositoryShape["expire"] = Effect.fn(
    "VoiceHandoffActionRepository.expire",
  )(function* (input) {
    const candidates = yield* findExpired({ now: input.now }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.expire:list")),
    );
    if (candidates.length === 0) return [];
    yield* sql`
      UPDATE voice_handoff_actions
      SET status = 'expired', outcome = 'failed', outcome_stage = 'recognition-start',
          outcome_reason = 'operation-timeout', updated_at = ${input.now}, settled_at = ${input.now}
      WHERE status = 'pending' AND expires_at <= ${input.now}
    `.pipe(Effect.mapError(toPersistenceSqlError("VoiceHandoffActionRepository.expire:update")));
    return yield* Effect.forEach(candidates, (candidate) => requireAction(candidate.actionId));
  });

  return VoiceHandoffActionRepository.of({
    create,
    get,
    activate,
    listPending,
    acknowledge,
    expire,
  });
});

export const VoiceHandoffActionRepositoryLive = Layer.effect(VoiceHandoffActionRepository, make);

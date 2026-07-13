import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceNativeRuntimeId,
  VoiceNativeThreadTurnEvent,
  VoiceNativeThreadTurnOperationId,
  type VoiceNativeThreadTurnPhase,
  type VoiceSpeechPreset,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceNativeThreadTurnStore,
  type PersistedVoiceNativeThreadTurn,
  type VoiceNativeThreadTurnStoreShape,
} from "../Services/VoiceNativeThreadTurns.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(VoiceNativeThreadTurnEvent));
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceNativeThreadTurnEvent));

interface OperationRow {
  readonly operationId: string;
  readonly authSessionId: string;
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
  readonly clientOperationId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly speechPreset: VoiceSpeechPreset;
  readonly autoRearm: number;
  readonly phase: VoiceNativeThreadTurnPhase;
  readonly processingLeaseUntil: number | null;
  readonly processingAttempt: number;
  readonly commandId: string | null;
  readonly messageId: string | null;
  readonly turnId: string | null;
  readonly lastSequence: number;
  readonly acknowledgedSequence: number;
  readonly speechTerminal: "completed" | "no-speech" | "failed" | null;
  readonly dispatchAccepted: number;
  readonly expiresAt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const operationColumns = `
  operation_id AS "operationId", auth_session_id AS "authSessionId",
  runtime_id AS "runtimeId", runtime_generation AS "runtimeGeneration",
  client_operation_id AS "clientOperationId", project_id AS "projectId",
  thread_id AS "threadId", speech_preset AS "speechPreset", auto_rearm AS "autoRearm",
  phase, processing_lease_until AS "processingLeaseUntil",
  processing_attempt AS "processingAttempt", command_id AS "commandId",
  message_id AS "messageId", turn_id AS "turnId", last_sequence AS "lastSequence",
  acknowledged_sequence AS "acknowledgedSequence", speech_terminal AS "speechTerminal",
  dispatch_accepted AS "dispatchAccepted", expires_at AS "expiresAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const qualifiedOperationColumns = `
  operation.operation_id AS "operationId", operation.auth_session_id AS "authSessionId",
  operation.runtime_id AS "runtimeId", operation.runtime_generation AS "runtimeGeneration",
  operation.client_operation_id AS "clientOperationId", operation.project_id AS "projectId",
  operation.thread_id AS "threadId", operation.speech_preset AS "speechPreset",
  operation.auto_rearm AS "autoRearm", operation.phase,
  operation.processing_lease_until AS "processingLeaseUntil",
  operation.processing_attempt AS "processingAttempt", operation.command_id AS "commandId",
  operation.message_id AS "messageId", operation.turn_id AS "turnId",
  operation.last_sequence AS "lastSequence",
  operation.acknowledged_sequence AS "acknowledgedSequence",
  operation.speech_terminal AS "speechTerminal",
  operation.dispatch_accepted AS "dispatchAccepted", operation.expires_at AS "expiresAt",
  operation.created_at AS "createdAt", operation.updated_at AS "updatedAt"
`;

const mapOperation = (row: OperationRow): PersistedVoiceNativeThreadTurn => ({
  operationId: VoiceNativeThreadTurnOperationId.make(row.operationId),
  authSessionId: AuthSessionId.make(row.authSessionId),
  runtimeId: VoiceNativeRuntimeId.make(row.runtimeId),
  runtimeGeneration: row.runtimeGeneration,
  clientOperationId: row.clientOperationId,
  projectId: ProjectId.make(row.projectId),
  threadId: ThreadId.make(row.threadId),
  speechPreset: row.speechPreset,
  autoRearm: row.autoRearm === 1,
  phase: row.phase,
  processingLeaseUntil: row.processingLeaseUntil,
  processingAttempt: row.processingAttempt,
  commandId: row.commandId === null ? null : CommandId.make(row.commandId),
  messageId: row.messageId === null ? null : MessageId.make(row.messageId),
  turnId: row.turnId === null ? null : TurnId.make(row.turnId),
  lastSequence: row.lastSequence,
  acknowledgedSequence: row.acknowledgedSequence,
  speechTerminal: row.speechTerminal,
  dispatchAccepted: row.dispatchAccepted === 1,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get: VoiceNativeThreadTurnStoreShape["get"] = (operationId) =>
    sql
      .unsafe<OperationRow>(
        `SELECT ${operationColumns} FROM voice_native_thread_turn_operations
       WHERE operation_id = ? LIMIT 1`,
        [operationId],
      )
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : mapOperation(rows[0]))),
        Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.get")),
      );

  const claim: VoiceNativeThreadTurnStoreShape["claim"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_native_thread_turn_operations
          SET active_slot = NULL
          WHERE expires_at <= ${input.nowEpochMillis}`;
          const existing = yield* sql.unsafe<OperationRow>(
            `SELECT ${operationColumns} FROM voice_native_thread_turn_operations
           WHERE auth_session_id = ? AND runtime_id = ? AND runtime_generation = ?
             AND client_operation_id = ? LIMIT 1`,
            [
              input.authSessionId,
              input.runtimeId,
              input.runtimeGeneration,
              input.clientOperationId,
            ],
          );
          if (existing[0] !== undefined) {
            yield* sql`UPDATE voice_native_thread_turn_operations
            SET token_hash = ${input.tokenHash}, expires_at = ${input.expiresAt},
                updated_at = ${input.now}
            WHERE operation_id = ${existing[0].operationId}`;
            return mapOperation({
              ...existing[0],
              expiresAt: input.expiresAt,
              updatedAt: input.now,
            });
          }
          yield* sql`INSERT INTO voice_native_thread_turn_operations (
          operation_id, auth_session_id, runtime_id, runtime_generation, client_operation_id,
          project_id, thread_id, speech_preset, auto_rearm, token_hash, phase, active_slot,
          expires_at, created_at, updated_at, last_sequence
        ) VALUES (
          ${input.operationId}, ${input.authSessionId}, ${input.runtimeId},
          ${input.runtimeGeneration}, ${input.clientOperationId}, ${input.projectId},
          ${input.threadId}, ${input.speechPreset}, ${input.autoRearm ? 1 : 0},
          ${input.tokenHash}, 'created', 1, ${input.expiresAt}, ${input.now}, ${input.now}, 1
        )`;
          const event = {
            type: "phase" as const,
            sequence: 1,
            occurredAt: input.now,
            phase: "created" as const,
          };
          yield* sql`INSERT INTO voice_native_thread_turn_events (
          operation_id, sequence, event_json, occurred_at
        ) VALUES (${input.operationId}, 1, ${encodeEvent(event)}, ${input.now})`;
          return {
            operationId: input.operationId,
            authSessionId: input.authSessionId,
            runtimeId: input.runtimeId,
            runtimeGeneration: input.runtimeGeneration,
            clientOperationId: input.clientOperationId,
            projectId: input.projectId,
            threadId: input.threadId,
            speechPreset: input.speechPreset,
            autoRearm: input.autoRearm,
            phase: "created" as const,
            processingLeaseUntil: null,
            processingAttempt: 0,
            commandId: null,
            messageId: null,
            turnId: null,
            lastSequence: 1,
            acknowledgedSequence: 0,
            speechTerminal: null,
            dispatchAccepted: false,
            expiresAt: input.expiresAt,
            createdAt: input.now,
            updatedAt: input.now,
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.claim")));

  const authorize: VoiceNativeThreadTurnStoreShape["authorize"] = (operationId, tokenHash, now) => {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
    return sql
      .unsafe<OperationRow>(
        `SELECT ${qualifiedOperationColumns}
       FROM voice_native_thread_turn_operations AS operation
       INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
       LEFT JOIN voice_native_runtime_grants AS runtime
         ON runtime.auth_session_id = operation.auth_session_id
         AND runtime.runtime_id = operation.runtime_id
         AND runtime.generation = operation.runtime_generation
         AND runtime.expires_at > ?
       WHERE operation.operation_id = ? AND operation.token_hash = ?
         AND operation.expires_at > ? AND auth.revoked_at IS NULL AND auth.expires_at > ?
         AND (operation.dispatch_accepted = 1 OR runtime.token_hash IS NOT NULL)
       LIMIT 1`,
        [now, operationId, tokenHash, now, nowIso],
      )
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : mapOperation(rows[0]))),
        Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.authorize")),
      );
  };

  const claimProcessing: VoiceNativeThreadTurnStoreShape["claimProcessing"] = (
    operationId,
    now,
    leaseUntil,
    updatedAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_native_thread_turn_operations
          SET processing_lease_until = ${leaseUntil}, processing_attempt = processing_attempt + 1,
              updated_at = ${updatedAt}
          WHERE operation_id = ${operationId} AND dispatch_accepted = 0
            AND phase NOT IN ('completed', 'cancelled')
            AND (processing_lease_until IS NULL OR processing_lease_until <= ${now})`;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.claimProcessing")));

  const appendEvent: VoiceNativeThreadTurnStoreShape["appendEvent"] = (
    operationId,
    event,
    updates = {},
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly lastSequence: number }>`
          SELECT last_sequence AS "lastSequence" FROM voice_native_thread_turn_operations
          WHERE operation_id = ${operationId} LIMIT 1`;
          const sequence = (rows[0]?.lastSequence ?? 0) + 1;
          const persisted = { ...event, sequence } as VoiceNativeThreadTurnEvent;
          yield* sql`INSERT INTO voice_native_thread_turn_events (
          operation_id, sequence, event_json, occurred_at
        ) VALUES (${operationId}, ${sequence}, ${encodeEvent(persisted)}, ${event.occurredAt})`;
          yield* sql`UPDATE voice_native_thread_turn_operations SET
          last_sequence = ${sequence}, updated_at = ${event.occurredAt}
          WHERE operation_id = ${operationId}`;
          if (updates.phase !== undefined)
            yield* sql`UPDATE voice_native_thread_turn_operations SET phase = ${updates.phase}
            WHERE operation_id = ${operationId}`;
          if (updates.commandId !== undefined)
            yield* sql`UPDATE voice_native_thread_turn_operations SET command_id = ${updates.commandId}
            WHERE operation_id = ${operationId}`;
          if (updates.messageId !== undefined)
            yield* sql`UPDATE voice_native_thread_turn_operations SET message_id = ${updates.messageId}
            WHERE operation_id = ${operationId}`;
          if (updates.turnId !== undefined)
            yield* sql`UPDATE voice_native_thread_turn_operations SET turn_id = ${updates.turnId}
            WHERE operation_id = ${operationId}`;
          if (updates.speechTerminal !== undefined)
            yield* sql`UPDATE voice_native_thread_turn_operations
            SET speech_terminal = ${updates.speechTerminal} WHERE operation_id = ${operationId}`;
          if (updates.dispatchAccepted !== undefined)
            yield* sql`UPDATE voice_native_thread_turn_operations
            SET dispatch_accepted = ${updates.dispatchAccepted ? 1 : 0}
            WHERE operation_id = ${operationId}`;
          if (updates.clearProcessingLease === true)
            yield* sql`UPDATE voice_native_thread_turn_operations
            SET processing_lease_until = NULL WHERE operation_id = ${operationId}`;
          if (updates.terminal === true)
            yield* sql`UPDATE voice_native_thread_turn_operations SET active_slot = NULL
            WHERE operation_id = ${operationId}`;
          return persisted;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.appendEvent")));

  const listEvents: VoiceNativeThreadTurnStoreShape["listEvents"] = (
    operationId,
    afterSequence,
    limit,
  ) =>
    sql<{
      readonly eventJson: string;
    }>`SELECT event_json AS "eventJson" FROM voice_native_thread_turn_events
      WHERE operation_id = ${operationId} AND sequence > ${afterSequence}
      ORDER BY sequence ASC LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map((row) => decodeEvent(row.eventJson))),
      Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.listEvents")),
    );

  const acknowledge: VoiceNativeThreadTurnStoreShape["acknowledge"] = (operationId, sequence) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_native_thread_turn_operations
          SET acknowledged_sequence = MAX(acknowledged_sequence, ${sequence})
          WHERE operation_id = ${operationId} AND last_sequence >= ${sequence}`;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.acknowledge")));

  const putSpeechSegment: VoiceNativeThreadTurnStoreShape["putSpeechSegment"] = (segment) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO voice_native_thread_turn_speech_segments (
          operation_id, segment_index, assistant_message_id, start_offset, end_offset,
          final_segment, created_at
        ) VALUES (
          ${segment.operationId}, ${segment.segmentIndex}, ${segment.assistantMessageId},
          ${segment.startOffset}, ${segment.endOffset},
          ${segment.finalSegment ? 1 : 0}, ${segment.createdAt}
        )`;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.putSpeechSegment")));

  const getSpeechSegment: VoiceNativeThreadTurnStoreShape["getSpeechSegment"] = (
    operationId,
    segmentIndex,
  ) =>
    sql<{
      readonly operationId: string;
      readonly segmentIndex: number;
      readonly assistantMessageId: string;
      readonly startOffset: number;
      readonly endOffset: number;
      readonly finalSegment: number;
      readonly createdAt: string;
    }>`SELECT operation_id AS "operationId", segment_index AS "segmentIndex",
      assistant_message_id AS "assistantMessageId", start_offset AS "startOffset",
      end_offset AS "endOffset", final_segment AS "finalSegment", created_at AS "createdAt"
      FROM voice_native_thread_turn_speech_segments
      WHERE operation_id = ${operationId} AND segment_index = ${segmentIndex} LIMIT 1`.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined
          ? undefined
          : {
              operationId: VoiceNativeThreadTurnOperationId.make(row.operationId),
              segmentIndex: row.segmentIndex,
              assistantMessageId: MessageId.make(row.assistantMessageId),
              startOffset: row.startOffset,
              endOffset: row.endOffset,
              finalSegment: row.finalSegment === 1,
              createdAt: row.createdAt,
            };
      }),
      Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.getSpeechSegment")),
    );

  const revokeRuntime: VoiceNativeThreadTurnStoreShape["revokeRuntime"] = (
    authSessionId,
    runtimeId,
  ) =>
    sql`DELETE FROM voice_native_thread_turn_operations
      WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.revokeRuntime")),
    );
  const revokeAuthSession: VoiceNativeThreadTurnStoreShape["revokeAuthSession"] = (authSessionId) =>
    sql`DELETE FROM voice_native_thread_turn_operations
      WHERE auth_session_id = ${authSessionId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.revokeAuthSession")),
    );

  return VoiceNativeThreadTurnStore.of({
    claim,
    authorize,
    get,
    claimProcessing,
    appendEvent,
    listEvents,
    acknowledge,
    putSpeechSegment,
    getSpeechSegment,
    revokeRuntime,
    revokeAuthSession,
  });
});

export const VoiceNativeThreadTurnStoreLive = Layer.effect(VoiceNativeThreadTurnStore, make);

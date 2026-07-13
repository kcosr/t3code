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
import * as NodeCrypto from "node:crypto";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceNativeThreadTurnStore,
  type PersistedVoiceNativeThreadTurn,
  type VoiceNativeThreadTurnEventWithoutSequence,
  type VoiceNativeThreadTurnStoreShape,
} from "../Services/VoiceNativeThreadTurns.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(VoiceNativeThreadTurnEvent));
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceNativeThreadTurnEvent));
const decodeAssistantEventPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.optionalKey(Schema.String),
      streaming: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
const terminalPhase = (phase: VoiceNativeThreadTurnPhase) =>
  phase === "completed" || phase === "failed" || phase === "cancelled";
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
interface AssistantEventRow {
  readonly sequence: number;
  readonly payloadJson: string;
}
const reconstructAssistantText = (rows: ReadonlyArray<AssistantEventRow>) => {
  let text = "";
  for (const row of rows) {
    const payload = decodeAssistantEventPayload(row.payloadJson);
    if (payload.text === undefined) continue;
    text =
      payload.streaming === true
        ? `${text}${payload.text}`
        : payload.text.length === 0
          ? text
          : payload.text;
  }
  return text;
};

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
  readonly processingLeaseToken: string | null;
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
  processing_lease_token AS "processingLeaseToken",
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
  operation.processing_lease_token AS "processingLeaseToken",
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
  processingLeaseToken: row.processingLeaseToken,
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
            const prior = mapOperation(existing[0]);
            if (prior.expiresAt <= input.nowEpochMillis)
              return { status: "expired" as const, operation: prior };
            if (
              prior.operationId !== input.operationId ||
              prior.projectId !== input.projectId ||
              prior.threadId !== input.threadId ||
              prior.speechPreset !== input.speechPreset ||
              prior.autoRearm !== input.autoRearm
            )
              return { status: "mismatch" as const, operation: prior };
            yield* sql`UPDATE voice_native_thread_turn_operations
            SET token_hash = ${input.tokenHash}, expires_at = ${input.expiresAt},
                updated_at = ${input.now}
            WHERE operation_id = ${existing[0].operationId}`;
            return {
              status: "claimed" as const,
              operation: mapOperation({
                ...existing[0],
                expiresAt: input.expiresAt,
                updatedAt: input.now,
              }),
            };
          }
          yield* sql`UPDATE voice_native_thread_turn_operations
          SET active_slot = NULL
          WHERE expires_at <= ${input.nowEpochMillis} AND active_slot = 1`;
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
            status: "claimed" as const,
            operation: {
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
              processingLeaseToken: null,
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
            },
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
    leaseToken,
    now,
    leaseUntil,
    updatedAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_native_thread_turn_operations
          SET processing_lease_until = ${leaseUntil}, processing_lease_token = ${leaseToken},
              processing_attempt = processing_attempt + 1,
              updated_at = ${updatedAt}
          WHERE operation_id = ${operationId} AND dispatch_accepted = 0
            AND active_slot = 1 AND expires_at > ${now}
            AND phase NOT IN ('completed', 'failed', 'cancelled')
            AND (processing_lease_until IS NULL OR processing_lease_until <= ${now})`;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.claimProcessing")));

  const beginDispatch: VoiceNativeThreadTurnStoreShape["beginDispatch"] = (
    operationId,
    leaseToken,
    now,
    occurredAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_native_thread_turn_operations
          SET phase = 'dispatching', updated_at = ${occurredAt}
          WHERE operation_id = ${operationId} AND phase = 'transcribing'
            AND active_slot = 1 AND processing_lease_token = ${leaseToken}
            AND EXISTS (
              SELECT 1 FROM voice_native_runtime_grants AS runtime
              WHERE runtime.auth_session_id = voice_native_thread_turn_operations.auth_session_id
                AND runtime.runtime_id = voice_native_thread_turn_operations.runtime_id
                AND runtime.generation = voice_native_thread_turn_operations.runtime_generation
                AND runtime.expires_at > ${now}
            )`;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          if (changed[0]?.changed !== 1) return false;
          const row = yield* sql<{ readonly lastSequence: number }>`
            SELECT last_sequence AS "lastSequence"
            FROM voice_native_thread_turn_operations WHERE operation_id = ${operationId}`;
          const sequence = (row[0]?.lastSequence ?? 0) + 1;
          const event = {
            type: "phase" as const,
            sequence,
            occurredAt,
            phase: "dispatching" as const,
          };
          yield* sql`INSERT INTO voice_native_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(event)}, ${occurredAt})`;
          yield* sql`UPDATE voice_native_thread_turn_operations
            SET last_sequence = ${sequence} WHERE operation_id = ${operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.beginDispatch")));

  const acceptDispatch: VoiceNativeThreadTurnStoreShape["acceptDispatch"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* sql<{ readonly lastSequence: number }>`
            SELECT last_sequence AS "lastSequence"
            FROM voice_native_thread_turn_operations
            WHERE operation_id = ${input.operationId} AND phase = 'dispatching'
              AND active_slot = 1 AND processing_lease_token = ${input.leaseToken}`;
          if (row[0] === undefined) return false;
          const sequence = row[0].lastSequence + 1;
          const event = {
            type: "dispatch-correlation" as const,
            sequence,
            occurredAt: input.occurredAt,
            commandId: input.commandId,
            messageId: input.messageId,
            turnId: null,
          };
          yield* sql`INSERT INTO voice_native_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${input.operationId}, ${sequence}, ${encodeEvent(event)}, ${input.occurredAt})`;
          yield* sql`UPDATE voice_native_thread_turn_operations SET
            phase = 'waiting', command_id = ${input.commandId}, message_id = ${input.messageId},
            dispatch_accepted = 1, processing_lease_until = NULL,
            processing_lease_token = NULL, last_sequence = ${sequence}, updated_at = ${input.occurredAt}
            WHERE operation_id = ${input.operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.acceptDispatch")));

  const releaseProcessing: VoiceNativeThreadTurnStoreShape["releaseProcessing"] = (
    operationId,
    leaseToken,
    occurredAt,
    failureCode,
    retryable,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly lastSequence: number }>`
            SELECT last_sequence AS "lastSequence"
            FROM voice_native_thread_turn_operations
            WHERE operation_id = ${operationId} AND active_slot = 1
              AND processing_lease_token = ${leaseToken}`;
          if (rows[0] === undefined) return false;
          const sequence = rows[0].lastSequence + 1;
          const event = {
            type: "failure" as const,
            sequence,
            occurredAt,
            code: failureCode,
            retryable,
          };
          yield* sql`INSERT INTO voice_native_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(event)}, ${occurredAt})`;
          yield* sql`UPDATE voice_native_thread_turn_operations SET
            phase = 'created', processing_lease_until = NULL, processing_lease_token = NULL,
            last_sequence = ${sequence}, updated_at = ${occurredAt}
            WHERE operation_id = ${operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.releaseProcessing")));

  const appendEvent: VoiceNativeThreadTurnStoreShape["appendEvent"] = (
    operationId,
    event,
    updates = {},
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly lastSequence: number;
            readonly phase: VoiceNativeThreadTurnPhase;
          }>`SELECT last_sequence AS "lastSequence", phase
            FROM voice_native_thread_turn_operations
            WHERE operation_id = ${operationId} LIMIT 1`;
          if (rows[0] === undefined || terminalPhase(rows[0].phase)) return undefined;
          const sequence = rows[0].lastSequence + 1;
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
          if (updates.turnId !== undefined)
            yield* sql`UPDATE voice_native_thread_turn_operations SET turn_id = ${updates.turnId}
            WHERE operation_id = ${operationId}`;
          return persisted;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.appendEvent")));

  const finalize: VoiceNativeThreadTurnStoreShape["finalize"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly lastSequence: number;
            readonly phase: VoiceNativeThreadTurnPhase;
            readonly processingLeaseToken: string | null;
          }>`SELECT last_sequence AS "lastSequence", phase,
              processing_lease_token AS "processingLeaseToken"
            FROM voice_native_thread_turn_operations
            WHERE operation_id = ${input.operationId} LIMIT 1`;
          const row = rows[0];
          if (
            row === undefined ||
            terminalPhase(row.phase) ||
            (input.leaseToken !== undefined && row.processingLeaseToken !== input.leaseToken) ||
            (input.requireUnleased === true && row.processingLeaseToken !== null)
          )
            return false;
          let sequence = row.lastSequence;
          const events: Array<VoiceNativeThreadTurnEventWithoutSequence> = [];
          if (input.failureCode !== undefined)
            events.push({
              type: "failure",
              occurredAt: input.occurredAt,
              code: input.failureCode,
              retryable: input.retryable ?? false,
            });
          if (input.speechOutcome !== undefined)
            events.push({
              type: "speech-terminal",
              occurredAt: input.occurredAt,
              outcome: input.speechOutcome,
            });
          if (input.outcome === "completed")
            events.push({ type: "phase", occurredAt: input.occurredAt, phase: "completed" });
          events.push({ type: "terminal", occurredAt: input.occurredAt, outcome: input.outcome });
          for (const event of events) {
            sequence += 1;
            const persisted = { ...event, sequence } as VoiceNativeThreadTurnEvent;
            yield* sql`INSERT INTO voice_native_thread_turn_events
              (operation_id, sequence, event_json, occurred_at)
              VALUES (${input.operationId}, ${sequence}, ${encodeEvent(persisted)}, ${input.occurredAt})`;
          }
          const phase = input.outcome === "cancelled" ? "cancelled" : input.outcome;
          yield* sql`UPDATE voice_native_thread_turn_operations SET
            phase = ${phase}, speech_terminal = ${input.speechOutcome ?? null},
            last_sequence = ${sequence}, active_slot = NULL,
            processing_lease_until = NULL, processing_lease_token = NULL,
            updated_at = ${input.occurredAt}
            WHERE operation_id = ${input.operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.finalize")));

  const cancel: VoiceNativeThreadTurnStoreShape["cancel"] = (operationId, occurredAt) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly lastSequence: number;
            readonly phase: VoiceNativeThreadTurnPhase;
            readonly dispatchAccepted: number;
          }>`SELECT last_sequence AS "lastSequence", phase,
              dispatch_accepted AS "dispatchAccepted"
            FROM voice_native_thread_turn_operations
            WHERE operation_id = ${operationId} LIMIT 1`;
          const row = rows[0];
          if (row === undefined || terminalPhase(row.phase)) return "terminal" as const;
          if (row.phase === "dispatching") return "dispatch-committed" as const;
          let sequence = row.lastSequence + 1;
          const phaseEvent = {
            type: "phase" as const,
            sequence,
            occurredAt,
            phase: "cancelled" as const,
          };
          yield* sql`INSERT INTO voice_native_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(phaseEvent)}, ${occurredAt})`;
          sequence += 1;
          const terminalEvent = {
            type: "terminal" as const,
            sequence,
            occurredAt,
            outcome: "cancelled" as const,
          };
          yield* sql`INSERT INTO voice_native_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(terminalEvent)}, ${occurredAt})`;
          yield* sql`UPDATE voice_native_thread_turn_operations SET
            phase = 'cancelled', last_sequence = ${sequence}, active_slot = NULL,
            processing_lease_until = NULL, processing_lease_token = NULL,
            updated_at = ${occurredAt} WHERE operation_id = ${operationId}`;
          return "cancelled" as const;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.cancel")));

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

  const resolveAssistantRevision: VoiceNativeThreadTurnStoreShape["resolveAssistantRevision"] = (
    assistantMessageId,
  ) =>
    sql
      .unsafe<AssistantEventRow>(
        `SELECT sequence, payload_json AS "payloadJson" FROM orchestration_events
           WHERE event_type = 'thread.message-sent'
             AND json_extract(payload_json, '$.messageId') = ?
             AND json_extract(payload_json, '$.role') = 'assistant'
           ORDER BY sequence ASC`,
        [assistantMessageId],
      )
      .pipe(
        Effect.map((rows) =>
          rows.length === 0
            ? undefined
            : {
                sourceEventSequence: rows[rows.length - 1]!.sequence,
                sourceTextSha256: sha256(reconstructAssistantText(rows)),
              },
        ),
        Effect.mapError(
          toPersistenceSqlError("VoiceNativeThreadTurnStore.resolveAssistantRevision"),
        ),
      );

  const putSpeechSegmentAndEvent: VoiceNativeThreadTurnStoreShape["putSpeechSegmentAndEvent"] = (
    segment,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* sql<{
            readonly phase: VoiceNativeThreadTurnPhase;
            readonly lastSequence: number;
          }>`SELECT phase, last_sequence AS "lastSequence"
            FROM voice_native_thread_turn_operations
            WHERE operation_id = ${segment.operationId}`;
          if (operation[0] === undefined || terminalPhase(operation[0].phase))
            return "terminal" as const;
          const existing = yield* sql<{
            readonly assistantMessageId: string;
            readonly startOffset: number;
            readonly endOffset: number;
            readonly finalSegment: number;
            readonly sourceEventSequence: number;
            readonly sourceTextSha256: string;
          }>`SELECT assistant_message_id AS "assistantMessageId",
              start_offset AS "startOffset", end_offset AS "endOffset",
              final_segment AS "finalSegment", source_event_sequence AS "sourceEventSequence",
              source_text_sha256 AS "sourceTextSha256"
            FROM voice_native_thread_turn_speech_segments
            WHERE operation_id = ${segment.operationId}
              AND segment_index = ${segment.segmentIndex}`;
          if (existing[0] !== undefined) {
            const prior = existing[0];
            return prior.assistantMessageId === segment.assistantMessageId &&
              prior.startOffset === segment.startOffset &&
              prior.endOffset === segment.endOffset &&
              prior.finalSegment === (segment.finalSegment ? 1 : 0) &&
              prior.sourceEventSequence === segment.sourceEventSequence &&
              prior.sourceTextSha256 === segment.sourceTextSha256
              ? ("existing" as const)
              : ("mismatch" as const);
          }
          yield* sql`INSERT INTO voice_native_thread_turn_speech_segments (
          operation_id, segment_index, assistant_message_id, start_offset, end_offset,
          final_segment, source_event_sequence, source_text_sha256, created_at
        ) VALUES (
          ${segment.operationId}, ${segment.segmentIndex}, ${segment.assistantMessageId},
          ${segment.startOffset}, ${segment.endOffset},
          ${segment.finalSegment ? 1 : 0}, ${segment.sourceEventSequence},
          ${segment.sourceTextSha256}, ${segment.createdAt}
        )`;
          const sequence = operation[0].lastSequence + 1;
          const event = {
            type: "speech-ready" as const,
            sequence,
            occurredAt: segment.createdAt,
            segmentIndex: segment.segmentIndex,
            finalSegment: segment.finalSegment,
          };
          yield* sql`INSERT INTO voice_native_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${segment.operationId}, ${sequence}, ${encodeEvent(event)}, ${segment.createdAt})`;
          yield* sql`UPDATE voice_native_thread_turn_operations SET
            phase = 'speaking', last_sequence = ${sequence}, updated_at = ${segment.createdAt}
            WHERE operation_id = ${segment.operationId}`;
          return "inserted" as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceNativeThreadTurnStore.putSpeechSegmentAndEvent"),
        ),
      );

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
      readonly sourceEventSequence: number;
      readonly sourceTextSha256: string;
      readonly createdAt: string;
    }>`SELECT operation_id AS "operationId", segment_index AS "segmentIndex",
      assistant_message_id AS "assistantMessageId", start_offset AS "startOffset",
      end_offset AS "endOffset", final_segment AS "finalSegment",
      source_event_sequence AS "sourceEventSequence",
      source_text_sha256 AS "sourceTextSha256", created_at AS "createdAt"
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
              sourceEventSequence: row.sourceEventSequence,
              sourceTextSha256: row.sourceTextSha256,
              createdAt: row.createdAt,
            };
      }),
      Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.getSpeechSegment")),
    );

  const getSpeechSegmentText: VoiceNativeThreadTurnStoreShape["getSpeechSegmentText"] = (
    operationId,
    segmentIndex,
  ) =>
    Effect.gen(function* () {
      const segment = yield* getSpeechSegment(operationId, segmentIndex);
      if (segment === undefined) return undefined;
      const rows = yield* sql.unsafe<AssistantEventRow>(
        `SELECT sequence, payload_json AS "payloadJson" FROM orchestration_events
         WHERE event_type = 'thread.message-sent'
           AND json_extract(payload_json, '$.messageId') = ?
           AND json_extract(payload_json, '$.role') = 'assistant'
           AND sequence <= ? ORDER BY sequence ASC`,
        [segment.assistantMessageId, segment.sourceEventSequence],
      );
      const canonical = reconstructAssistantText(rows);
      if (sha256(canonical) !== segment.sourceTextSha256 || segment.endOffset > canonical.length)
        return undefined;
      const text = canonical.slice(segment.startOffset, segment.endOffset);
      return text.length === 0 ? undefined : text;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.getSpeechSegmentText")),
    );

  const expireAndPurge: VoiceNativeThreadTurnStoreShape["expireAndPurge"] = (
    now,
    occurredAt,
    retentionCutoff,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly operationId: string }>`
        SELECT operation_id AS "operationId"
        FROM voice_native_thread_turn_operations
        WHERE expires_at <= ${now} AND active_slot = 1
          AND phase NOT IN ('completed', 'failed', 'cancelled')`;
      const expired: Array<VoiceNativeThreadTurnOperationId> = [];
      for (const row of rows) {
        const operationId = VoiceNativeThreadTurnOperationId.make(row.operationId);
        const finalized = yield* finalize({
          operationId,
          occurredAt,
          outcome: "failed",
          speechOutcome: "failed",
          failureCode: "operation-expired",
          retryable: false,
        });
        if (finalized) expired.push(operationId);
      }
      yield* sql`DELETE FROM voice_native_thread_turn_operations
        WHERE active_slot IS NULL AND expires_at < ${retentionCutoff}`;
      return expired;
    }).pipe(Effect.mapError(toPersistenceSqlError("VoiceNativeThreadTurnStore.expireAndPurge")));

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
    beginDispatch,
    acceptDispatch,
    releaseProcessing,
    appendEvent,
    finalize,
    listEvents,
    acknowledge,
    putSpeechSegmentAndEvent,
    resolveAssistantRevision,
    getSpeechSegment,
    getSpeechSegmentText,
    cancel,
    expireAndPurge,
    revokeRuntime,
    revokeAuthSession,
  });
});

export const VoiceNativeThreadTurnStoreLive = Layer.effect(VoiceNativeThreadTurnStore, make);

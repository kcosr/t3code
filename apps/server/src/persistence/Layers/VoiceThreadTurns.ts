import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceDraftArtifactId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceThreadTurnEvent,
  VoiceThreadTurnOperationId,
  VoiceSpeechPlanId,
  VoiceTurnClientOperationId,
  type VoiceThreadTurnPhase,
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
  VoiceThreadTurnStore,
  type PersistedVoiceThreadTurn,
  type VoiceThreadTurnAssistantMessageRecord,
  type VoiceThreadTurnDraftRecord,
  type VoiceThreadTurnEventWithoutSequence,
  type VoiceThreadTurnStoreShape,
} from "../Services/VoiceThreadTurns.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(VoiceThreadTurnEvent));
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceThreadTurnEvent));
const decodeAssistantEventPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.optionalKey(Schema.String),
      streaming: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
const terminalPhase = (phase: VoiceThreadTurnPhase | "draft-ready") =>
  phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "draft-ready";
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
interface AssistantEventRow {
  readonly sequence: number;
  readonly payloadJson: string;
}
interface SpeechSegmentRow {
  readonly operationId: string;
  readonly segmentIndex: number;
  readonly assistantMessageId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly finalSegment: number;
  readonly sourceEventSequence: number;
  readonly sourceTextSha256: string;
  readonly createdAt: string;
}
const mapSpeechSegment = (row: SpeechSegmentRow) => ({
  operationId: VoiceThreadTurnOperationId.make(row.operationId),
  segmentIndex: row.segmentIndex,
  assistantMessageId: MessageId.make(row.assistantMessageId),
  startOffset: row.startOffset,
  endOffset: row.endOffset,
  finalSegment: row.finalSegment === 1,
  sourceEventSequence: row.sourceEventSequence,
  sourceTextSha256: row.sourceTextSha256,
  createdAt: row.createdAt,
});
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
  readonly runtimeInstanceId: string;
  readonly runtimeGeneration: number;
  readonly modeSessionId: string;
  readonly turnClientOperationId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly speechPreset: VoiceSpeechPreset;
  readonly speechEnabled: number;
  readonly autoRearm: number;
  readonly submissionPolicy: "auto-submit" | "draft";
  readonly speechPlanId: string;
  readonly phase: VoiceThreadTurnPhase | "draft-ready";
  readonly processingLeaseUntil: number | null;
  readonly processingLeaseToken: string | null;
  readonly processingAttempt: number;
  readonly commandId: string | null;
  readonly messageId: string | null;
  readonly turnId: string | null;
  readonly lastSequence: number;
  readonly acknowledgedSequence: number;
  readonly speechTerminal: "completed" | "no-speech" | "failed" | null;
  readonly highestStartedSegment: number | null;
  readonly highestDrainedSegment: number | null;
  readonly dispatchAccepted: number;
  readonly detachedAt: string | null;
  readonly operationTokenExpiresAt: number;
  readonly retentionExpiresAt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const operationColumns = `
  operation_id AS "operationId", auth_session_id AS "authSessionId",
  runtime_id AS "runtimeId", runtime_generation AS "runtimeGeneration",
  runtime_instance_id AS "runtimeInstanceId",
  mode_session_id AS "modeSessionId", turn_client_operation_id AS "turnClientOperationId",
  project_id AS "projectId",
  thread_id AS "threadId", speech_preset AS "speechPreset",
  speech_enabled AS "speechEnabled", auto_rearm AS "autoRearm",
  submission_policy AS "submissionPolicy", speech_plan_id AS "speechPlanId",
  phase, processing_lease_until AS "processingLeaseUntil",
  processing_lease_token AS "processingLeaseToken",
  processing_attempt AS "processingAttempt", command_id AS "commandId",
  message_id AS "messageId", turn_id AS "turnId", last_sequence AS "lastSequence",
  acknowledged_sequence AS "acknowledgedSequence", speech_terminal AS "speechTerminal",
  highest_started_segment AS "highestStartedSegment",
  highest_drained_segment AS "highestDrainedSegment",
  dispatch_accepted AS "dispatchAccepted", detached_at AS "detachedAt",
  operation_token_expires_at AS "operationTokenExpiresAt",
  retention_expires_at AS "retentionExpiresAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const qualifiedOperationColumns = `
  operation.operation_id AS "operationId", operation.auth_session_id AS "authSessionId",
  operation.runtime_id AS "runtimeId", operation.runtime_generation AS "runtimeGeneration",
  operation.runtime_instance_id AS "runtimeInstanceId",
  operation.mode_session_id AS "modeSessionId",
  operation.turn_client_operation_id AS "turnClientOperationId",
  operation.project_id AS "projectId",
  operation.thread_id AS "threadId", operation.speech_preset AS "speechPreset",
  operation.speech_enabled AS "speechEnabled",
  operation.auto_rearm AS "autoRearm", operation.phase,
  operation.submission_policy AS "submissionPolicy",
  operation.speech_plan_id AS "speechPlanId",
  operation.processing_lease_until AS "processingLeaseUntil",
  operation.processing_lease_token AS "processingLeaseToken",
  operation.processing_attempt AS "processingAttempt", operation.command_id AS "commandId",
  operation.message_id AS "messageId", operation.turn_id AS "turnId",
  operation.last_sequence AS "lastSequence",
  operation.acknowledged_sequence AS "acknowledgedSequence",
  operation.speech_terminal AS "speechTerminal",
  operation.highest_started_segment AS "highestStartedSegment",
  operation.highest_drained_segment AS "highestDrainedSegment",
  operation.dispatch_accepted AS "dispatchAccepted", operation.detached_at AS "detachedAt",
  operation.operation_token_expires_at AS "operationTokenExpiresAt",
  operation.retention_expires_at AS "retentionExpiresAt",
  operation.created_at AS "createdAt", operation.updated_at AS "updatedAt"
`;

const mapOperation = (row: OperationRow): PersistedVoiceThreadTurn => ({
  operationId: VoiceThreadTurnOperationId.make(row.operationId),
  authSessionId: AuthSessionId.make(row.authSessionId),
  runtimeId: VoiceRuntimeId.make(row.runtimeId),
  runtimeInstanceId: VoiceRuntimeInstanceId.make(row.runtimeInstanceId),
  runtimeGeneration: row.runtimeGeneration,
  modeSessionId: VoiceModeSessionId.make(row.modeSessionId),
  turnClientOperationId: VoiceTurnClientOperationId.make(row.turnClientOperationId),
  projectId: ProjectId.make(row.projectId),
  threadId: ThreadId.make(row.threadId),
  speechPreset: row.speechPreset,
  speechEnabled: row.speechEnabled === 1,
  autoRearm: row.autoRearm === 1,
  submissionPolicy: row.submissionPolicy,
  speechPlanId: VoiceSpeechPlanId.make(row.speechPlanId),
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
  highestStartedSegment: row.highestStartedSegment,
  highestDrainedSegment: row.highestDrainedSegment,
  dispatchAccepted: row.dispatchAccepted === 1,
  detachedAt: row.detachedAt,
  operationTokenExpiresAt: row.operationTokenExpiresAt,
  retentionExpiresAt: row.retentionExpiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

interface DraftRow {
  readonly operationId: string;
  readonly draftId: string;
  readonly state: "ready" | "consumed" | "expired";
  readonly cipherVersion: number;
  readonly nonce: Uint8Array | null;
  readonly ciphertext: Uint8Array | null;
  readonly expiresAt: number;
  readonly createdAt: string;
  readonly consumedAt: string | null;
}

const mapDraft = (row: DraftRow): VoiceThreadTurnDraftRecord => ({
  operationId: VoiceThreadTurnOperationId.make(row.operationId),
  draftId: VoiceDraftArtifactId.make(row.draftId),
  state: row.state,
  cipherVersion: row.cipherVersion,
  nonce: row.nonce,
  ciphertext: row.ciphertext,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  consumedAt: row.consumedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get: VoiceThreadTurnStoreShape["get"] = (operationId) =>
    sql
      .unsafe<OperationRow>(
        `SELECT ${operationColumns} FROM voice_thread_turn_operations
       WHERE operation_id = ? LIMIT 1`,
        [operationId],
      )
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : mapOperation(rows[0]))),
        Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.get")),
      );

  const recordAssistantMessages: VoiceThreadTurnStoreShape["recordAssistantMessages"] = (
    operationId,
    messages,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* sql<{
            readonly found: number;
          }>`SELECT 1 AS found
            FROM voice_thread_turn_operations WHERE operation_id = ${operationId}`;
          if (operation.length === 0) return [];
          for (const message of messages) {
            yield* sql`INSERT OR IGNORE INTO voice_thread_turn_assistant_messages (
              operation_id, message_id, first_seen_sequence, created_at
            ) VALUES (
              ${operationId}, ${message.messageId}, ${message.firstSeenSequence},
              ${message.createdAt}
            )`;
          }
          const rows = yield* sql<{
            readonly operationId: string;
            readonly messageId: string;
            readonly firstSeenSequence: number;
            readonly createdAt: string;
          }>`SELECT operation_id AS "operationId", message_id AS "messageId",
              first_seen_sequence AS "firstSeenSequence", created_at AS "createdAt"
            FROM voice_thread_turn_assistant_messages
            WHERE operation_id = ${operationId}
            ORDER BY first_seen_sequence ASC, message_id ASC`;
          return rows.map(
            (row): VoiceThreadTurnAssistantMessageRecord => ({
              operationId: VoiceThreadTurnOperationId.make(row.operationId),
              messageId: MessageId.make(row.messageId),
              firstSeenSequence: row.firstSeenSequence,
              createdAt: row.createdAt,
            }),
          );
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.recordAssistantMessages")));

  const getReceiptCorrelation: VoiceThreadTurnStoreShape["getReceiptCorrelation"] = (operationId) =>
    Effect.gen(function* () {
      const operation = yield* get(operationId);
      if (operation === undefined) return undefined;
      const assistantRows = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM voice_thread_turn_assistant_messages
        WHERE operation_id = ${operationId}
        ORDER BY first_seen_sequence ASC, message_id ASC`;
      const segmentRows = yield* sql<{
        readonly highestAdvertisedSegment: number | null;
      }>`
        SELECT MAX(segment_index) AS "highestAdvertisedSegment"
        FROM voice_thread_turn_speech_segments
        WHERE operation_id = ${operationId}`;
      const dispositionRows = yield* sql<{
        readonly segmentIndex: number;
        readonly disposition: "drained" | "interrupted" | "skipped" | "failed";
      }>`SELECT segment_index AS "segmentIndex", disposition
        FROM voice_thread_turn_speech_dispositions
        WHERE operation_id = ${operationId} ORDER BY segment_index ASC`;
      const terminalOutcome =
        operation.phase === "completed" ||
        operation.phase === "failed" ||
        operation.phase === "cancelled"
          ? operation.phase
          : null;
      return {
        operationId: operation.operationId,
        runtimeId: operation.runtimeId,
        runtimeInstanceId: operation.runtimeInstanceId,
        runtimeGeneration: operation.runtimeGeneration,
        modeSessionId: operation.modeSessionId,
        turnClientOperationId: operation.turnClientOperationId,
        projectId: operation.projectId,
        threadId: operation.threadId,
        userMessageId: operation.messageId,
        turnId: operation.turnId,
        assistantMessageIds: assistantRows.map((row) => MessageId.make(row.messageId)),
        speechPlanId: operation.speechPlanId,
        highestAdvertisedSegment: segmentRows[0]?.highestAdvertisedSegment ?? null,
        highestStartedSegment: operation.highestStartedSegment,
        highestDrainedSegment: operation.highestDrainedSegment,
        segmentDispositions: dispositionRows,
        speechTerminal: operation.speechTerminal,
        terminalOutcome,
        detachedAt: operation.detachedAt,
        createdAt: operation.createdAt,
        retentionExpiresAt: operation.retentionExpiresAt,
      };
    }).pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.getReceiptCorrelation")));

  const readDraft: VoiceThreadTurnStoreShape["readDraft"] = (operationId) =>
    sql<DraftRow>`SELECT operation_id AS "operationId", draft_id AS "draftId", state,
        cipher_version AS "cipherVersion", nonce, ciphertext, expires_at AS "expiresAt",
        created_at AS "createdAt", consumed_at AS "consumedAt"
      FROM voice_thread_turn_drafts WHERE operation_id = ${operationId} LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : mapDraft(rows[0]))),
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.readDraft")),
    );

  const completeDraft: VoiceThreadTurnStoreShape["completeDraft"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* readDraft(input.operationId);
          if (existing !== undefined) {
            if (existing.draftId !== input.draftId) return "invalid" as const;
            return existing.state === "ready" ? ("existing" as const) : ("terminal" as const);
          }
          const eligible = yield* sql<{
            readonly found: number;
          }>`SELECT 1 AS found
            FROM voice_thread_turn_operations
            WHERE operation_id = ${input.operationId}
              AND token_hash = ${input.tokenHash}
              AND submission_policy = 'draft' AND dispatch_accepted = 0
              AND active_slot = 1 AND processing_lease_token = ${input.leaseToken}
              AND phase = 'transcribing' LIMIT 1`;
          if (eligible.length === 0) return "invalid" as const;
          yield* sql`INSERT INTO voice_thread_turn_drafts (
            operation_id, draft_id, state, cipher_version, nonce, ciphertext,
            expires_at, created_at
          ) VALUES (
            ${input.operationId}, ${input.draftId}, 'ready', ${input.cipherVersion},
            ${input.nonce}, ${input.ciphertext}, ${input.expiresAt}, ${input.occurredAt}
          )`;
          yield* sql`UPDATE voice_thread_turn_operations SET
            phase = 'draft-ready', active_slot = NULL,
            processing_lease_until = NULL, processing_lease_token = NULL,
            updated_at = ${input.occurredAt}
            WHERE operation_id = ${input.operationId}`;
          return "completed" as const;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.completeDraft")));

  const readDraftAuthorized: VoiceThreadTurnStoreShape["readDraftAuthorized"] = (
    operationId,
    tokenHash,
    now,
    occurredAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
          const authorized = yield* sql<{ readonly found: number }>`SELECT 1 AS found
            FROM voice_thread_turn_operations AS operation
            INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
            WHERE operation.operation_id = ${operationId}
              AND operation.token_hash = ${tokenHash}
              AND operation.retention_expires_at > ${now}
              AND auth.revoked_at IS NULL AND auth.expires_at > ${nowIso}
            LIMIT 1`;
          if (authorized.length === 0) return { status: "revoked" as const };
          const rows = yield* sql<DraftRow>`SELECT operation_id AS "operationId",
              draft_id AS "draftId", state, cipher_version AS "cipherVersion", nonce,
              ciphertext, expires_at AS "expiresAt", created_at AS "createdAt",
              consumed_at AS "consumedAt"
            FROM voice_thread_turn_drafts WHERE operation_id = ${operationId} LIMIT 1`;
          const row = rows[0];
          if (row === undefined || row.state !== "ready") return { status: "unavailable" as const };
          if (row.expiresAt <= now) {
            yield* sql`UPDATE voice_thread_turn_drafts SET
              state = 'expired', nonce = NULL, ciphertext = NULL
              WHERE operation_id = ${operationId} AND state = 'ready'
                AND expires_at <= ${now}`;
            yield* sql`UPDATE voice_thread_turn_operations SET updated_at = ${occurredAt}
              WHERE operation_id = ${operationId}`;
            return { status: "unavailable" as const };
          }
          return { status: "ready" as const, draft: mapDraft(row) };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.readDraftAuthorized")));

  const consumeDraft: VoiceThreadTurnStoreShape["consumeDraft"] = (
    operationId,
    draftId,
    tokenHash,
    now,
    consumedAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
          const authorized = yield* sql<{ readonly found: number }>`SELECT 1 AS found
            FROM voice_thread_turn_operations AS operation
            INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
            WHERE operation.operation_id = ${operationId}
              AND operation.token_hash = ${tokenHash}
              AND operation.retention_expires_at > ${now}
              AND auth.revoked_at IS NULL AND auth.expires_at > ${nowIso}
            LIMIT 1`;
          if (authorized.length === 0) return "revoked" as const;
          const rows = yield* sql<DraftRow>`SELECT operation_id AS "operationId",
              draft_id AS "draftId", state, cipher_version AS "cipherVersion", nonce,
              ciphertext, expires_at AS "expiresAt", created_at AS "createdAt",
              consumed_at AS "consumedAt"
            FROM voice_thread_turn_drafts
            WHERE operation_id = ${operationId} AND draft_id = ${draftId} LIMIT 1`;
          const draft = rows[0] === undefined ? undefined : mapDraft(rows[0]);
          if (draft === undefined) return "not-found" as const;
          if (draft.state === "consumed") return "already-consumed" as const;
          if (draft.state === "expired") return "expired" as const;
          if (draft.expiresAt <= now) {
            yield* sql`UPDATE voice_thread_turn_drafts SET
              state = 'expired', nonce = NULL, ciphertext = NULL
              WHERE operation_id = ${operationId} AND draft_id = ${draftId}
                AND state = 'ready'`;
            return "expired" as const;
          }
          yield* sql`UPDATE voice_thread_turn_drafts SET
            state = 'consumed', nonce = NULL, ciphertext = NULL, consumed_at = ${consumedAt}
            WHERE operation_id = ${operationId} AND draft_id = ${draftId} AND state = 'ready'
              AND expires_at > ${now}`;
          const changed = yield* sql<{
            readonly changed: number;
          }>`SELECT changes() AS changed`;
          if (changed[0]?.changed !== 1) return "expired" as const;
          return "consumed" as const;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.consumeDraft")));

  const expireDrafts: VoiceThreadTurnStoreShape["expireDrafts"] = (now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly operationId: string }>`
            SELECT operation_id AS "operationId" FROM voice_thread_turn_drafts
            WHERE state = 'ready' AND expires_at <= ${now}
            ORDER BY operation_id ASC`;
          yield* sql`UPDATE voice_thread_turn_drafts SET
            state = 'expired', nonce = NULL, ciphertext = NULL
            WHERE state = 'ready' AND expires_at <= ${now}`;
          return rows.map((row) => VoiceThreadTurnOperationId.make(row.operationId));
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.expireDrafts")));

  const detach: VoiceThreadTurnStoreShape["detach"] = (operationId, tokenHash, now, detachedAt) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_thread_turn_operations
            SET detached_at = COALESCE(detached_at, ${detachedAt}), updated_at = ${detachedAt}
            WHERE operation_id = ${operationId} AND token_hash = ${tokenHash}
              AND retention_expires_at > ${now}
              AND (operation_token_expires_at > ${now}
                OR phase IN ('completed', 'failed', 'cancelled', 'draft-ready'))
              AND EXISTS (
                SELECT 1 FROM auth_sessions AS auth
                WHERE auth.session_id = voice_thread_turn_operations.auth_session_id
                  AND auth.revoked_at IS NULL
                  AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
              )`;
          const changed = yield* sql<{
            readonly changed: number;
          }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1 ? ("detached" as const) : ("revoked" as const);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.detach")));

  const detachInternal: VoiceThreadTurnStoreShape["detachInternal"] = (operationId, detachedAt) =>
    sql`UPDATE voice_thread_turn_operations
      SET detached_at = COALESCE(detached_at, ${detachedAt}), updated_at = ${detachedAt}
      WHERE operation_id = ${operationId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.detachInternal")),
    );

  const claim: VoiceThreadTurnStoreShape["claim"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const nowIso = DateTime.formatIso(DateTime.makeUnsafe(input.nowEpochMillis));
          const authority = yield* sql<{
            readonly found: number;
          }>`SELECT 1 AS found
            FROM voice_runtime_authorities AS runtime
            INNER JOIN auth_sessions AS auth ON auth.session_id = runtime.auth_session_id
            WHERE runtime.auth_session_id = ${input.authSessionId}
              AND runtime.runtime_id = ${input.runtimeId}
              AND runtime.generation = ${input.runtimeGeneration}
              AND auth.revoked_at IS NULL AND auth.expires_at > ${nowIso}
            LIMIT 1`;
          if (authority.length === 0) return { status: "revoked" as const };
          const existing = yield* sql.unsafe<OperationRow>(
            `SELECT ${operationColumns} FROM voice_thread_turn_operations
           WHERE operation_id = ? OR (
             auth_session_id = ? AND runtime_id = ? AND runtime_generation = ?
             AND mode_session_id = ? AND turn_client_operation_id = ?
           ) LIMIT 1`,
            [
              input.operationId,
              input.authSessionId,
              input.runtimeId,
              input.runtimeGeneration,
              input.modeSessionId,
              input.turnClientOperationId,
            ],
          );
          if (existing[0] !== undefined) {
            const prior = mapOperation(existing[0]);
            if (prior.operationTokenExpiresAt <= input.nowEpochMillis)
              return { status: "expired" as const, operation: prior };
            if (
              prior.operationId !== input.operationId ||
              prior.runtimeInstanceId !== input.runtimeInstanceId ||
              prior.modeSessionId !== input.modeSessionId ||
              prior.turnClientOperationId !== input.turnClientOperationId ||
              prior.projectId !== input.projectId ||
              prior.threadId !== input.threadId ||
              prior.speechPreset !== input.speechPreset ||
              prior.speechEnabled !== input.speechEnabled ||
              prior.autoRearm !== input.autoRearm ||
              prior.submissionPolicy !== input.submissionPolicy ||
              prior.speechPlanId !== input.speechPlanId
            )
              return { status: "mismatch" as const, operation: prior };
            yield* sql`UPDATE voice_thread_turn_operations
            SET token_hash = ${input.tokenHash},
                operation_token_expires_at = ${input.operationTokenExpiresAt},
                retention_expires_at = MAX(retention_expires_at, ${input.retentionExpiresAt}),
                updated_at = ${input.now}
            WHERE operation_id = ${existing[0].operationId}`;
            return {
              status: "claimed" as const,
              operation: mapOperation({
                ...existing[0],
                operationTokenExpiresAt: input.operationTokenExpiresAt,
                retentionExpiresAt: Math.max(
                  existing[0].retentionExpiresAt,
                  input.retentionExpiresAt,
                ),
                updatedAt: input.now,
              }),
            };
          }
          const expired = yield* sql<{
            readonly operationId: string;
            readonly lastSequence: number;
          }>`SELECT operation_id AS "operationId", last_sequence AS "lastSequence"
            FROM voice_thread_turn_operations
            WHERE auth_session_id = ${input.authSessionId}
              AND runtime_id = ${input.runtimeId}
              AND runtime_generation = ${input.runtimeGeneration}
              AND operation_token_expires_at <= ${input.nowEpochMillis} AND active_slot = 1
              AND dispatch_accepted = 0 AND phase <> 'dispatching'`;
          for (const prior of expired) {
            const events: ReadonlyArray<VoiceThreadTurnEventWithoutSequence> = [
              {
                type: "failure",
                occurredAt: nowIso,
                code: "operation-expired",
                retryable: false,
              },
              {
                type: "speech-terminal",
                occurredAt: nowIso,
                outcome: "failed",
              },
              { type: "terminal", occurredAt: nowIso, outcome: "failed" },
            ];
            let sequence = prior.lastSequence;
            for (const event of events) {
              sequence += 1;
              const persisted = {
                ...event,
                sequence,
              } as VoiceThreadTurnEvent;
              yield* sql`INSERT INTO voice_thread_turn_events
                (operation_id, sequence, event_json, occurred_at)
                VALUES (${prior.operationId}, ${sequence}, ${encodeEvent(persisted)}, ${nowIso})`;
            }
            yield* sql`UPDATE voice_thread_turn_operations SET
              phase = 'failed', speech_terminal = 'failed', last_sequence = ${sequence},
              active_slot = NULL, processing_lease_until = NULL,
              processing_lease_token = NULL, updated_at = ${nowIso}
              WHERE operation_id = ${prior.operationId} AND active_slot = 1`;
          }
          yield* sql`INSERT INTO voice_thread_turn_operations (
          operation_id, auth_session_id, runtime_id, runtime_instance_id, runtime_generation, mode_session_id,
          turn_client_operation_id,
          project_id, thread_id, speech_preset, speech_enabled, auto_rearm, token_hash, phase, active_slot,
          submission_policy, speech_plan_id, operation_token_expires_at, retention_expires_at,
          created_at, updated_at, last_sequence
        ) VALUES (
          ${input.operationId}, ${input.authSessionId}, ${input.runtimeId}, ${input.runtimeInstanceId},
          ${input.runtimeGeneration}, ${input.modeSessionId}, ${input.turnClientOperationId},
          ${input.projectId},
          ${input.threadId}, ${input.speechPreset}, ${input.speechEnabled ? 1 : 0},
          ${input.autoRearm ? 1 : 0},
          ${input.tokenHash}, 'created', 1, ${input.submissionPolicy}, ${input.speechPlanId},
          ${input.operationTokenExpiresAt}, ${input.retentionExpiresAt},
          ${input.now}, ${input.now}, 1
        )`;
          const event = {
            type: "phase" as const,
            sequence: 1,
            occurredAt: input.now,
            phase: "created" as const,
          };
          yield* sql`INSERT INTO voice_thread_turn_events (
          operation_id, sequence, event_json, occurred_at
        ) VALUES (${input.operationId}, 1, ${encodeEvent(event)}, ${input.now})`;
          return {
            status: "claimed" as const,
            operation: {
              operationId: input.operationId,
              authSessionId: input.authSessionId,
              runtimeId: input.runtimeId,
              runtimeInstanceId: input.runtimeInstanceId,
              runtimeGeneration: input.runtimeGeneration,
              modeSessionId: input.modeSessionId,
              turnClientOperationId: input.turnClientOperationId,
              projectId: input.projectId,
              threadId: input.threadId,
              speechPreset: input.speechPreset,
              speechEnabled: input.speechEnabled,
              autoRearm: input.autoRearm,
              submissionPolicy: input.submissionPolicy,
              speechPlanId: input.speechPlanId,
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
              highestStartedSegment: null,
              highestDrainedSegment: null,
              dispatchAccepted: false,
              detachedAt: null,
              operationTokenExpiresAt: input.operationTokenExpiresAt,
              retentionExpiresAt: input.retentionExpiresAt,
              createdAt: input.now,
              updatedAt: input.now,
            },
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.claim")));

  const authorize: VoiceThreadTurnStoreShape["authorize"] = (operationId, tokenHash, now) => {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
    return sql
      .unsafe<OperationRow>(
        `SELECT ${qualifiedOperationColumns}
       FROM voice_thread_turn_operations AS operation
       INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
       INNER JOIN voice_runtime_authorities AS runtime
         ON runtime.auth_session_id = operation.auth_session_id
         AND runtime.runtime_id = operation.runtime_id
         AND runtime.generation = operation.runtime_generation
       WHERE operation.operation_id = ? AND operation.token_hash = ?
         AND operation.retention_expires_at > ?
         AND (operation.operation_token_expires_at > ?
           OR operation.phase IN ('completed', 'failed', 'cancelled', 'draft-ready'))
         AND auth.revoked_at IS NULL AND auth.expires_at > ?
       LIMIT 1`,
        [operationId, tokenHash, now, now, nowIso],
      )
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : mapOperation(rows[0]))),
        Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.authorize")),
      );
  };

  const claimProcessing: VoiceThreadTurnStoreShape["claimProcessing"] = (
    operationId,
    tokenHash,
    leaseToken,
    now,
    leaseUntil,
    updatedAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_thread_turn_operations
          SET processing_lease_until = ${leaseUntil}, processing_lease_token = ${leaseToken},
              processing_attempt = processing_attempt + 1,
              updated_at = ${updatedAt}
          WHERE operation_id = ${operationId} AND token_hash = ${tokenHash}
            AND dispatch_accepted = 0
            AND active_slot = 1 AND operation_token_expires_at > ${now}
            AND phase NOT IN ('completed', 'failed', 'cancelled')
            AND (processing_lease_until IS NULL OR processing_lease_until <= ${now})
            AND EXISTS (
              SELECT 1 FROM auth_sessions AS auth
              WHERE auth.session_id = voice_thread_turn_operations.auth_session_id
                AND auth.revoked_at IS NULL
                AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
            )`;
          const changed = yield* sql<{
            readonly changed: number;
          }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.claimProcessing")));

  const setDraftDisposition: VoiceThreadTurnStoreShape["setDraftDisposition"] = (
    operationId,
    tokenHash,
    now,
    updatedAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly submissionPolicy: "auto-submit" | "draft";
            readonly phase: VoiceThreadTurnPhase | "draft-ready";
            readonly processingAttempt: number;
            readonly processingLeaseToken: string | null;
            readonly dispatchAccepted: number;
            readonly detachedAt: string | null;
          }>`SELECT operation.submission_policy AS "submissionPolicy", operation.phase,
              operation.processing_attempt AS "processingAttempt",
              operation.processing_lease_token AS "processingLeaseToken",
              operation.dispatch_accepted AS "dispatchAccepted",
              operation.detached_at AS "detachedAt"
            FROM voice_thread_turn_operations AS operation
            INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
            WHERE operation.operation_id = ${operationId}
              AND operation.token_hash = ${tokenHash}
              AND operation.operation_token_expires_at > ${now}
              AND operation.retention_expires_at > ${now}
              AND auth.revoked_at IS NULL
              AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
            LIMIT 1`;
          const operation = rows[0];
          if (operation === undefined) return "revoked" as const;
          if (
            operation.phase !== "created" ||
            operation.processingAttempt !== 0 ||
            operation.processingLeaseToken !== null ||
            operation.dispatchAccepted === 1 ||
            operation.detachedAt !== null
          )
            return "invalid" as const;
          if (operation.submissionPolicy === "draft") return "unchanged" as const;
          yield* sql`UPDATE voice_thread_turn_operations
            SET submission_policy = 'draft', updated_at = ${updatedAt}
            WHERE operation_id = ${operationId} AND token_hash = ${tokenHash}
              AND phase = 'created' AND submission_policy = 'auto-submit'
              AND processing_attempt = 0 AND processing_lease_token IS NULL
              AND dispatch_accepted = 0 AND detached_at IS NULL`;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return changed[0]?.changed === 1 ? ("updated" as const) : ("invalid" as const);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.setDraftDisposition")));

  const beginDispatch: VoiceThreadTurnStoreShape["beginDispatch"] = (
    operationId,
    tokenHash,
    leaseToken,
    now,
    occurredAt,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE voice_thread_turn_operations
          SET phase = 'dispatching', updated_at = ${occurredAt}
          WHERE operation_id = ${operationId} AND token_hash = ${tokenHash}
            AND phase = 'transcribing'
            AND submission_policy = 'auto-submit'
            AND active_slot = 1 AND operation_token_expires_at > ${now}
            AND processing_lease_token = ${leaseToken}
            AND NOT EXISTS (
              SELECT 1 FROM voice_thread_turn_drafts AS draft
              WHERE draft.operation_id = voice_thread_turn_operations.operation_id
            )
            AND EXISTS (
              SELECT 1 FROM auth_sessions AS auth
              WHERE auth.session_id = voice_thread_turn_operations.auth_session_id
                AND auth.revoked_at IS NULL
                AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
            )`;
          const changed = yield* sql<{
            readonly changed: number;
          }>`SELECT changes() AS changed`;
          if (changed[0]?.changed !== 1) return false;
          const row = yield* sql<{ readonly lastSequence: number }>`
            SELECT last_sequence AS "lastSequence"
            FROM voice_thread_turn_operations WHERE operation_id = ${operationId}`;
          const sequence = (row[0]?.lastSequence ?? 0) + 1;
          const event = {
            type: "phase" as const,
            sequence,
            occurredAt,
            phase: "dispatching" as const,
          };
          yield* sql`INSERT INTO voice_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(event)}, ${occurredAt})`;
          yield* sql`UPDATE voice_thread_turn_operations
            SET last_sequence = ${sequence} WHERE operation_id = ${operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.beginDispatch")));

  const acceptDispatch: VoiceThreadTurnStoreShape["acceptDispatch"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* sql<{ readonly lastSequence: number }>`
            SELECT last_sequence AS "lastSequence"
            FROM voice_thread_turn_operations
            WHERE operation_id = ${input.operationId} AND token_hash = ${input.tokenHash}
              AND phase = 'dispatching'
              AND submission_policy = 'auto-submit'
              AND active_slot = 1 AND processing_lease_token = ${input.leaseToken}
              AND NOT EXISTS (
                SELECT 1 FROM voice_thread_turn_drafts AS draft
                WHERE draft.operation_id = voice_thread_turn_operations.operation_id
              )`;
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
          yield* sql`INSERT INTO voice_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${input.operationId}, ${sequence}, ${encodeEvent(event)}, ${input.occurredAt})`;
          yield* sql`UPDATE voice_thread_turn_operations SET
            phase = 'waiting', command_id = ${input.commandId}, message_id = ${input.messageId},
            dispatch_accepted = 1, processing_lease_until = NULL,
            processing_lease_token = NULL, last_sequence = ${sequence}, updated_at = ${input.occurredAt}
            WHERE operation_id = ${input.operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.acceptDispatch")));

  const releaseProcessing: VoiceThreadTurnStoreShape["releaseProcessing"] = (
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
            FROM voice_thread_turn_operations
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
          yield* sql`INSERT INTO voice_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(event)}, ${occurredAt})`;
          yield* sql`UPDATE voice_thread_turn_operations SET
            phase = 'created', processing_lease_until = NULL, processing_lease_token = NULL,
            last_sequence = ${sequence}, updated_at = ${occurredAt}
            WHERE operation_id = ${operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.releaseProcessing")));

  const appendEvent: VoiceThreadTurnStoreShape["appendEvent"] = (
    operationId,
    event,
    updates = {},
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly lastSequence: number;
            readonly phase: VoiceThreadTurnPhase;
          }>`SELECT last_sequence AS "lastSequence", phase
            FROM voice_thread_turn_operations
            WHERE operation_id = ${operationId} LIMIT 1`;
          if (rows[0] === undefined || terminalPhase(rows[0].phase)) return undefined;
          const sequence = rows[0].lastSequence + 1;
          const persisted = {
            ...event,
            sequence,
          } as VoiceThreadTurnEvent;
          yield* sql`INSERT INTO voice_thread_turn_events (
          operation_id, sequence, event_json, occurred_at
        ) VALUES (${operationId}, ${sequence}, ${encodeEvent(persisted)}, ${event.occurredAt})`;
          yield* sql`UPDATE voice_thread_turn_operations SET
          last_sequence = ${sequence}, updated_at = ${event.occurredAt}
          WHERE operation_id = ${operationId}`;
          if (updates.phase !== undefined)
            yield* sql`UPDATE voice_thread_turn_operations SET phase = ${updates.phase}
            WHERE operation_id = ${operationId}`;
          if (updates.turnId !== undefined)
            yield* sql`UPDATE voice_thread_turn_operations SET turn_id = ${updates.turnId}
            WHERE operation_id = ${operationId}`;
          return persisted;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.appendEvent")));

  const finalize: VoiceThreadTurnStoreShape["finalize"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly lastSequence: number;
            readonly phase: VoiceThreadTurnPhase;
            readonly processingLeaseToken: string | null;
          }>`SELECT last_sequence AS "lastSequence", phase,
              processing_lease_token AS "processingLeaseToken"
            FROM voice_thread_turn_operations
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
          const events: Array<VoiceThreadTurnEventWithoutSequence> = [];
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
            events.push({
              type: "phase",
              occurredAt: input.occurredAt,
              phase: "completed",
            });
          events.push({
            type: "terminal",
            occurredAt: input.occurredAt,
            outcome: input.outcome,
          });
          for (const event of events) {
            sequence += 1;
            const persisted = {
              ...event,
              sequence,
            } as VoiceThreadTurnEvent;
            yield* sql`INSERT INTO voice_thread_turn_events
              (operation_id, sequence, event_json, occurred_at)
              VALUES (${input.operationId}, ${sequence}, ${encodeEvent(persisted)}, ${input.occurredAt})`;
          }
          const phase = input.outcome === "cancelled" ? "cancelled" : input.outcome;
          yield* sql`UPDATE voice_thread_turn_operations SET
            phase = ${phase}, speech_terminal = ${input.speechOutcome ?? null},
            last_sequence = ${sequence}, active_slot = NULL,
            processing_lease_until = NULL, processing_lease_token = NULL,
            updated_at = ${input.occurredAt}
            WHERE operation_id = ${input.operationId}`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.finalize")));

  const cancel: VoiceThreadTurnStoreShape["cancel"] = (operationId, tokenHash, occurredAt, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly lastSequence: number;
            readonly phase: VoiceThreadTurnPhase;
            readonly dispatchAccepted: number;
          }>`SELECT last_sequence AS "lastSequence", phase,
              dispatch_accepted AS "dispatchAccepted"
            FROM voice_thread_turn_operations
            WHERE operation_id = ${operationId} AND token_hash = ${tokenHash}
              AND operation_token_expires_at > ${now}
              AND EXISTS (
                SELECT 1 FROM auth_sessions AS auth
                WHERE auth.session_id = voice_thread_turn_operations.auth_session_id
                  AND auth.revoked_at IS NULL
                  AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
              ) LIMIT 1`;
          const row = rows[0];
          if (row === undefined) return "revoked" as const;
          if (terminalPhase(row.phase)) return "terminal" as const;
          if (row.dispatchAccepted === 1 || row.phase === "dispatching")
            return "dispatch-committed" as const;
          let sequence = row.lastSequence + 1;
          const phaseEvent = {
            type: "phase" as const,
            sequence,
            occurredAt,
            phase: "cancelled" as const,
          };
          yield* sql`INSERT INTO voice_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(phaseEvent)}, ${occurredAt})`;
          sequence += 1;
          const terminalEvent = {
            type: "terminal" as const,
            sequence,
            occurredAt,
            outcome: "cancelled" as const,
          };
          yield* sql`INSERT INTO voice_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${operationId}, ${sequence}, ${encodeEvent(terminalEvent)}, ${occurredAt})`;
          yield* sql`UPDATE voice_thread_turn_operations SET
            phase = 'cancelled', last_sequence = ${sequence}, active_slot = NULL,
            processing_lease_until = NULL, processing_lease_token = NULL,
            updated_at = ${occurredAt} WHERE operation_id = ${operationId}`;
          return "cancelled" as const;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.cancel")));

  const listEvents: VoiceThreadTurnStoreShape["listEvents"] = (operationId, afterSequence, limit) =>
    sql<{
      readonly eventJson: string;
    }>`SELECT event_json AS "eventJson" FROM voice_thread_turn_events
      WHERE operation_id = ${operationId} AND sequence > ${afterSequence}
      ORDER BY sequence ASC LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map((row) => decodeEvent(row.eventJson))),
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.listEvents")),
    );

  const readEventPage: VoiceThreadTurnStoreShape["readEventPage"] = (
    operationId,
    tokenHash,
    now,
    afterSequence,
    limit,
  ) => {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const operations = yield* sql.unsafe<OperationRow>(
            `SELECT ${qualifiedOperationColumns}
             FROM voice_thread_turn_operations AS operation
             INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
             WHERE operation.operation_id = ? AND operation.token_hash = ?
               AND operation.retention_expires_at > ?
               AND (operation.operation_token_expires_at > ?
                 OR operation.phase IN ('completed', 'failed', 'cancelled', 'draft-ready'))
               AND auth.revoked_at IS NULL
               AND auth.expires_at > ? LIMIT 1`,
            [operationId, tokenHash, now, now, nowIso],
          );
          if (operations[0] === undefined) return undefined;
          const events = yield* sql<{
            readonly eventJson: string;
          }>`SELECT event_json AS "eventJson" FROM voice_thread_turn_events
            WHERE operation_id = ${operationId} AND sequence > ${afterSequence}
            ORDER BY sequence ASC LIMIT ${limit}`;
          return {
            operation: mapOperation(operations[0]),
            events: events.map((row) => decodeEvent(row.eventJson)),
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.readEventPage")));
  };

  const acknowledge: VoiceThreadTurnStoreShape["acknowledge"] = (
    operationId,
    tokenHash,
    input,
    now,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operationRows = yield* sql<{
            readonly speechPlanId: string;
            readonly lastSequence: number;
            readonly highestStartedSegment: number | null;
            readonly highestDrainedSegment: number | null;
          }>`SELECT operation.speech_plan_id AS "speechPlanId",
              operation.last_sequence AS "lastSequence",
              operation.highest_started_segment AS "highestStartedSegment",
              operation.highest_drained_segment AS "highestDrainedSegment"
            FROM voice_thread_turn_operations AS operation
            INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
            WHERE operation.operation_id = ${operationId}
              AND operation.token_hash = ${tokenHash}
              AND operation.retention_expires_at > ${now}
              AND (operation.operation_token_expires_at > ${now}
                OR operation.phase IN ('completed', 'failed', 'cancelled', 'draft-ready'))
              AND auth.revoked_at IS NULL
              AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}`;
          const operation = operationRows[0];
          if (operation === undefined) return "revoked" as const;
          const advertisedRows = yield* sql<{ readonly segmentIndex: number }>`
            SELECT segment_index AS "segmentIndex"
            FROM voice_thread_turn_speech_segments
            WHERE operation_id = ${operationId} ORDER BY segment_index ASC`;
          const advertised = new Set(advertisedRows.map((row) => row.segmentIndex));
          const existingRows = yield* sql<{
            readonly segmentIndex: number;
            readonly disposition: "drained" | "interrupted" | "skipped" | "failed";
          }>`SELECT segment_index AS "segmentIndex", disposition
            FROM voice_thread_turn_speech_dispositions
            WHERE operation_id = ${operationId} ORDER BY segment_index ASC`;
          const dispositions = new Map(
            existingRows.map((row) => [row.segmentIndex, row.disposition] as const),
          );
          for (const item of input.segmentDispositions) {
            const existing = dispositions.get(item.segmentIndex);
            if (existing !== undefined && existing !== item.disposition) return "invalid" as const;
            dispositions.set(item.segmentIndex, item.disposition);
          }
          const drained = [...dispositions.entries()]
            .filter(([, disposition]) => disposition === "drained")
            .map(([segmentIndex]) => segmentIndex);
          const maximumDrained = drained.length === 0 ? null : Math.max(...drained);
          const startedRangeIsAdvertised =
            input.highestStartedSegment === null ||
            Array.from({ length: input.highestStartedSegment + 1 }, (_, index) => index).every(
              (index) => advertised.has(index),
            );
          const priorSegmentsAreTerminal =
            input.highestStartedSegment === null ||
            Array.from({ length: input.highestStartedSegment }, (_, index) => index).every(
              (index) => dispositions.has(index),
            );
          const invalidProgress =
            operation.speechPlanId !== input.speechPlanId ||
            new Set(input.segmentDispositions.map((item) => item.segmentIndex)).size !==
              input.segmentDispositions.length ||
            input.acknowledgedSequence > operation.lastSequence ||
            !startedRangeIsAdvertised ||
            !priorSegmentsAreTerminal ||
            maximumDrained !== input.highestDrainedSegment ||
            (input.highestDrainedSegment !== null &&
              (input.highestStartedSegment === null ||
                input.highestDrainedSegment > input.highestStartedSegment)) ||
            (operation.highestStartedSegment !== null &&
              (input.highestStartedSegment === null ||
                input.highestStartedSegment < operation.highestStartedSegment)) ||
            (operation.highestDrainedSegment !== null &&
              (input.highestDrainedSegment === null ||
                input.highestDrainedSegment < operation.highestDrainedSegment)) ||
            input.segmentDispositions.some(
              (item) =>
                !advertised.has(item.segmentIndex) ||
                input.highestStartedSegment === null ||
                item.segmentIndex > input.highestStartedSegment,
            );
          if (invalidProgress) return "invalid" as const;
          yield* sql`UPDATE voice_thread_turn_operations
          SET acknowledged_sequence = MAX(acknowledged_sequence, ${input.acknowledgedSequence}),
              highest_started_segment = ${input.highestStartedSegment},
              highest_drained_segment = ${input.highestDrainedSegment}
          WHERE operation_id = ${operationId} AND token_hash = ${tokenHash}
            AND retention_expires_at > ${now}
            AND (operation_token_expires_at > ${now}
              OR phase IN ('completed', 'failed', 'cancelled', 'draft-ready'))
            AND EXISTS (
              SELECT 1 FROM auth_sessions AS auth
              WHERE auth.session_id = voice_thread_turn_operations.auth_session_id
                AND auth.revoked_at IS NULL
                AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
            )`;
          const changed = yield* sql<{
            readonly changed: number;
          }>`SELECT changes() AS changed`;
          if (changed[0]?.changed === 1) {
            for (const item of input.segmentDispositions)
              yield* sql`INSERT OR IGNORE INTO voice_thread_turn_speech_dispositions (
                operation_id, segment_index, disposition, created_at
              ) VALUES (${operationId}, ${item.segmentIndex}, ${item.disposition}, ${input.occurredAt})`;
            return "acknowledged" as const;
          }
          const authorized = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found FROM voice_thread_turn_operations AS operation
            INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
            WHERE operation.operation_id = ${operationId} AND operation.token_hash = ${tokenHash}
              AND operation.retention_expires_at > ${now}
              AND auth.revoked_at IS NULL
              AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
            LIMIT 1`;
          return authorized[0] === undefined ? ("revoked" as const) : ("invalid" as const);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.acknowledge")));

  const resolveAssistantRevision: VoiceThreadTurnStoreShape["resolveAssistantRevision"] = (
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
        Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.resolveAssistantRevision")),
      );

  const putSpeechSegmentAndEvent: VoiceThreadTurnStoreShape["putSpeechSegmentAndEvent"] = (
    segment,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* sql<{
            readonly phase: VoiceThreadTurnPhase;
            readonly lastSequence: number;
            readonly detachedAt: string | null;
          }>`SELECT phase, last_sequence AS "lastSequence", detached_at AS "detachedAt"
            FROM voice_thread_turn_operations
            WHERE operation_id = ${segment.operationId}`;
          if (operation[0] === undefined || terminalPhase(operation[0].phase))
            return "terminal" as const;
          if (operation[0].detachedAt !== null) return "detached" as const;
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
            FROM voice_thread_turn_speech_segments
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
          yield* sql`INSERT INTO voice_thread_turn_speech_segments (
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
          yield* sql`INSERT INTO voice_thread_turn_events
            (operation_id, sequence, event_json, occurred_at)
            VALUES (${segment.operationId}, ${sequence}, ${encodeEvent(event)}, ${segment.createdAt})`;
          yield* sql`UPDATE voice_thread_turn_operations SET
            phase = 'speaking', last_sequence = ${sequence}, updated_at = ${segment.createdAt}
            WHERE operation_id = ${segment.operationId} AND detached_at IS NULL`;
          return "inserted" as const;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.putSpeechSegmentAndEvent")),
      );

  const getSpeechSegment: VoiceThreadTurnStoreShape["getSpeechSegment"] = (
    operationId,
    segmentIndex,
  ) =>
    sql<SpeechSegmentRow>`SELECT operation_id AS "operationId", segment_index AS "segmentIndex",
      assistant_message_id AS "assistantMessageId", start_offset AS "startOffset",
      end_offset AS "endOffset", final_segment AS "finalSegment",
      source_event_sequence AS "sourceEventSequence",
      source_text_sha256 AS "sourceTextSha256", created_at AS "createdAt"
      FROM voice_thread_turn_speech_segments
      WHERE operation_id = ${operationId} AND segment_index = ${segmentIndex} LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : mapSpeechSegment(rows[0]))),
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.getSpeechSegment")),
    );

  const listSpeechSegments: VoiceThreadTurnStoreShape["listSpeechSegments"] = (operationId) =>
    sql<SpeechSegmentRow>`SELECT operation_id AS "operationId",
      segment_index AS "segmentIndex", assistant_message_id AS "assistantMessageId",
      start_offset AS "startOffset", end_offset AS "endOffset",
      final_segment AS "finalSegment", source_event_sequence AS "sourceEventSequence",
      source_text_sha256 AS "sourceTextSha256", created_at AS "createdAt"
      FROM voice_thread_turn_speech_segments
      WHERE operation_id = ${operationId} ORDER BY segment_index ASC`.pipe(
      Effect.map((rows) => rows.map(mapSpeechSegment)),
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.listSpeechSegments")),
    );

  const getSpeechSegmentAuthorized: VoiceThreadTurnStoreShape["getSpeechSegmentAuthorized"] = (
    operationId,
    segmentIndex,
    tokenHash,
    now,
  ) => {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const operations = yield* sql<{
            readonly detachedAt: string | null;
          }>`SELECT operation.detached_at AS "detachedAt"
              FROM voice_thread_turn_operations AS operation
              INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
              WHERE operation.operation_id = ${operationId}
                AND operation.token_hash = ${tokenHash}
                AND operation.retention_expires_at > ${now}
                AND (operation.operation_token_expires_at > ${now}
                  OR operation.phase IN ('completed', 'failed', 'cancelled'))
                AND auth.revoked_at IS NULL AND auth.expires_at > ${nowIso}
              LIMIT 1`;
          const operation = operations[0];
          if (operation === undefined) return { status: "revoked" as const };
          if (operation.detachedAt !== null) return { status: "detached" as const };
          const segment = yield* getSpeechSegment(operationId, segmentIndex);
          return segment === undefined
            ? { status: "missing" as const }
            : { status: "ready" as const, segment };
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.getSpeechSegmentAuthorized")),
      );
  };

  const getSpeechSegmentText: VoiceThreadTurnStoreShape["getSpeechSegmentText"] = (
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
    }).pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.getSpeechSegmentText")));

  const expireAndPurge: VoiceThreadTurnStoreShape["expireAndPurge"] = (
    now,
    occurredAt,
    retentionCutoff,
  ) =>
    Effect.gen(function* () {
      yield* expireDrafts(now);
      const rows = yield* sql<{ readonly operationId: string }>`
        SELECT operation_id AS "operationId"
        FROM voice_thread_turn_operations
        WHERE operation_token_expires_at <= ${now} AND active_slot = 1
          AND (
            phase <> 'dispatching'
            OR processing_lease_until IS NULL
            OR processing_lease_until <= ${now}
          )
          AND phase NOT IN ('completed', 'failed', 'cancelled')`;
      const expired: Array<VoiceThreadTurnOperationId> = [];
      for (const row of rows) {
        const operationId = VoiceThreadTurnOperationId.make(row.operationId);
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
      yield* sql`DELETE FROM voice_thread_turn_operations
        WHERE active_slot IS NULL AND retention_expires_at < ${retentionCutoff}`;
      return expired;
    }).pipe(Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.expireAndPurge")));

  const listRecoverableOperationIds: VoiceThreadTurnStoreShape["listRecoverableOperationIds"] = (
    now,
  ) =>
    sql<{ readonly operationId: string }>`
        SELECT operation.operation_id AS "operationId"
        FROM voice_thread_turn_operations AS operation
        INNER JOIN auth_sessions AS auth ON auth.session_id = operation.auth_session_id
        WHERE operation.dispatch_accepted = 1
          AND operation.active_slot = 1
          AND operation.operation_token_expires_at > ${now}
          AND operation.retention_expires_at > ${now}
          AND operation.phase NOT IN ('completed', 'failed', 'cancelled', 'draft-ready')
          AND auth.revoked_at IS NULL
          AND auth.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
        ORDER BY operation.created_at ASC`.pipe(
      Effect.map((rows) => rows.map((row) => VoiceThreadTurnOperationId.make(row.operationId))),
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.listRecoverableOperationIds")),
    );

  const revokeRuntime: VoiceThreadTurnStoreShape["revokeRuntime"] = (authSessionId, runtimeId) =>
    sql`UPDATE voice_thread_turn_operations SET
      token_hash = 'revoked:' || operation_id,
      detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
      active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
      processing_lease_until = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE processing_lease_until END,
      processing_lease_token = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE processing_lease_token END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.revokeRuntime")),
    );
  const revokeAuthSession: VoiceThreadTurnStoreShape["revokeAuthSession"] = (authSessionId) =>
    sql`UPDATE voice_thread_turn_operations SET
      token_hash = 'revoked:' || operation_id,
      detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
      active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
      processing_lease_until = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE processing_lease_until END,
      processing_lease_token = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE processing_lease_token END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE auth_session_id = ${authSessionId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceThreadTurnStore.revokeAuthSession")),
    );

  return VoiceThreadTurnStore.of({
    claim,
    authorize,
    get,
    recordAssistantMessages,
    getReceiptCorrelation,
    completeDraft,
    readDraft,
    readDraftAuthorized,
    consumeDraft,
    expireDrafts,
    detach,
    detachInternal,
    claimProcessing,
    setDraftDisposition,
    beginDispatch,
    acceptDispatch,
    releaseProcessing,
    appendEvent,
    finalize,
    listEvents,
    readEventPage,
    acknowledge,
    putSpeechSegmentAndEvent,
    resolveAssistantRevision,
    getSpeechSegment,
    listSpeechSegments,
    getSpeechSegmentAuthorized,
    getSpeechSegmentText,
    cancel,
    expireAndPurge,
    listRecoverableOperationIds,
    revokeRuntime,
    revokeAuthSession,
  });
});

export const VoiceThreadTurnStoreLive = Layer.effect(VoiceThreadTurnStore, make);

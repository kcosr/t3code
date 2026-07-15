import {
  AuthSessionId,
  VoiceClientActionId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
  VoiceThreadRuntimeTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceRealtimeTransitionReservationRepository,
  type PersistedVoiceRealtimeTransitionReservation,
  type VoiceRealtimeTransitionReservationRepositoryShape,
} from "../Services/VoiceRealtimeTransitionReservations.ts";

interface Row {
  readonly authSessionId: string;
  readonly sourceSessionId: string;
  readonly sourceLeaseGeneration: number;
  readonly actionId: string;
  readonly actionSequence: number;
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  readonly sourceGeneration: number;
  readonly nextGeneration: number;
  readonly modeSessionId: string;
  readonly targetJson: string;
  readonly consumedAt: number | null;
}

const encodeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceThreadRuntimeTarget));
const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceThreadRuntimeTarget));
const columns = `auth_session_id AS "authSessionId", source_session_id AS "sourceSessionId",
  source_lease_generation AS "sourceLeaseGeneration", action_id AS "actionId",
  action_sequence AS "actionSequence", runtime_id AS "runtimeId",
  runtime_instance_id AS "runtimeInstanceId", source_generation AS "sourceGeneration",
  next_generation AS "nextGeneration", mode_session_id AS "modeSessionId",
  target_json AS "targetJson", consumed_at AS "consumedAt"`;
const decode = (row: Row): PersistedVoiceRealtimeTransitionReservation => ({
  authSessionId: AuthSessionId.make(row.authSessionId),
  sourceSessionId: VoiceSessionId.make(row.sourceSessionId),
  sourceLeaseGeneration: row.sourceLeaseGeneration,
  actionId: VoiceClientActionId.make(row.actionId),
  actionSequence: row.actionSequence,
  runtimeId: VoiceRuntimeId.make(row.runtimeId),
  runtimeInstanceId: VoiceRuntimeInstanceId.make(row.runtimeInstanceId),
  sourceGeneration: row.sourceGeneration,
  nextGeneration: row.nextGeneration,
  modeSessionId: VoiceModeSessionId.make(row.modeSessionId),
  target: decodeTarget(row.targetJson),
  consumedAt: row.consumedAt,
});

const sameIdentity = (
  row: PersistedVoiceRealtimeTransitionReservation,
  input: Omit<PersistedVoiceRealtimeTransitionReservation, "consumedAt">,
) =>
  row.authSessionId === input.authSessionId &&
  row.sourceSessionId === input.sourceSessionId &&
  row.sourceLeaseGeneration === input.sourceLeaseGeneration &&
  row.actionId === input.actionId &&
  row.actionSequence === input.actionSequence &&
  row.runtimeId === input.runtimeId &&
  row.runtimeInstanceId === input.runtimeInstanceId &&
  row.sourceGeneration === input.sourceGeneration &&
  row.nextGeneration === input.nextGeneration &&
  row.modeSessionId === input.modeSessionId &&
  encodeTarget(row.target) === encodeTarget(input.target);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const claim: VoiceRealtimeTransitionReservationRepositoryShape["claim"] = (input, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<Row>(
            `SELECT ${columns} FROM voice_runtime_realtime_transition_grants
           WHERE (source_session_id = ? AND action_id = ? AND next_generation = ?)
              OR (source_session_id = ? AND source_lease_generation = ? AND action_id = ?)
           LIMIT 1`,
            [
              input.sourceSessionId,
              input.actionId,
              input.nextGeneration,
              input.sourceSessionId,
              input.sourceLeaseGeneration,
              input.actionId,
            ],
          );
          const existing = rows[0];
          if (existing !== undefined) {
            const record = decode(existing);
            return sameIdentity(record, input)
              ? { status: "existing" as const, record }
              : { status: "mismatch" as const };
          }
          yield* sql`INSERT INTO voice_runtime_realtime_transition_grants (
          source_session_id, action_id, next_generation, auth_session_id,
          source_lease_generation, action_sequence, runtime_id, runtime_instance_id,
          source_generation, mode_session_id, target_json, created_at
        ) VALUES (
          ${input.sourceSessionId}, ${input.actionId}, ${input.nextGeneration},
          ${input.authSessionId}, ${input.sourceLeaseGeneration}, ${input.actionSequence},
          ${input.runtimeId}, ${input.runtimeInstanceId}, ${input.sourceGeneration},
          ${input.modeSessionId}, ${encodeTarget(input.target)}, ${now}
        )`;
          return { status: "claimed" as const };
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceRealtimeTransitionReservationRepository.claim"),
        ),
      );

  const revoke: VoiceRealtimeTransitionReservationRepositoryShape["revoke"] = (
    sourceSessionId,
    actionId,
    nextGeneration,
  ) =>
    sql`DELETE FROM voice_runtime_realtime_transition_grants
      WHERE source_session_id = ${sourceSessionId} AND action_id = ${actionId}
        AND next_generation = ${nextGeneration} AND consumed_at IS NULL`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("VoiceRealtimeTransitionReservationRepository.revoke")),
    );

  return VoiceRealtimeTransitionReservationRepository.of({ claim, revoke });
});

export const VoiceRealtimeTransitionReservationRepositoryLive = Layer.effect(
  VoiceRealtimeTransitionReservationRepository,
  make,
);

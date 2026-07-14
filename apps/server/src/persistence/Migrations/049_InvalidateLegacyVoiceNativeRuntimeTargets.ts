import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Historical migration schema. The legacy public contract is intentionally no
// longer exported after the protocol-major cutover.
const LegacyVoiceNativeRuntimeTarget = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("realtime"),
    conversation: Schema.Struct({
      type: Schema.Literal("continue"),
      conversationId: Schema.String,
    }),
    focus: Schema.Union([
      Schema.Struct({ type: Schema.Literal("none") }),
      Schema.Struct({ type: Schema.Literal("project"), projectId: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("thread"),
        projectId: Schema.String,
        threadId: Schema.String,
      }),
    ]),
  }),
  Schema.Struct({
    mode: Schema.Literal("thread"),
    environmentId: Schema.String,
    projectId: Schema.String,
    threadId: Schema.String,
    speechPreset: Schema.Literals(["default", "warm"]),
    autoRearm: Schema.Boolean,
    endpointPolicy: Schema.Struct({
      endSilenceMs: Schema.Number,
      noSpeechTimeoutMs: Schema.NullOr(Schema.Number),
      maximumUtteranceMs: Schema.Number,
    }),
    speechEnabled: Schema.Boolean,
    rearmGuardMs: Schema.Number,
  }),
]);
const decodeTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(LegacyVoiceNativeRuntimeTarget),
);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const grants = yield* sql<{
    readonly tokenHash: string;
    readonly authSessionId: string;
    readonly runtimeId: string;
    readonly targetJson: string;
  }>`SELECT token_hash AS "tokenHash", auth_session_id AS "authSessionId",
      runtime_id AS "runtimeId", target_json AS "targetJson"
      FROM voice_native_runtime_grants`;

  for (const grant of grants) {
    if (Option.isSome(decodeTarget(grant.targetJson))) continue;
    yield* sql`UPDATE voice_native_thread_turn_operations SET
      token_hash = 'revoked:migration-49:' || operation_id,
      detached_at = COALESCE(detached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      phase = CASE WHEN dispatch_accepted = 0 THEN 'cancelled' ELSE phase END,
      active_slot = CASE WHEN dispatch_accepted = 0 THEN NULL ELSE active_slot END,
      processing_lease_until = CASE WHEN dispatch_accepted = 0
        THEN NULL ELSE processing_lease_until END,
      processing_lease_token = CASE WHEN dispatch_accepted = 0
        THEN NULL ELSE processing_lease_token END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
    yield* sql`DELETE FROM voice_native_realtime_starts
      WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
    yield* sql`DELETE FROM voice_native_control_grants
      WHERE auth_session_id = ${grant.authSessionId} AND runtime_id = ${grant.runtimeId}`;
    yield* sql`DELETE FROM voice_native_runtime_grants WHERE token_hash = ${grant.tokenHash}`;
  }
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { VoiceRealtimeTransitionGrantRepository } from "../Services/VoiceRealtimeTransitionGrants.ts";
import { VoiceRealtimeTransitionGrantRepositoryLive } from "./VoiceRealtimeTransitionGrants.ts";

const sqlite = NodeSqliteClient.layerMemory();
const layer = VoiceRealtimeTransitionGrantRepositoryLive.pipe(
  Layer.provide(sqlite),
  Layer.provideMerge(sqlite),
  Layer.provideMerge(NodeServices.layer),
);

const record = {
  operationKey: "transition-operation",
  tokenHash: "sha256-transition-token",
  sourceControlTokenHash: "sha256-source-control-token",
  authSessionId: AuthSessionId.make("transition-auth"),
  sourceSessionId: VoiceSessionId.make("transition-source-session"),
  sourceLeaseGeneration: 7,
  actionId: VoiceClientActionId.make("transition-action"),
  actionSequence: 6,
  runtimeId: VoiceRuntimeId.make("transition-runtime"),
  runtimeInstanceId: VoiceRuntimeInstanceId.make("transition-instance"),
  sourceGeneration: 3,
  targetGeneration: 4,
  modeSessionId: VoiceModeSessionId.make("transition-thread-mode"),
  target: {
    mode: "thread" as const,
    environmentId: EnvironmentId.make("transition-environment"),
    projectId: ProjectId.make("transition-project"),
    threadId: ThreadId.make("transition-thread"),
    speechPreset: "default" as const,
    autoRearm: true,
    endpointPolicy: {
      endSilenceMs: 2_200,
      noSpeechTimeoutMs: null,
      maximumUtteranceMs: 600_000,
    },
    speechEnabled: true,
    rearmGuardMs: 500,
  },
  expiresAt: 100_000,
  authorityExpiresAt: 120_000,
};

it.effect("persists a bounded hashed transition reservation", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO auth_sessions (
      session_id, subject, scopes, method, client_device_type, issued_at, expires_at
    ) VALUES (
      ${record.authSessionId}, 'transition-test', '[]', 'bearer-access-token', 'mobile',
      '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
    )`;
    const repository = yield* VoiceRealtimeTransitionGrantRepository;
    expect(yield* repository.claim(record, 1_000)).toEqual({ status: "claimed" });
    expect(yield* repository.claim(record, 2_000)).toMatchObject({
      status: "existing",
      record: { tokenHash: record.tokenHash, target: record.target },
    });
    expect(
      yield* repository.claim({ ...record, operationKey: "different-operation" }, 2_000),
    ).toEqual({ status: "mismatch" });
    expect(yield* repository.findByToken(record.tokenHash, 3_000)).toMatchObject({
      runtimeId: record.runtimeId,
      runtimeInstanceId: record.runtimeInstanceId,
      sourceGeneration: 3,
      targetGeneration: 4,
      target: record.target,
    });
    expect(yield* repository.findByOperationKey(record.operationKey, 3_000)).toMatchObject({
      sourceControlTokenHash: record.sourceControlTokenHash,
      actionSequence: 6,
    });
    expect(yield* repository.findByToken(record.tokenHash, 100_000)).toBeUndefined();
    expect(yield* repository.findByOperationKey(record.operationKey, 100_000)).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

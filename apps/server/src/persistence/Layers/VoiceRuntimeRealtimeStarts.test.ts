import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  VoiceConversationId,
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
import { VoiceRuntimeRealtimeStartRepository } from "../Services/VoiceRuntimeRealtimeStarts.ts";
import { VoiceRuntimeRealtimeStartRepositoryLive } from "./VoiceRuntimeRealtimeStarts.ts";

const sqlite = NodeSqliteClient.layerMemory();
const layer = VoiceRuntimeRealtimeStartRepositoryLive.pipe(
  Layer.provide(sqlite),
  Layer.provideMerge(sqlite),
  Layer.provideMerge(NodeServices.layer),
);
const input = {
  operationKey: "native:runtime:1:start-digest",
  authSessionId: AuthSessionId.make("auth-native-start"),
  runtimeId: VoiceRuntimeId.make("runtime-native-start"),
  runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-instance-native-start"),
  runtimeGeneration: 1,
  modeSessionId: VoiceModeSessionId.make("mode-session-native-start"),
  clientOperationId: "start-client-operation",
  conversationId: VoiceConversationId.make("conversation-native-start"),
  claimExpiresAt: 61_000,
  expiresAt: 600_000,
  now: 1_000,
};

it.effect("durably fences unbound and bound native Realtime start replays", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 56 });
    const repository = yield* VoiceRuntimeRealtimeStartRepository;
    expect(yield* repository.claim(input)).toEqual({ status: "claimed" });

    const unbound = yield* repository.claim({ ...input, now: 2_000 });
    expect(unbound).toMatchObject({
      status: "existing",
      record: { sessionId: null, claimExpiresAt: 61_000 },
    });

    const sessionId = VoiceSessionId.make("native-start-session");
    expect(yield* repository.bindSession(input.operationKey, sessionId, 7, 3_000)).toBe(true);
    expect(yield* repository.bindSession(input.operationKey, sessionId, 7, 4_000)).toBe(true);
    expect(yield* repository.bindSession(input.operationKey, sessionId, 8, 4_000)).toBe(false);
    expect(
      yield* repository.bindSession(
        input.operationKey,
        VoiceSessionId.make("different-session"),
        7,
        4_000,
      ),
    ).toBe(false);
    expect(yield* repository.findBySession(sessionId, 4_000)).toMatchObject({
      runtimeInstanceId: input.runtimeInstanceId,
      modeSessionId: input.modeSessionId,
      leaseGeneration: 7,
    });
    expect(yield* repository.findBySession(sessionId, input.expiresAt)).toBeUndefined();

    const afterRestart = yield* repository.claim({ ...input, now: 5_000 });
    expect(afterRestart).toMatchObject({
      status: "existing",
      record: {
        sessionId,
        runtimeInstanceId: input.runtimeInstanceId,
        modeSessionId: input.modeSessionId,
        leaseGeneration: 7,
      },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a late bind after an ambiguous claim lease expires", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 56 });
    const repository = yield* VoiceRuntimeRealtimeStartRepository;
    const late = {
      ...input,
      operationKey: `${input.operationKey}:late`,
      clientOperationId: "late",
    };
    expect(yield* repository.claim(late)).toEqual({ status: "claimed" });
    expect(
      yield* repository.bindSession(
        late.operationKey,
        VoiceSessionId.make("late-session"),
        7,
        late.claimExpiresAt + 1,
      ),
    ).toBe(false);
    expect(yield* repository.claim({ ...late, now: late.claimExpiresAt + 1 })).toMatchObject({
      status: "existing",
      record: { sessionId: null },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("reclaims retryable failures while replaying terminal failures", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 56 });
    const repository = yield* VoiceRuntimeRealtimeStartRepository;
    const failed = {
      ...input,
      operationKey: `${input.operationKey}:failed`,
      clientOperationId: "failed",
    };
    expect(yield* repository.claim(failed)).toEqual({ status: "claimed" });
    const failure = {
      reason: "provider-unavailable" as const,
      operation: "native-start-test",
      detail: "Provider unavailable",
      retryable: true,
    };
    expect(yield* repository.fail(failed.operationKey, failure, 2_000)).toBe(true);
    expect(yield* repository.claim({ ...failed, now: 3_000 })).toEqual({ status: "claimed" });
    expect(yield* repository.claim({ ...failed, now: 3_001 })).toMatchObject({
      status: "existing",
      record: { sessionId: null, failure: null, claimExpiresAt: failed.claimExpiresAt },
    });

    const terminal = {
      ...input,
      operationKey: `${input.operationKey}:terminal`,
      clientOperationId: "terminal",
    };
    const terminalFailure = { ...failure, retryable: false };
    expect(yield* repository.claim(terminal)).toEqual({ status: "claimed" });
    expect(yield* repository.fail(terminal.operationKey, terminalFailure, 2_000)).toBe(true);
    expect(yield* repository.claim({ ...terminal, now: 3_000 })).toMatchObject({
      status: "existing",
      record: { sessionId: null, failure: terminalFailure },
    });

    // Simulate another process claiming after the failure was durably persisted.
    expect(yield* repository.fail(failed.operationKey, failure, 62_000)).toBe(true);
    const retryInput = { ...failed, claimExpiresAt: 122_000, now: 62_001 };
    const retries = yield* Effect.all(
      [repository.claim(retryInput), repository.claim(retryInput)],
      { concurrency: "unbounded" },
    );
    expect(retries.map((result) => result.status).sort()).toEqual(["claimed", "existing"]);

    const expired = {
      ...input,
      operationKey: `${input.operationKey}:expired`,
      clientOperationId: "expired",
      expiresAt: 5_000,
    };
    expect(yield* repository.claim(expired)).toEqual({ status: "claimed" });
    expect(yield* repository.claim({ ...expired, now: 5_001, expiresAt: 10_000 })).toEqual({
      status: "claimed",
    });
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql`SELECT 1 FROM voice_runtime_realtime_starts
        WHERE operation_key = ${expired.operationKey}`,
    ).toHaveLength(1);

    yield* repository.revokeRuntime(input.authSessionId, input.runtimeId);
    expect(
      yield* sql`SELECT 1 FROM voice_runtime_realtime_starts
        WHERE auth_session_id = ${input.authSessionId} AND runtime_id = ${input.runtimeId}`,
    ).toHaveLength(0);
  }).pipe(Effect.provide(layer)),
);

it.effect("serializes concurrent claims to one durable owner", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 56 });
    const repository = yield* VoiceRuntimeRealtimeStartRepository;
    const concurrent = {
      ...input,
      operationKey: `${input.operationKey}:concurrent`,
      clientOperationId: "concurrent",
    };
    const results = yield* Effect.all(
      [repository.claim(concurrent), repository.claim(concurrent)],
      { concurrency: "unbounded" },
    );
    expect(results.map((result) => result.status).sort()).toEqual(["claimed", "existing"]);
  }).pipe(Effect.provide(layer)),
);

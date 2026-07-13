import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  VoiceNativeRuntimeId,
  VoiceNativeThreadTurnOperationId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { VoiceNativeThreadTurnStore } from "../Services/VoiceNativeThreadTurns.ts";
import { VoiceNativeThreadTurnStoreLive } from "./VoiceNativeThreadTurns.ts";

const sqlite = NodeSqliteClient.layerMemory();
const testLayer = VoiceNativeThreadTurnStoreLive.pipe(Layer.provideMerge(sqlite));
const authSessionId = AuthSessionId.make("native-thread-auth");
const runtimeId = VoiceNativeRuntimeId.make("native-thread-runtime");
const operationId = VoiceNativeThreadTurnOperationId.make("native-thread-operation");
const nowIso = "2026-07-13T12:00:00.000Z";
const now = Date.parse(nowIso);

const initialize = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 44 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_native_thread_turn_operations`;
  yield* sql`DELETE FROM voice_native_runtime_grants`;
  yield* sql`DELETE FROM auth_sessions WHERE session_id = ${authSessionId}`;
  yield* sql`INSERT INTO auth_sessions (
    session_id, subject, scopes, method, client_device_type, issued_at, expires_at
  ) VALUES (
    ${authSessionId}, 'native-thread-test', '[]', 'bearer-access-token', 'mobile',
    '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
  )`;
  yield* sql`INSERT INTO voice_native_runtime_grants (
    token_hash, runtime_id, generation, auth_session_id, granted_scopes_json,
    target_json, expires_at, created_at
  ) VALUES (
    'runtime-token-hash', ${runtimeId}, 3, ${authSessionId}, '[]',
    '{"mode":"thread","projectId":"project","threadId":"thread","speechPreset":"default","autoRearm":true}',
    ${now + 60_000}, ${now}
  )`;
});

const claimInput = {
  operationId,
  authSessionId,
  runtimeId,
  runtimeGeneration: 3,
  clientOperationId: "client-operation",
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  speechPreset: "default" as const,
  autoRearm: true,
  tokenHash: "operation-token-hash",
  expiresAt: now + 60_000,
  nowEpochMillis: now,
  now: nowIso,
};

describe.sequential("VoiceNativeThreadTurnStore", () => {
  it.effect("claims idempotently, rotates the child token, and fences stale generations", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      const created = yield* store.claim(claimInput);
      const retried = yield* store.claim({
        ...claimInput,
        tokenHash: "rotated-operation-token-hash",
        expiresAt: now + 120_000,
      });

      expect(retried.operationId).toBe(created.operationId);
      expect(retried.lastSequence).toBe(1);
      expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeUndefined();
      expect(
        yield* store.authorize(operationId, "rotated-operation-token-hash", now),
      ).toMatchObject({ operationId, runtimeGeneration: 3 });

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE voice_native_runtime_grants SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      expect(
        yield* store.authorize(operationId, "rotated-operation-token-hash", now),
      ).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers leases, replays ordered events, and acknowledges monotonically", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      yield* store.claim(claimInput);
      expect(yield* store.claimProcessing(operationId, now, now + 1_000, nowIso)).toBe(true);
      expect(yield* store.claimProcessing(operationId, now + 500, now + 1_500, nowIso)).toBe(false);
      expect(yield* store.claimProcessing(operationId, now + 1_001, now + 2_000, nowIso)).toBe(
        true,
      );

      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "dispatching" },
        { phase: "dispatching" },
      );
      yield* store.appendEvent(
        operationId,
        {
          type: "dispatch-correlation",
          occurredAt: nowIso,
          commandId: CommandId.make("command"),
          messageId: MessageId.make("message"),
          turnId: null,
        },
        {
          commandId: CommandId.make("command"),
          messageId: MessageId.make("message"),
          dispatchAccepted: true,
          clearProcessingLease: true,
        },
      );
      const events = yield* store.listEvents(operationId, 1, 100);
      expect(events.map((event) => event.sequence)).toEqual([2, 3]);
      expect(yield* store.acknowledge(operationId, 2)).toBe(true);
      expect(yield* store.acknowledge(operationId, 1)).toBe(true);
      expect(yield* store.acknowledge(operationId, 4)).toBe(false);
      expect((yield* store.get(operationId))?.acknowledgedSequence).toBe(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps accepted work accessible across generation rotation and speech retries stable",
    () =>
      Effect.gen(function* () {
        yield* initialize;
        const store = yield* VoiceNativeThreadTurnStore;
        yield* store.claim(claimInput);
        yield* store.appendEvent(
          operationId,
          {
            type: "dispatch-correlation",
            occurredAt: nowIso,
            commandId: CommandId.make("command"),
            messageId: MessageId.make("message"),
            turnId: null,
          },
          { dispatchAccepted: true },
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE voice_native_runtime_grants SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
        expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeDefined();

        const segment = {
          operationId,
          segmentIndex: 0,
          assistantMessageId: MessageId.make("assistant-message"),
          startOffset: 0,
          endOffset: 22,
          finalSegment: true,
          createdAt: nowIso,
        };
        expect(yield* store.putSpeechSegment(segment)).toBe(true);
        expect(yield* store.putSpeechSegment(segment)).toBe(false);
        expect(yield* store.getSpeechSegment(operationId, 0)).toEqual(segment);

        yield* store.revokeRuntime(authSessionId, runtimeId);
        expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeUndefined();
      }).pipe(Effect.provide(testLayer)),
  );
});

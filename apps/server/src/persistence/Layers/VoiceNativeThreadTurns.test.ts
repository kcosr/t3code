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
  yield* runMigrations({ toMigrationInclusive: 45 });
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

      expect(retried.status).toBe("claimed");
      expect(retried.operation.operationId).toBe(created.operation.operationId);
      expect(retried.operation.lastSequence).toBe(1);
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
      expect(yield* store.claimProcessing(operationId, "lease-1", now, now + 1_000, nowIso)).toBe(
        true,
      );
      expect(
        yield* store.claimProcessing(operationId, "lease-2", now + 500, now + 1_500, nowIso),
      ).toBe(false);
      expect(
        yield* store.claimProcessing(operationId, "lease-3", now + 1_001, now + 2_000, nowIso),
      ).toBe(true);

      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* store.beginDispatch(operationId, "lease-3", now + 1_001, nowIso);
      yield* store.acceptDispatch({
        operationId,
        leaseToken: "lease-3",
        occurredAt: nowIso,
        commandId: CommandId.make("command"),
        messageId: MessageId.make("message"),
      });
      const events = yield* store.listEvents(operationId, 1, 100);
      expect(events.map((event) => event.sequence)).toEqual([2, 3, 4]);
      expect(yield* store.acknowledge(operationId, 2)).toBe(true);
      expect(yield* store.acknowledge(operationId, 1)).toBe(true);
      expect(yield* store.acknowledge(operationId, 5)).toBe(false);
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
        yield* store.claimProcessing(operationId, "lease", now, now + 1_000, nowIso);
        yield* store.appendEvent(
          operationId,
          { type: "phase", occurredAt: nowIso, phase: "transcribing" },
          { phase: "transcribing" },
        );
        yield* store.beginDispatch(operationId, "lease", now, nowIso);
        yield* store.acceptDispatch({
          operationId,
          leaseToken: "lease",
          occurredAt: nowIso,
          commandId: CommandId.make("command"),
          messageId: MessageId.make("message"),
        });
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
          sourceEventSequence: 17,
          sourceTextSha256: "digest",
          createdAt: nowIso,
        };
        expect(yield* store.putSpeechSegmentAndEvent(segment)).toBe("inserted");
        expect(yield* store.putSpeechSegmentAndEvent(segment)).toBe("existing");
        expect(yield* store.getSpeechSegment(operationId, 0)).toEqual(segment);

        yield* store.revokeRuntime(authSessionId, runtimeId);
        expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeUndefined();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fences dispatch when cancellation wins the transcription race", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      yield* store.claim(claimInput);
      expect(yield* store.claimProcessing(operationId, "lease", now, now + 1_000, nowIso)).toBe(
        true,
      );
      expect(yield* store.cancel(operationId, nowIso)).toBe("cancelled");
      expect(yield* store.beginDispatch(operationId, "lease", now, nowIso)).toBe(false);
      const operation = yield* store.get(operationId);
      expect(operation).toMatchObject({
        phase: "cancelled",
        processingLeaseToken: null,
        processingLeaseUntil: null,
      });
      expect((yield* store.listEvents(operationId, 0, 100)).map((event) => event.type)).toEqual([
        "phase",
        "phase",
        "terminal",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fences a transcription lease when runtime takeover wins before dispatch", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.claim(claimInput);
      yield* store.claimProcessing(operationId, "lease", now, now + 1_000, nowIso);
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* sql`UPDATE voice_native_runtime_grants SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      expect(yield* store.beginDispatch(operationId, "lease", now, nowIso)).toBe(false);
      expect(yield* store.get(operationId)).toMatchObject({ phase: "transcribing" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("makes dispatch commitment and terminal finalization atomic", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      yield* store.claim(claimInput);
      yield* store.claimProcessing(operationId, "lease", now, now + 1_000, nowIso);
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      expect(yield* store.beginDispatch(operationId, "lease", now, nowIso)).toBe(true);
      expect(yield* store.cancel(operationId, nowIso)).toBe("dispatch-committed");
      expect(
        yield* store.acceptDispatch({
          operationId,
          leaseToken: "lease",
          occurredAt: nowIso,
          commandId: CommandId.make("command"),
          messageId: MessageId.make("message"),
        }),
      ).toBe(true);
      expect(
        yield* store.finalize({
          operationId,
          occurredAt: nowIso,
          outcome: "failed",
          speechOutcome: "failed",
          failureCode: "turn-failed",
          retryable: false,
        }),
      ).toBe(true);
      const operation = yield* store.get(operationId);
      expect(operation).toMatchObject({ phase: "failed", speechTerminal: "failed" });
      const events = yield* store.listEvents(operationId, 0, 100);
      expect(events.slice(-3).map((event) => event.type)).toEqual([
        "failure",
        "speech-terminal",
        "terminal",
      ]);
      expect(yield* store.finalize({ operationId, occurredAt: nowIso, outcome: "completed" })).toBe(
        false,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("allows a dispatched voice operation to stop without retracting the thread turn", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      yield* store.claim(claimInput);
      yield* store.claimProcessing(operationId, "lease", now, now + 1_000, nowIso);
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* store.beginDispatch(operationId, "lease", now, nowIso);
      yield* store.acceptDispatch({
        operationId,
        leaseToken: "lease",
        occurredAt: nowIso,
        commandId: CommandId.make("command"),
        messageId: MessageId.make("message"),
      });
      expect(yield* store.cancel(operationId, nowIso)).toBe("cancelled");
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "cancelled",
        dispatchAccepted: true,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not resurrect an expired idempotent operation", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      yield* store.claim({ ...claimInput, expiresAt: now + 100 });
      const retried = yield* store.claim({
        ...claimInput,
        tokenHash: "replacement-token",
        nowEpochMillis: now + 101,
        expiresAt: now + 60_000,
      });
      expect(retried.status).toBe("expired");
      expect(yield* store.authorize(operationId, "replacement-token", now + 101)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("validates an existing speech segment instead of silently accepting conflicts", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      yield* store.claim(claimInput);
      const segment = {
        operationId,
        segmentIndex: 0,
        assistantMessageId: MessageId.make("assistant-message"),
        startOffset: 0,
        endOffset: 5,
        finalSegment: false,
        sourceEventSequence: 12,
        sourceTextSha256: "digest-a",
        createdAt: nowIso,
      };
      expect(yield* store.putSpeechSegmentAndEvent(segment)).toBe("inserted");
      expect(
        yield* store.putSpeechSegmentAndEvent({ ...segment, sourceTextSha256: "digest-b" }),
      ).toBe("mismatch");
      expect(
        (yield* store.listEvents(operationId, 0, 100)).filter((e) => e.type === "speech-ready"),
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retrieves speech from its immutable orchestration event revision", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.claim(claimInput);
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json
      ) VALUES (
        'assistant-delta-1', 'thread', 'thread', 0, 'thread.message-sent', ${nowIso},
        'provider', json_object(
          'messageId', 'assistant-message', 'role', 'assistant', 'text', 'Hello immutable world.',
          'streaming', json('true')
        ), '{}'
      )`;
      const revision = yield* store.resolveAssistantRevision(MessageId.make("assistant-message"));
      expect(revision).toBeDefined();
      yield* store.putSpeechSegmentAndEvent({
        operationId,
        segmentIndex: 0,
        assistantMessageId: MessageId.make("assistant-message"),
        startOffset: 0,
        endOffset: 16,
        finalSegment: false,
        ...revision!,
        createdAt: nowIso,
      });
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json
      ) VALUES (
        'assistant-correction', 'thread', 'thread', 1, 'thread.message-sent', ${nowIso},
        'provider', json_object(
          'messageId', 'assistant-message', 'role', 'assistant', 'text', 'Corrected response.',
          'streaming', json('false')
        ), '{}'
      )`;
      expect(yield* store.getSpeechSegmentText(operationId, 0)).toBe("Hello immutable ");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("durably finalizes expiry and purges terminal records after retention", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceNativeThreadTurnStore;
      yield* store.claim({ ...claimInput, expiresAt: now + 100 });
      expect(yield* store.expireAndPurge(now + 101, nowIso, now - 1)).toEqual([operationId]);
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "failed",
        speechTerminal: "failed",
      });
      expect(yield* store.listEvents(operationId, 0, 100)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "failure", code: "operation-expired" }),
          expect.objectContaining({ type: "terminal", outcome: "failed" }),
        ]),
      );
      yield* store.expireAndPurge(now + 102, nowIso, now + 101);
      expect(yield* store.get(operationId)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );
});

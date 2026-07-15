import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  VoiceDraftArtifactId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceThreadTurnOperationId,
  VoiceSpeechPlanId,
  VoiceTurnClientOperationId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { VoiceThreadTurnStore } from "../Services/VoiceThreadTurns.ts";
import { VoiceThreadTurnStoreLive } from "./VoiceThreadTurns.ts";

const sqlite = NodeSqliteClient.layerMemory();
const testLayer = Layer.mergeAll(sqlite, VoiceThreadTurnStoreLive.pipe(Layer.provide(sqlite)));
const authSessionId = AuthSessionId.make("native-thread-auth");
const runtimeId = VoiceRuntimeId.make("native-thread-runtime");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("native-thread-runtime-instance");
const operationId = VoiceThreadTurnOperationId.make("native-thread-operation");
const nowIso = "2026-07-13T12:00:00.000Z";
const now = Date.parse(nowIso);

const initialize = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 56 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_thread_turn_operations`;
  yield* sql`DELETE FROM voice_runtime_authorities`;
  yield* sql`DELETE FROM auth_sessions WHERE session_id = ${authSessionId}`;
  yield* sql`INSERT INTO auth_sessions (
    session_id, subject, scopes, method, client_device_type, issued_at, expires_at
  ) VALUES (
    ${authSessionId}, 'native-thread-test', '[]', 'bearer-access-token', 'mobile',
    '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
  )`;
  yield* sql`INSERT INTO voice_runtime_authorities (
    auth_session_id, runtime_id, generation, target_json, created_at, updated_at
  ) VALUES (
    ${authSessionId}, ${runtimeId}, 3,
    '{"mode":"thread","environmentId":"environment","projectId":"project","threadId":"thread","speechPreset":"default","autoRearm":true,"endpointPolicy":{"endSilenceMs":2200,"noSpeechTimeoutMs":null,"maximumUtteranceMs":120000},"speechEnabled":true,"rearmGuardMs":500}',
    ${now}, ${now}
  )`;
});

const claimInput = {
  operationId,
  authSessionId,
  runtimeId,
  runtimeInstanceId,
  runtimeGeneration: 3,
  modeSessionId: VoiceModeSessionId.make("mode-session"),
  turnClientOperationId: VoiceTurnClientOperationId.make("client-operation"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  speechPreset: "default" as const,
  speechEnabled: true,
  autoRearm: true,
  submissionPolicy: "auto-submit" as const,
  speechPlanId: VoiceSpeechPlanId.make("speech-plan"),
  tokenHash: "operation-token-hash",
  operationTokenExpiresAt: now + 60_000,
  retentionExpiresAt: now + 30 * 24 * 60 * 60 * 1_000,
  nowEpochMillis: now,
  now: nowIso,
};
const ackInput = (acknowledgedSequence: number) => ({
  acknowledgedSequence,
  speechPlanId: claimInput.speechPlanId,
  highestStartedSegment: null,
  highestDrainedSegment: null,
  segmentDispositions: [],
  occurredAt: nowIso,
});

describe.sequential("VoiceThreadTurnStore", () => {
  it.effect("persists disabled speech as immutable turn policy", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const claimed = yield* store.claim({ ...claimInput, speechEnabled: false });
      expect(claimed.status).toBe("claimed");
      if (claimed.status !== "claimed") return;
      expect(claimed.operation.speechEnabled).toBe(false);
      expect(yield* store.get(operationId)).toMatchObject({ speechEnabled: false });
      expect((yield* store.claim(claimInput)).status).toBe("mismatch");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims idempotently and rotates the operation ownership fence", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const created = yield* store.claim(claimInput);
      const retried = yield* store.claim({
        ...claimInput,
        tokenHash: "rotated-operation-token-hash",
        operationTokenExpiresAt: now + 120_000,
        retentionExpiresAt: now + 1_000,
      });

      expect(created.status).toBe("claimed");
      expect(retried.status).toBe("claimed");
      if (created.status !== "claimed" || retried.status !== "claimed") return;
      expect(retried.status).toBe("claimed");
      expect(retried.operation.operationId).toBe(created.operation.operationId);
      expect(retried.operation.lastSequence).toBe(1);
      expect(retried.operation.retentionExpiresAt).toBe(claimInput.retentionExpiresAt);
      expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeUndefined();
      expect(
        yield* store.authorize(operationId, "rotated-operation-token-hash", now),
      ).toMatchObject({ operationId, runtimeGeneration: 3 });
      expect(yield* store.acknowledge(operationId, claimInput.tokenHash, ackInput(1), now)).toBe(
        "revoked",
      );
      expect(yield* store.cancel(operationId, claimInput.tokenHash, nowIso, now)).toBe("revoked");
      expect(
        yield* store.acknowledge(operationId, "rotated-operation-token-hash", ackInput(1), now),
      ).toBe("acknowledged");

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE voice_runtime_authorities SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      expect(
        yield* store.authorize(operationId, "rotated-operation-token-hash", now),
      ).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("transactionally rejects a claim after the exact parent generation rotates", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE voice_runtime_authorities SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;

      expect(yield* store.claim(claimInput)).toEqual({ status: "revoked" });
      expect(yield* store.get(operationId)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects client access after the parent authority generation advances", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.claim({
        ...claimInput,
        operationTokenExpiresAt: now + 120_000,
      });
      yield* sql`UPDATE voice_runtime_authorities SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      expect(
        yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM voice_runtime_authorities WHERE auth_session_id = ${authSessionId}`,
      ).toEqual([{ count: 1 }]);

      expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeUndefined();
      expect(yield* store.get(operationId)).toMatchObject({ operationId });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers leases, replays ordered events, and acknowledges monotonically", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      expect(
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "lease-1",
          now,
          now + 1_000,
          nowIso,
        ),
      ).toBe(true);
      expect(
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "lease-2",
          now + 500,
          now + 1_500,
          nowIso,
        ),
      ).toBe(false);
      expect(
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "lease-3",
          now + 1_001,
          now + 2_000,
          nowIso,
        ),
      ).toBe(true);

      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease-3", now + 1_001, nowIso);
      yield* store.acceptDispatch({
        operationId,
        tokenHash: claimInput.tokenHash,
        leaseToken: "lease-3",
        occurredAt: nowIso,
        commandId: CommandId.make("command"),
        messageId: MessageId.make("message"),
      });
      const events = yield* store.listEvents(operationId, 1, 100);
      expect(events.map((event) => event.sequence)).toEqual([2, 3, 4]);
      expect(yield* store.acknowledge(operationId, claimInput.tokenHash, ackInput(2), now)).toBe(
        "acknowledged",
      );
      expect(yield* store.acknowledge(operationId, claimInput.tokenHash, ackInput(1), now)).toBe(
        "acknowledged",
      );
      expect(yield* store.acknowledge(operationId, claimInput.tokenHash, ackInput(5), now)).toBe(
        "invalid",
      );
      expect((yield* store.get(operationId))?.acknowledgedSequence).toBe(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("releases a processing lease and exposes a consistent event page", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "lease",
        now,
        now + 1_000,
        nowIso,
      );

      expect(
        yield* store.releaseProcessing(operationId, "lease", nowIso, "transcription-failed", true),
      ).toBe(true);
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "created",
        processingLeaseToken: null,
        processingLeaseUntil: null,
      });
      const page = yield* store.readEventPage(operationId, claimInput.tokenHash, now, 0, 100);
      expect(page).toBeDefined();
      expect(page?.events.at(-1)).toMatchObject({
        sequence: page?.operation.lastSequence,
        type: "failure",
        retryable: true,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("finalizes only the scoped expired active operation before a replacement claim", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim({
        ...claimInput,
        operationTokenExpiresAt: now + 100,
      });
      const replacementId = VoiceThreadTurnOperationId.make("replacement-operation");

      const replacement = yield* store.claim({
        ...claimInput,
        operationId: replacementId,
        turnClientOperationId: VoiceTurnClientOperationId.make("replacement-client-operation"),
        tokenHash: "replacement-operation-token-hash",
        nowEpochMillis: now + 101,
        now: "2026-07-13T12:00:00.101Z",
        operationTokenExpiresAt: now + 60_000,
      });

      expect(replacement.status).toBe("claimed");
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "failed",
        speechTerminal: "failed",
      });
      expect(yield* store.authorize(operationId, claimInput.tokenHash, now + 101)).toMatchObject({
        phase: "failed",
      });
      expect(
        yield* store.readEventPage(operationId, claimInput.tokenHash, now + 101, 0, 100),
      ).toMatchObject({ operation: { phase: "failed" } });
      expect(yield* store.listEvents(operationId, 0, 100)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "failure",
            code: "operation-expired",
          }),
          expect.objectContaining({ type: "terminal", outcome: "failed" }),
        ]),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps accepted server-side work after authority rotation and speech retries stable",
    () =>
      Effect.gen(function* () {
        yield* initialize;
        const store = yield* VoiceThreadTurnStore;
        yield* store.claim(claimInput);
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "lease",
          now,
          now + 1_000,
          nowIso,
        );
        yield* store.appendEvent(
          operationId,
          { type: "phase", occurredAt: nowIso, phase: "transcribing" },
          { phase: "transcribing" },
        );
        yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease", now, nowIso);
        yield* store.acceptDispatch({
          operationId,
          tokenHash: claimInput.tokenHash,
          leaseToken: "lease",
          occurredAt: nowIso,
          commandId: CommandId.make("command"),
          messageId: MessageId.make("message"),
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE voice_runtime_authorities SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
        expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeUndefined();

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
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      expect(
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "lease",
          now,
          now + 1_000,
          nowIso,
        ),
      ).toBe(true);
      expect(yield* store.cancel(operationId, claimInput.tokenHash, nowIso, now)).toBe("cancelled");
      expect(
        yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease", now, nowIso),
      ).toBe(false);
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

  it.effect("atomically transitions a created operation to draft before audio admission", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);

      expect(yield* store.setDraftDisposition(operationId, claimInput.tokenHash, now, nowIso)).toBe(
        "updated",
      );
      expect(yield* store.setDraftDisposition(operationId, claimInput.tokenHash, now, nowIso)).toBe(
        "unchanged",
      );
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "created",
        submissionPolicy: "draft",
        processingAttempt: 0,
      });
      expect(yield* store.setDraftDisposition(operationId, "stale-token", now, nowIso)).toBe(
        "revoked",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serializes draft disposition against audio admission", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      expect(
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "admitted-lease",
          now,
          now + 1_000,
          nowIso,
        ),
      ).toBe(true);
      expect(yield* store.setDraftDisposition(operationId, claimInput.tokenHash, now, nowIso)).toBe(
        "invalid",
      );
      expect(yield* store.get(operationId)).toMatchObject({
        submissionPolicy: "auto-submit",
        processingAttempt: 1,
        processingLeaseToken: "admitted-lease",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps an admitted transcription lease valid across runtime rotation", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.claim(claimInput);
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "lease",
        now,
        now + 1_000,
        nowIso,
      );
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* sql`UPDATE voice_runtime_authorities SET generation = 4
        WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
      expect(
        yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease", now, nowIso),
      ).toBe(true);
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "dispatching",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("makes dispatch commitment and terminal finalization atomic", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "lease",
        now,
        now + 1_000,
        nowIso,
      );
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      expect(
        yield* store.completeDraft({
          operationId,
          tokenHash: claimInput.tokenHash,
          leaseToken: "lease",
          draftId: VoiceDraftArtifactId.make("forbidden-draft"),
          cipherVersion: 1,
          nonce: new Uint8Array([1]),
          ciphertext: new Uint8Array([2]),
          expiresAt: now + 1_000,
          occurredAt: nowIso,
        }),
      ).toBe("invalid");
      expect(
        yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease", now, nowIso),
      ).toBe(true);
      expect(yield* store.cancel(operationId, claimInput.tokenHash, nowIso, now)).toBe(
        "dispatch-committed",
      );
      expect(
        yield* store.acceptDispatch({
          operationId,
          tokenHash: claimInput.tokenHash,
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
      expect(operation).toMatchObject({
        phase: "failed",
        speechTerminal: "failed",
      });
      const events = yield* store.listEvents(operationId, 0, 100);
      expect(events.slice(-3).map((event) => event.type)).toEqual([
        "failure",
        "speech-terminal",
        "terminal",
      ]);
      expect(
        yield* store.finalize({
          operationId,
          occurredAt: nowIso,
          outcome: "completed",
        }),
      ).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "revokes every native child capability when parent cleanup fails without losing accepted work",
    () =>
      Effect.gen(function* () {
        yield* initialize;
        const store = yield* VoiceThreadTurnStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.claim(claimInput);
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "lease",
          now,
          now + 1_000,
          nowIso,
        );
        yield* store.appendEvent(
          operationId,
          { type: "phase", occurredAt: nowIso, phase: "transcribing" },
          { phase: "transcribing" },
        );
        yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease", now, nowIso);
        yield* store.acceptDispatch({
          operationId,
          tokenHash: claimInput.tokenHash,
          leaseToken: "lease",
          occurredAt: nowIso,
          commandId: CommandId.make("command"),
          messageId: MessageId.make("message"),
        });

        // Simulate the durable parent deletion succeeding while derived-row cleanup fails.
        yield* sql`DELETE FROM voice_runtime_authorities
          WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
        yield* store.revokeRuntime(authSessionId, runtimeId);

        expect(yield* store.authorize(operationId, claimInput.tokenHash, now)).toBeUndefined();
        expect(
          yield* store.readEventPage(operationId, claimInput.tokenHash, now, 0, 100),
        ).toBeUndefined();
        expect(yield* store.acknowledge(operationId, claimInput.tokenHash, ackInput(1), now)).toBe(
          "revoked",
        );
        expect(yield* store.cancel(operationId, claimInput.tokenHash, nowIso, now)).toBe("revoked");
        expect(yield* store.get(operationId)).toMatchObject({
          phase: "waiting",
          dispatchAccepted: true,
          detachedAt: expect.any(String),
        });
        expect(yield* store.getReceiptCorrelation(operationId)).toMatchObject({
          operationId,
          userMessageId: "message",
          detachedAt: expect.any(String),
        });
        expect(
          yield* store.appendEvent(operationId, {
            type: "phase",
            occurredAt: nowIso,
            phase: "speaking",
          }),
        ).toMatchObject({ type: "phase", phase: "speaking" });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("allows a dispatched voice operation to stop without retracting the thread turn", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "lease",
        now,
        now + 1_000,
        nowIso,
      );
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease", now, nowIso);
      yield* store.acceptDispatch({
        operationId,
        tokenHash: claimInput.tokenHash,
        leaseToken: "lease",
        occurredAt: nowIso,
        commandId: CommandId.make("command"),
        messageId: MessageId.make("message"),
      });
      expect(yield* store.cancel(operationId, claimInput.tokenHash, nowIso, now)).toBe(
        "dispatch-committed",
      );
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "waiting",
        dispatchAccepted: true,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not resurrect an expired idempotent operation", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim({ ...claimInput, operationTokenExpiresAt: now + 100 });
      const retried = yield* store.claim({
        ...claimInput,
        tokenHash: "replacement-token",
        nowEpochMillis: now + 101,
        operationTokenExpiresAt: now + 60_000,
      });
      expect(retried.status).toBe("expired");
      expect(yield* store.authorize(operationId, "replacement-token", now + 101)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects replay when immutable runtime turn identity or policy changes", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      expect((yield* store.claim(claimInput)).status).toBe("claimed");
      expect(
        (yield* store.claim({
          ...claimInput,
          modeSessionId: VoiceModeSessionId.make("different-mode"),
        })).status,
      ).toBe("mismatch");
      expect(
        (yield* store.claim({
          ...claimInput,
          submissionPolicy: "draft",
        })).status,
      ).toBe("mismatch");
      expect(
        (yield* store.claim({
          ...claimInput,
          speechPlanId: VoiceSpeechPlanId.make("different-plan"),
        })).status,
      ).toBe("mismatch");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("records assistant correlation in stable first-seen order", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      const correlated = yield* store.recordAssistantMessages(operationId, [
        {
          messageId: MessageId.make("assistant-b"),
          firstSeenSequence: 20,
          createdAt: nowIso,
        },
        {
          messageId: MessageId.make("assistant-a"),
          firstSeenSequence: 10,
          createdAt: nowIso,
        },
        {
          messageId: MessageId.make("assistant-a"),
          firstSeenSequence: 99,
          createdAt: nowIso,
        },
      ]);
      expect(correlated.map((entry) => entry.messageId)).toEqual(["assistant-a", "assistant-b"]);
      expect(correlated.map((entry) => entry.firstSeenSequence)).toEqual([10, 20]);
      expect(yield* store.getReceiptCorrelation(operationId)).toMatchObject({
        modeSessionId: "mode-session",
        turnClientOperationId: "client-operation",
        assistantMessageIds: ["assistant-a", "assistant-b"],
        speechPlanId: "speech-plan",
        highestAdvertisedSegment: null,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "makes draft completion mutually exclusive with dispatch and consumes to a tombstone",
    () =>
      Effect.gen(function* () {
        yield* initialize;
        const store = yield* VoiceThreadTurnStore;
        const draftId = VoiceDraftArtifactId.make("draft-artifact");
        yield* store.claim({ ...claimInput, submissionPolicy: "draft" });
        yield* store.claimProcessing(
          operationId,
          claimInput.tokenHash,
          "draft-lease",
          now,
          now + 1_000,
          nowIso,
        );
        yield* store.appendEvent(
          operationId,
          { type: "phase", occurredAt: nowIso, phase: "transcribing" },
          { phase: "transcribing" },
        );
        expect(
          yield* store.beginDispatch(operationId, claimInput.tokenHash, "draft-lease", now, nowIso),
        ).toBe(false);
        expect(
          yield* store.completeDraft({
            operationId,
            tokenHash: claimInput.tokenHash,
            leaseToken: "draft-lease",
            draftId,
            cipherVersion: 1,
            nonce: new Uint8Array([1, 2, 3]),
            ciphertext: new Uint8Array([4, 5, 6]),
            expiresAt: now + 10_000,
            occurredAt: nowIso,
          }),
        ).toBe("completed");
        expect(yield* store.readDraft(operationId)).toMatchObject({
          draftId,
          state: "ready",
          cipherVersion: 1,
        });
        expect(yield* store.cancel(operationId, claimInput.tokenHash, nowIso, now)).toBe(
          "terminal",
        );
        expect(
          yield* store.consumeDraft(operationId, draftId, claimInput.tokenHash, now, nowIso),
        ).toBe("consumed");
        expect(
          yield* store.consumeDraft(operationId, draftId, claimInput.tokenHash, now, nowIso),
        ).toBe("already-consumed");
        expect(yield* store.readDraft(operationId)).toMatchObject({
          state: "consumed",
          nonce: null,
          ciphertext: null,
        });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("expires draft ciphertext to a tombstone and persists detach once", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const draftId = VoiceDraftArtifactId.make("expiring-draft");
      yield* store.claim({ ...claimInput, submissionPolicy: "draft" });
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "draft-lease",
        now,
        now + 1_000,
        nowIso,
      );
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* store.completeDraft({
        operationId,
        tokenHash: claimInput.tokenHash,
        leaseToken: "draft-lease",
        draftId,
        cipherVersion: 1,
        nonce: new Uint8Array([1]),
        ciphertext: new Uint8Array([2]),
        expiresAt: now + 100,
        occurredAt: nowIso,
      });
      expect(yield* store.expireDrafts(now + 99)).toEqual([]);
      expect(
        yield* store.consumeDraft(operationId, draftId, claimInput.tokenHash, now + 100, nowIso),
      ).toBe("expired");
      expect(yield* store.expireDrafts(now + 100)).toEqual([]);
      expect(yield* store.readDraft(operationId)).toMatchObject({
        state: "expired",
        nonce: null,
        ciphertext: null,
      });
      expect(
        yield* store.detach(operationId, claimInput.tokenHash, now, "2026-07-13T12:00:01.000Z"),
      ).toBe("detached");
      expect(
        yield* store.detach(operationId, claimInput.tokenHash, now, "2026-07-13T12:00:02.000Z"),
      ).toBe("detached");
      expect((yield* store.get(operationId))?.detachedAt).toBe("2026-07-13T12:00:01.000Z");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("validates an existing speech segment instead of silently accepting conflicts", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
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
        yield* store.acknowledge(
          operationId,
          claimInput.tokenHash,
          {
            ...ackInput(2),
            highestStartedSegment: 0,
            highestDrainedSegment: 0,
            segmentDispositions: [{ segmentIndex: 0, disposition: "drained" }],
          },
          now,
        ),
      ).toBe("acknowledged");
      expect(yield* store.getReceiptCorrelation(operationId)).toMatchObject({
        runtimeInstanceId,
        highestAdvertisedSegment: 0,
        highestStartedSegment: 0,
        highestDrainedSegment: 0,
        segmentDispositions: [{ segmentIndex: 0, disposition: "drained" }],
      });
      expect(
        yield* store.acknowledge(
          operationId,
          claimInput.tokenHash,
          {
            ...ackInput(2),
            highestStartedSegment: 0,
            highestDrainedSegment: 0,
            segmentDispositions: [{ segmentIndex: 0, disposition: "failed" }],
          },
          now,
        ),
      ).toBe("invalid");
      expect(
        yield* store.putSpeechSegmentAndEvent({
          ...segment,
          sourceTextSha256: "digest-b",
        }),
      ).toBe("mismatch");
      expect(
        (yield* store.listEvents(operationId, 0, 100)).filter((e) => e.type === "speech-ready"),
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retrieves speech from its immutable orchestration event revision", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
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

  it.effect("fences durable completion after an idempotent token rotation", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const draftId = VoiceDraftArtifactId.make("rotated-draft");
      yield* store.claim({ ...claimInput, submissionPolicy: "draft" });
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "draft-lease",
        now,
        now + 1_000,
        nowIso,
      );
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* store.claim({
        ...claimInput,
        submissionPolicy: "draft",
        tokenHash: "rotated-operation-token-hash",
      });
      expect(
        yield* store.completeDraft({
          operationId,
          tokenHash: claimInput.tokenHash,
          leaseToken: "draft-lease",
          draftId,
          cipherVersion: 1,
          nonce: new Uint8Array([1]),
          ciphertext: new Uint8Array([2]),
          expiresAt: now + 1_000,
          occurredAt: nowIso,
        }),
      ).toBe("invalid");
      expect(
        yield* store.readDraftAuthorized(operationId, claimInput.tokenHash, now, nowIso),
      ).toEqual({ status: "revoked" });
      expect(yield* store.detach(operationId, claimInput.tokenHash, now, nowIso)).toBe("revoked");
      expect(
        yield* store.getSpeechSegmentAuthorized(operationId, 0, claimInput.tokenHash, now),
      ).toEqual({ status: "revoked" });
      expect(yield* store.readDraft(operationId)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves leased dispatching work and expires accepted work with its capability", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim({ ...claimInput, operationTokenExpiresAt: now + 100 });
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "lease",
        now,
        now + 1_000,
        nowIso,
      );
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      expect(
        yield* store.beginDispatch(operationId, claimInput.tokenHash, "lease", now, nowIso),
      ).toBe(true);
      expect(yield* store.expireAndPurge(now + 101, nowIso, now - 1)).toEqual([]);
      expect(yield* store.get(operationId)).toMatchObject({ phase: "dispatching" });
      expect(
        yield* store.acceptDispatch({
          operationId,
          tokenHash: claimInput.tokenHash,
          leaseToken: "lease",
          occurredAt: nowIso,
          commandId: CommandId.make("expiry-command"),
          messageId: MessageId.make("expiry-message"),
        }),
      ).toBe(true);
      expect(yield* store.listRecoverableOperationIds(now + 50)).toEqual([operationId]);
      expect(yield* store.expireAndPurge(now + 102, nowIso, now - 1)).toEqual([operationId]);
      expect(yield* store.listRecoverableOperationIds(now + 102)).toEqual([]);
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "failed",
        dispatchAccepted: true,
      });
      const replacementOperationId = VoiceThreadTurnOperationId.make(
        "native-thread-operation-after-expiry",
      );
      expect(
        yield* store.claim({
          ...claimInput,
          operationId: replacementOperationId,
          turnClientOperationId: VoiceTurnClientOperationId.make("client-operation-after-expiry"),
          tokenHash: "operation-token-hash-after-expiry",
          nowEpochMillis: now + 102,
        }),
      ).toMatchObject({ status: "claimed", operation: { operationId: replacementOperationId } });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("atomically tombstones a draft read at exact expiry", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      const draftId = VoiceDraftArtifactId.make("read-expiring-draft");
      yield* store.claim({ ...claimInput, submissionPolicy: "draft" });
      yield* store.claimProcessing(
        operationId,
        claimInput.tokenHash,
        "draft-lease",
        now,
        now + 1_000,
        nowIso,
      );
      yield* store.appendEvent(
        operationId,
        { type: "phase", occurredAt: nowIso, phase: "transcribing" },
        { phase: "transcribing" },
      );
      yield* store.completeDraft({
        operationId,
        tokenHash: claimInput.tokenHash,
        leaseToken: "draft-lease",
        draftId,
        cipherVersion: 1,
        nonce: new Uint8Array([1]),
        ciphertext: new Uint8Array([2]),
        expiresAt: now + 100,
        occurredAt: nowIso,
      });
      expect(
        yield* store.readDraftAuthorized(operationId, claimInput.tokenHash, now + 100, nowIso),
      ).toEqual({ status: "unavailable" });
      expect(yield* store.readDraft(operationId)).toMatchObject({
        state: "expired",
        nonce: null,
        ciphertext: null,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("atomically fences segment publication and retrieval after detach", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      const segment = {
        operationId,
        segmentIndex: 0,
        assistantMessageId: MessageId.make("detached-assistant"),
        startOffset: 0,
        endOffset: 5,
        finalSegment: false,
        sourceEventSequence: 1,
        sourceTextSha256: "detached-digest",
        createdAt: nowIso,
      };
      expect(yield* store.putSpeechSegmentAndEvent(segment)).toBe("inserted");
      expect(yield* store.detach(operationId, claimInput.tokenHash, now, nowIso)).toBe("detached");
      expect(
        yield* store.putSpeechSegmentAndEvent({
          ...segment,
          segmentIndex: 1,
          startOffset: 5,
          endOffset: 10,
        }),
      ).toBe("detached");
      expect(
        yield* store.getSpeechSegmentAuthorized(operationId, 0, claimInput.tokenHash, now),
      ).toEqual({ status: "detached" });
      expect(yield* store.getSpeechSegment(operationId, 1)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects contradictory and gapped playback acknowledgements", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      const segment = {
        operationId,
        assistantMessageId: MessageId.make("ack-assistant"),
        startOffset: 0,
        endOffset: 5,
        finalSegment: false,
        sourceEventSequence: 1,
        sourceTextSha256: "ack-digest",
        createdAt: nowIso,
      };
      yield* store.putSpeechSegmentAndEvent({ ...segment, segmentIndex: 0 });
      yield* store.putSpeechSegmentAndEvent({
        ...segment,
        segmentIndex: 2,
        startOffset: 10,
        endOffset: 15,
      });
      const invalidReports = [
        { highestStartedSegment: 0, highestDrainedSegment: 0, segmentDispositions: [] },
        {
          highestStartedSegment: 0,
          highestDrainedSegment: null,
          segmentDispositions: [{ segmentIndex: 0, disposition: "drained" as const }],
        },
        {
          highestStartedSegment: 0,
          highestDrainedSegment: null,
          segmentDispositions: [{ segmentIndex: 1, disposition: "failed" as const }],
        },
        {
          highestStartedSegment: 2,
          highestDrainedSegment: 0,
          segmentDispositions: [{ segmentIndex: 0, disposition: "drained" as const }],
        },
      ];
      for (const report of invalidReports)
        expect(
          yield* store.acknowledge(
            operationId,
            claimInput.tokenHash,
            { ...ackInput(3), ...report },
            now,
          ),
        ).toBe("invalid");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("accepts playback continuing after an interrupted segment", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim(claimInput);
      const segment = {
        operationId,
        assistantMessageId: MessageId.make("recovery-assistant"),
        startOffset: 0,
        endOffset: 5,
        finalSegment: false,
        sourceEventSequence: 1,
        sourceTextSha256: "recovery-digest",
        createdAt: nowIso,
      };
      yield* store.putSpeechSegmentAndEvent({ ...segment, segmentIndex: 0 });
      yield* store.putSpeechSegmentAndEvent({
        ...segment,
        segmentIndex: 1,
        startOffset: 5,
        endOffset: 10,
      });
      expect(
        yield* store.acknowledge(
          operationId,
          claimInput.tokenHash,
          {
            ...ackInput(3),
            highestStartedSegment: 0,
            highestDrainedSegment: null,
            segmentDispositions: [{ segmentIndex: 0, disposition: "interrupted" }],
          },
          now,
        ),
      ).toBe("acknowledged");
      expect(
        yield* store.acknowledge(
          operationId,
          claimInput.tokenHash,
          {
            ...ackInput(3),
            highestStartedSegment: 1,
            highestDrainedSegment: 1,
            segmentDispositions: [
              { segmentIndex: 0, disposition: "interrupted" },
              { segmentIndex: 1, disposition: "drained" },
            ],
          },
          now,
        ),
      ).toBe("acknowledged");
      expect(yield* store.getReceiptCorrelation(operationId)).toMatchObject({
        highestStartedSegment: 1,
        highestDrainedSegment: 1,
        segmentDispositions: [
          { segmentIndex: 0, disposition: "interrupted" },
          { segmentIndex: 1, disposition: "drained" },
        ],
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("durably finalizes expiry and purges terminal records after retention", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* VoiceThreadTurnStore;
      yield* store.claim({
        ...claimInput,
        operationTokenExpiresAt: now + 100,
        retentionExpiresAt: now + 100,
      });
      expect(yield* store.expireAndPurge(now + 101, nowIso, now - 1)).toEqual([operationId]);
      expect(yield* store.get(operationId)).toMatchObject({
        phase: "failed",
        speechTerminal: "failed",
      });
      expect(yield* store.listEvents(operationId, 0, 100)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "failure",
            code: "operation-expired",
          }),
          expect.objectContaining({ type: "terminal", outcome: "failed" }),
        ]),
      );
      yield* store.expireAndPurge(now + 102, nowIso, now + 101);
      expect(yield* store.get(operationId)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );
});

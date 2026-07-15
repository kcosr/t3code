import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
  VoiceSpeechPlanId,
  VoiceThreadTurnOperationId,
  VoiceTurnClientOperationId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { VoiceRealtimeTransitionReservationRepository } from "../Services/VoiceRealtimeTransitionReservations.ts";
import { VoiceRuntimeAuthorityRepository } from "../Services/VoiceRuntimeAuthorities.ts";
import { VoiceRuntimeRealtimeStartRepository } from "../Services/VoiceRuntimeRealtimeStarts.ts";
import { VoiceThreadTurnStore } from "../Services/VoiceThreadTurns.ts";
import { VoiceRealtimeTransitionReservationRepositoryLive } from "./VoiceRealtimeTransitionReservations.ts";
import { VoiceRuntimeAuthorityRepositoryLive } from "./VoiceRuntimeAuthorities.ts";
import { VoiceRuntimeRealtimeStartRepositoryLive } from "./VoiceRuntimeRealtimeStarts.ts";
import { VoiceThreadTurnStoreLive } from "./VoiceThreadTurns.ts";

const sqlite = NodeSqliteClient.layerMemory();
const layer = Layer.mergeAll(
  sqlite,
  VoiceRuntimeAuthorityRepositoryLive.pipe(Layer.provide(sqlite)),
  VoiceRealtimeTransitionReservationRepositoryLive.pipe(Layer.provide(sqlite)),
  VoiceRuntimeRealtimeStartRepositoryLive.pipe(Layer.provide(sqlite)),
  VoiceThreadTurnStoreLive.pipe(Layer.provide(sqlite)),
);
const authSessionId = AuthSessionId.make("voice-authority-session");
const runtimeId = VoiceRuntimeId.make("android-main");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("android-instance");
const sourceSessionId = VoiceSessionId.make("voice-session");
const actionId = VoiceClientActionId.make("handoff-action");
const modeSessionId = VoiceModeSessionId.make("thread-mode");
const realtimeTarget = {
  mode: "realtime" as const,
  environmentId: EnvironmentId.make("environment-1"),
  conversationId: VoiceConversationId.make("conversation-1"),
};
const threadTarget = {
  mode: "thread" as const,
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  speechPreset: "default" as const,
  autoRearm: true,
  endpointPolicy: {
    endSilenceMs: 2_200,
    noSpeechTimeoutMs: null,
    maximumUtteranceMs: 600_000,
  },
  speechEnabled: true,
  rearmGuardMs: 500,
};

const initialize = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 56 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_runtime_realtime_transition_grants`;
  yield* sql`DELETE FROM auth_sessions WHERE session_id = ${authSessionId}`;
  yield* sql`INSERT INTO auth_sessions (
    session_id, subject, scopes, method, client_device_type, issued_at, expires_at
  ) VALUES (
    ${authSessionId}, 'voice-authority-test', '["voice:use"]',
    'bearer-access-token', 'mobile',
    '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
  )`;
});

describe.sequential("VoiceRuntimeAuthorityRepository", () => {
  it.effect("applies strict generation CAS and idempotently replays the same target", () =>
    Effect.gen(function* () {
      yield* initialize;
      const authorities = yield* VoiceRuntimeAuthorityRepository;
      const input = {
        authSessionId,
        runtimeId,
        expectedCurrentGeneration: 0,
        generation: 1,
        target: realtimeTarget,
      };

      expect(
        (yield* authorities.configure({ ...input, expectedCurrentGeneration: 2, generation: 3 }, 5))
          .status,
      ).toBe("stale");
      expect((yield* authorities.configure(input, 10)).status).toBe("configured");
      expect((yield* authorities.configure(input, 20)).status).toBe("existing");
      expect(
        (yield* authorities.configure(
          {
            ...input,
            target: {
              ...realtimeTarget,
              conversationId: VoiceConversationId.make("other"),
            },
          },
          30,
        )).status,
      ).toBe("stale");
      expect(
        (yield* authorities.configure(
          { ...input, expectedCurrentGeneration: 1, generation: 3 },
          40,
        )).status,
      ).toBe("stale");
      expect(yield* authorities.find(authSessionId, runtimeId)).toMatchObject({
        generation: 1,
        target: realtimeTarget,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("survives a crash between handoff exchange and commit with exactly-once replay", () =>
    Effect.gen(function* () {
      yield* initialize;
      const authorities = yield* VoiceRuntimeAuthorityRepository;
      const reservations = yield* VoiceRealtimeTransitionReservationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* authorities.configure(
        {
          authSessionId,
          runtimeId,
          expectedCurrentGeneration: 0,
          generation: 1,
          target: realtimeTarget,
        },
        10,
      );
      const reservation = {
        authSessionId,
        sourceSessionId,
        sourceLeaseGeneration: 2,
        actionId,
        actionSequence: 7,
        runtimeId,
        runtimeInstanceId,
        sourceGeneration: 1,
        nextGeneration: 2,
        modeSessionId,
        target: threadTarget,
      };
      expect((yield* reservations.claim(reservation, 20)).status).toBe("claimed");
      expect(
        yield* sql<{ readonly consumedAt: number | null }>`SELECT consumed_at AS "consumedAt"
          FROM voice_runtime_realtime_transition_grants
          WHERE source_session_id = ${sourceSessionId} AND action_id = ${actionId}`,
      ).toEqual([{ consumedAt: null }]);
      const commit = {
        authSessionId,
        runtimeId,
        runtimeInstanceId,
        sourceSessionId,
        sourceLeaseGeneration: 2,
        actionId,
        actionSequence: 7,
        sourceGeneration: 1,
        nextGeneration: 2,
        modeSessionId,
      };

      expect(yield* authorities.consumeHandoff(commit, 30)).toEqual({
        status: "consumed",
        target: threadTarget,
      });
      expect(
        yield* sql<{ readonly consumedAt: number | null }>`SELECT consumed_at AS "consumedAt"
          FROM voice_runtime_realtime_transition_grants
          WHERE source_session_id = ${sourceSessionId} AND action_id = ${actionId}`,
      ).toEqual([{ consumedAt: 30 }]);
      expect(yield* authorities.consumeHandoff(commit, 40)).toEqual({
        status: "existing",
        target: threadTarget,
      });
      expect(
        yield* sql<{ readonly consumedAt: number | null }>`SELECT consumed_at AS "consumedAt"
          FROM voice_runtime_realtime_transition_grants
          WHERE source_session_id = ${sourceSessionId} AND action_id = ${actionId}`,
      ).toEqual([{ consumedAt: 30 }]);
      expect(yield* authorities.find(authSessionId, runtimeId)).toMatchObject({
        generation: 2,
        target: threadTarget,
      });
      expect(yield* authorities.clearRuntime(authSessionId, runtimeId)).toBe(true);
      expect(yield* authorities.find(authSessionId, runtimeId)).toBeUndefined();
      expect(
        yield* sql`SELECT 1 FROM voice_runtime_realtime_transition_grants
          WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("cascades replacement into child retirement and close-only realtime cleanup", () =>
    Effect.gen(function* () {
      yield* initialize;
      const authorities = yield* VoiceRuntimeAuthorityRepository;
      const starts = yield* VoiceRuntimeRealtimeStartRepository;
      const turns = yield* VoiceThreadTurnStore;
      yield* authorities.configure(
        {
          authSessionId,
          runtimeId,
          expectedCurrentGeneration: 0,
          generation: 1,
          target: threadTarget,
        },
        10,
      );
      const startBase = {
        authSessionId,
        runtimeId,
        runtimeInstanceId,
        runtimeGeneration: 1,
        modeSessionId,
        conversationId: VoiceConversationId.make("conversation-1"),
        claimExpiresAt: 10_000,
        expiresAt: 100_000,
        now: 1_000,
      };
      yield* starts.claim({
        ...startBase,
        operationKey: "unbound-start",
        clientOperationId: "unbound-start",
      });
      yield* starts.claim({
        ...startBase,
        operationKey: "bound-start",
        clientOperationId: "bound-start",
      });
      const boundSessionId = VoiceSessionId.make("bound-voice-session");
      yield* starts.bindSession("bound-start", boundSessionId, 3, 2_000);

      const turnBase = {
        authSessionId,
        runtimeId,
        runtimeInstanceId,
        runtimeGeneration: 1,
        modeSessionId,
        projectId: threadTarget.projectId,
        threadId: threadTarget.threadId,
        speechPreset: threadTarget.speechPreset,
        speechEnabled: threadTarget.speechEnabled,
        autoRearm: threadTarget.autoRearm,
        submissionPolicy: "auto-submit" as const,
        speechPlanId: VoiceSpeechPlanId.make("speech-plan"),
        operationTokenExpiresAt: 100_000,
        retentionExpiresAt: 200_000,
        nowEpochMillis: 1_000,
        now: "2026-07-15T00:00:00.000Z",
      };
      const pendingId = VoiceThreadTurnOperationId.make("pending-turn");
      const dispatchedId = VoiceThreadTurnOperationId.make("dispatched-turn");
      const sql = yield* SqlClient.SqlClient;
      yield* turns.claim({
        ...turnBase,
        operationId: pendingId,
        turnClientOperationId: VoiceTurnClientOperationId.make("pending-turn"),
        tokenHash: "pending-owner",
      });
      yield* sql`UPDATE voice_thread_turn_operations SET active_slot = NULL
        WHERE operation_id = ${pendingId}`;
      yield* turns.claim({
        ...turnBase,
        operationId: dispatchedId,
        turnClientOperationId: VoiceTurnClientOperationId.make("dispatched-turn"),
        tokenHash: "dispatched-owner",
      });
      yield* sql`UPDATE voice_thread_turn_operations
        SET dispatch_accepted = 1, phase = 'waiting'
        WHERE operation_id = ${dispatchedId}`;

      expect(
        (yield* authorities.configure(
          {
            authSessionId,
            runtimeId,
            expectedCurrentGeneration: 1,
            generation: 2,
            target: { ...threadTarget, threadId: ThreadId.make("thread-2") },
          },
          20,
        )).status,
      ).toBe("configured");
      expect(yield* turns.get(pendingId)).toMatchObject({
        phase: "cancelled",
        detachedAt: expect.any(String),
      });
      expect(yield* turns.get(dispatchedId)).toMatchObject({
        phase: "waiting",
        detachedAt: expect.any(String),
      });
      expect(yield* starts.findBySession(boundSessionId, 3_000)).toMatchObject({
        closeOnly: true,
      });
      expect(
        yield* sql`SELECT 1 FROM voice_runtime_realtime_starts
          WHERE operation_key = 'unbound-start'`,
      ).toHaveLength(0);

      yield* authorities.clearAuthSession(authSessionId);
      expect(yield* starts.findBySession(boundSessionId, 3_000)).toBeUndefined();
    }).pipe(Effect.provide(layer)),
  );
});

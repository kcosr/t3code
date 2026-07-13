import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VoiceHandoffActionRepositoryLive } from "./VoiceHandoffActions.ts";
import {
  VoiceHandoffActionConflictError,
  VoiceHandoffActionOwnershipError,
  VoiceHandoffActionRepository,
} from "../Services/VoiceHandoffActions.ts";

const persistence = VoiceHandoffActionRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const layer = it.layer(persistence);

const identity = {
  actionId: "action-1",
  authSessionId: "auth-1",
  realtimeSessionId: "realtime-1",
  realtimeGeneration: 2,
  conversationId: "conversation-1",
  contextEpoch: 1,
  projectId: "project-1",
  threadId: "thread-1",
  autoRearm: true,
  createdAt: "2026-07-12T10:00:00.000Z",
  expiresAt: "2026-07-12T10:01:00.000Z",
} as const;

const seedConversation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_handoff_actions`;
  yield* sql`DELETE FROM voice_conversations WHERE conversation_id = 'conversation-1'`;
  yield* sql`
    INSERT INTO voice_conversations (
      conversation_id, retention, title, active_epoch, next_entry_sequence,
      created_at, updated_at, last_call_at
    ) VALUES (
      'conversation-1', 'durable', NULL, 1, 1,
      '2026-07-12T10:00:00.000Z', '2026-07-12T10:00:00.000Z', NULL
    )
  `;
});

layer("VoiceHandoffActionRepository", (it) => {
  it.effect("creates idempotently and rejects an action id with different identity", () =>
    Effect.gen(function* () {
      yield* seedConversation;
      const repository = yield* VoiceHandoffActionRepository;
      const first = yield* repository.create(identity);
      assert.equal(first.status, "prepared");
      const repeated = yield* repository.create(identity);
      assert.deepStrictEqual(repeated, first);
      const retriedLater = yield* repository.create({
        ...identity,
        createdAt: "2026-07-12T10:00:05.000Z",
        expiresAt: "2026-07-12T10:01:05.000Z",
      });
      assert.deepStrictEqual(retriedLater, first);
      const activated = yield* repository.activate({
        actionId: identity.actionId,
        activatedAt: "2026-07-12T10:00:10.000Z",
        expiresAt: "2026-07-12T10:02:00.000Z",
      });
      assert.equal(activated.status, "pending");
      assert.deepStrictEqual(
        yield* repository.activate({
          actionId: identity.actionId,
          activatedAt: "2026-07-12T10:00:15.000Z",
          expiresAt: "2026-07-12T10:03:00.000Z",
        }),
        activated,
      );

      const conflict = yield* Effect.flip(repository.create({ ...identity, threadId: "thread-2" }));
      assert.instanceOf(conflict, VoiceHandoffActionConflictError);
    }),
  );

  it.effect("lists only unexpired pending actions for the owning auth session", () =>
    Effect.gen(function* () {
      yield* seedConversation;
      const repository = yield* VoiceHandoffActionRepository;
      yield* repository.create(identity);
      assert.lengthOf(
        yield* repository.listPending({
          authSessionId: "auth-1",
          realtimeSessionId: identity.realtimeSessionId,
          realtimeGeneration: identity.realtimeGeneration,
          now: "2026-07-12T10:00:01.000Z",
          limit: 10,
        }),
        0,
      );
      yield* repository.activate({
        actionId: identity.actionId,
        activatedAt: identity.createdAt,
        expiresAt: identity.expiresAt,
      });
      assert.lengthOf(
        yield* repository.listPending({
          authSessionId: "auth-1",
          realtimeSessionId: identity.realtimeSessionId,
          realtimeGeneration: identity.realtimeGeneration,
          now: "2026-07-12T10:00:30.000Z",
          limit: 10,
        }),
        1,
      );
      assert.lengthOf(
        yield* repository.listPending({
          authSessionId: "other-auth",
          realtimeSessionId: identity.realtimeSessionId,
          realtimeGeneration: identity.realtimeGeneration,
          now: "2026-07-12T10:00:30.000Z",
          limit: 10,
        }),
        0,
      );
      assert.lengthOf(
        yield* repository.listPending({
          authSessionId: "auth-1",
          realtimeSessionId: "other-realtime",
          realtimeGeneration: identity.realtimeGeneration,
          now: "2026-07-12T10:00:30.000Z",
          limit: 10,
        }),
        0,
      );
      assert.lengthOf(
        yield* repository.listPending({
          authSessionId: "auth-1",
          realtimeSessionId: identity.realtimeSessionId,
          realtimeGeneration: identity.realtimeGeneration + 1,
          now: "2026-07-12T10:00:30.000Z",
          limit: 10,
        }),
        0,
      );
      assert.lengthOf(
        yield* repository.listPending({
          authSessionId: "auth-1",
          realtimeSessionId: identity.realtimeSessionId,
          realtimeGeneration: identity.realtimeGeneration,
          now: identity.expiresAt,
          limit: 10,
        }),
        0,
      );
    }),
  );

  it.effect("acknowledges idempotently and fences ownership and conflicting outcomes", () =>
    Effect.gen(function* () {
      yield* seedConversation;
      const repository = yield* VoiceHandoffActionRepository;
      yield* repository.create(identity);
      yield* repository.activate({
        actionId: identity.actionId,
        activatedAt: identity.createdAt,
        expiresAt: identity.expiresAt,
      });
      const result = {
        outcome: "succeeded" as const,
        outcomeState: "listening",
        outcomeStage: null,
        outcomeReason: null,
      };
      const ownership = yield* Effect.flip(
        repository.acknowledge({
          actionId: identity.actionId,
          authSessionId: "other-auth",
          result,
          acknowledgedAt: "2026-07-12T10:00:20.000Z",
        }),
      );
      assert.instanceOf(ownership, VoiceHandoffActionOwnershipError);

      const settled = yield* repository.acknowledge({
        actionId: identity.actionId,
        authSessionId: identity.authSessionId,
        result,
        acknowledgedAt: "2026-07-12T10:00:20.000Z",
      });
      assert.equal(settled.status, "settled");
      assert.deepStrictEqual(
        yield* repository.acknowledge({
          actionId: identity.actionId,
          authSessionId: identity.authSessionId,
          result,
          acknowledgedAt: "2026-07-12T10:00:25.000Z",
        }),
        settled,
      );
      const conflict = yield* Effect.flip(
        repository.acknowledge({
          actionId: identity.actionId,
          authSessionId: identity.authSessionId,
          result: {
            ...result,
            outcome: "failed",
            outcomeState: null,
            outcomeReason: "busy",
          },
          acknowledgedAt: "2026-07-12T10:00:30.000Z",
        }),
      );
      assert.instanceOf(conflict, VoiceHandoffActionConflictError);
    }),
  );

  it.effect("terminalizes expired actions without deleting their outcome", () =>
    Effect.gen(function* () {
      yield* seedConversation;
      const repository = yield* VoiceHandoffActionRepository;
      yield* repository.create(identity);
      yield* repository.activate({
        actionId: identity.actionId,
        activatedAt: identity.createdAt,
        expiresAt: identity.expiresAt,
      });
      const expired = yield* repository.expire({ now: identity.expiresAt });
      assert.lengthOf(expired, 1);
      assert.equal(expired[0]?.status, "expired");
      assert.equal(expired[0]?.outcome, "failed");
      assert.equal(expired[0]?.outcomeStage, "recognition-start");
      assert.equal(expired[0]?.outcomeReason, "operation-timeout");
      assert.isTrue(Option.isSome(yield* repository.get(identity.actionId)));
      assert.lengthOf(yield* repository.expire({ now: identity.expiresAt }), 0);
    }),
  );

  it.effect("surfaces a canonical expiry when acknowledgement arrives after the deadline", () =>
    Effect.gen(function* () {
      yield* seedConversation;
      const repository = yield* VoiceHandoffActionRepository;
      yield* repository.create(identity);
      yield* repository.activate({
        actionId: identity.actionId,
        activatedAt: identity.createdAt,
        expiresAt: identity.expiresAt,
      });
      const expired = yield* repository.acknowledge({
        actionId: identity.actionId,
        authSessionId: identity.authSessionId,
        result: {
          outcome: "succeeded",
          outcomeState: "listening",
          outcomeStage: null,
          outcomeReason: null,
        },
        acknowledgedAt: "2026-07-12T10:01:01.000Z",
      });
      assert.equal(expired.status, "expired");
      assert.equal(expired.outcome, "failed");
      assert.equal(expired.outcomeStage, "recognition-start");
      assert.equal(expired.outcomeReason, "operation-timeout");
      assert.deepStrictEqual(
        yield* repository.acknowledge({
          actionId: identity.actionId,
          authSessionId: identity.authSessionId,
          result: {
            outcome: "succeeded",
            outcomeState: "listening",
            outcomeStage: null,
            outcomeReason: null,
          },
          acknowledgedAt: "2026-07-12T10:01:02.000Z",
        }),
        expired,
      );
    }),
  );

  it.effect("allows only one of two concurrent conflicting acknowledgements", () =>
    Effect.gen(function* () {
      yield* seedConversation;
      const repository = yield* VoiceHandoffActionRepository;
      yield* repository.create(identity);
      yield* repository.activate({
        actionId: identity.actionId,
        activatedAt: identity.createdAt,
        expiresAt: identity.expiresAt,
      });
      const outcomes = yield* Effect.exit(
        Effect.all(
          [
            repository.acknowledge({
              actionId: identity.actionId,
              authSessionId: identity.authSessionId,
              result: {
                outcome: "succeeded",
                outcomeState: "listening",
                outcomeStage: null,
                outcomeReason: null,
              },
              acknowledgedAt: "2026-07-12T10:00:20.000Z",
            }),
            repository.acknowledge({
              actionId: identity.actionId,
              authSessionId: identity.authSessionId,
              result: {
                outcome: "failed",
                outcomeState: null,
                outcomeStage: "audio-focus",
                outcomeReason: "busy",
              },
              acknowledgedAt: "2026-07-12T10:00:20.000Z",
            }),
          ],
          { concurrency: "unbounded" },
        ),
      );
      assert.equal(outcomes._tag, "Failure");
      const stored = yield* repository.get(identity.actionId);
      assert.isTrue(Option.isSome(stored));
      assert.equal(Option.getOrThrow(stored).status, "settled");
    }),
  );
});

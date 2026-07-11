import { VoiceConversationId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  EphemeralVoiceConversationPersistenceError,
  VoiceConversationAlreadyExistsError,
  VoiceConversationEntryConflictError,
  VoiceConversationEpochConflictError,
  VoiceConversationRepository,
} from "../Services/VoiceConversations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VoiceConversationRepositoryLive } from "./VoiceConversations.ts";

const layer = it.layer(
  VoiceConversationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const createdAt = "2026-07-10T12:00:00.000Z";
const conversationId = (suffix: string) => VoiceConversationId.make(`voice-conversation-${suffix}`);

layer("VoiceConversationRepository", (it) => {
  it.effect("creates, gets, and lists durable conversations", () =>
    Effect.gen(function* () {
      const repository = yield* VoiceConversationRepository;
      const firstId = conversationId("first");
      const secondId = conversationId("second");

      const first = yield* repository.create({
        conversationId: firstId,
        retention: "durable",
        title: "First conversation",
        createdAt,
      });
      yield* repository.create({
        conversationId: secondId,
        retention: "durable",
        title: null,
        createdAt: "2026-07-10T12:01:00.000Z",
      });

      assert.equal(first.activeEpoch, 1);
      assert.equal(first.retention, "durable");
      assert.equal(first.title, "First conversation");

      const loaded = yield* repository.get({ conversationId: firstId });
      assert.deepEqual(Option.getOrNull(loaded), first);

      const listed = yield* repository.list();
      assert.deepEqual(
        listed.map((conversation) => conversation.conversationId),
        [secondId, firstId],
      );

      const duplicate = yield* Effect.flip(
        repository.create({
          conversationId: firstId,
          retention: "durable",
          title: null,
          createdAt,
        }),
      );
      assert.instanceOf(duplicate, VoiceConversationAlreadyExistsError);

      const ephemeral = yield* Effect.flip(
        repository.create({
          conversationId: conversationId("ephemeral"),
          retention: "ephemeral",
          title: null,
          createdAt,
        }),
      );
      assert.instanceOf(ephemeral, EphemeralVoiceConversationPersistenceError);
    }),
  );

  it.effect("appends ordered entries idempotently and rejects changed reuse of an entry id", () =>
    Effect.gen(function* () {
      const repository = yield* VoiceConversationRepository;
      const id = conversationId("append");
      yield* repository.create({
        conversationId: id,
        retention: "durable",
        title: null,
        createdAt,
      });

      const firstInput = {
        entryId: "voice-entry-1",
        conversationId: id,
        expectedEpoch: 1 as const,
        kind: "transcript.user" as const,
        payload: { text: "hello" },
        occurredAt: "2026-07-10T12:00:01.000Z",
      };
      const first = yield* repository.append(firstInput);
      const duplicate = yield* repository.append(firstInput);
      const second = yield* repository.append({
        entryId: "voice-entry-2",
        conversationId: id,
        expectedEpoch: 1,
        kind: "transcript.assistant",
        payload: { text: "hi" },
        occurredAt: "2026-07-10T12:00:02.000Z",
      });

      assert.equal(first.sequence, 1);
      assert.deepEqual(duplicate, first);
      assert.equal(second.sequence, 2);

      const context = yield* repository.listContext({ conversationId: id });
      assert.deepEqual(
        context.map((entry) => entry.entryId),
        ["voice-entry-1", "voice-entry-2"],
      );
      assert.deepEqual(context[0]?.payload, { text: "hello" });

      const changedDuplicate = yield* Effect.flip(
        repository.append({ ...firstInput, payload: { text: "changed" } }),
      );
      assert.instanceOf(changedDuplicate, VoiceConversationEntryConflictError);
    }),
  );

  it.effect("clears context atomically and fences stale appenders", () =>
    Effect.gen(function* () {
      const repository = yield* VoiceConversationRepository;
      const id = conversationId("clear");
      yield* repository.create({
        conversationId: id,
        retention: "durable",
        title: null,
        createdAt,
      });
      yield* repository.append({
        entryId: "voice-entry-before-clear",
        conversationId: id,
        expectedEpoch: 1,
        kind: "transcript.user",
        payload: { text: "old context" },
        occurredAt: "2026-07-10T12:00:01.000Z",
      });

      const cleared = yield* repository.clearContext({
        conversationId: id,
        entryId: "voice-entry-clear-boundary",
        expectedEpoch: 1,
        clearedAt: "2026-07-10T12:00:02.000Z",
      });
      assert.equal(cleared.activeEpoch, 2);

      const retry = yield* repository.clearContext({
        conversationId: id,
        entryId: "voice-entry-clear-boundary",
        expectedEpoch: 1,
        clearedAt: "2026-07-10T12:00:02.000Z",
      });
      assert.equal(retry.activeEpoch, 2);

      const changedRetry = yield* Effect.flip(
        repository.clearContext({
          conversationId: id,
          entryId: "voice-entry-clear-boundary",
          expectedEpoch: 1,
          clearedAt: "2026-07-10T12:00:03.000Z",
        }),
      );
      assert.isTrue(Schema.is(VoiceConversationEntryConflictError)(changedRetry));

      const stale = yield* Effect.flip(
        repository.append({
          entryId: "voice-entry-stale",
          conversationId: id,
          expectedEpoch: 1,
          kind: "transcript.assistant",
          payload: { text: "late old-call response" },
          occurredAt: "2026-07-10T12:00:03.000Z",
        }),
      );
      assert.instanceOf(stale, VoiceConversationEpochConflictError);
      if (Schema.is(VoiceConversationEpochConflictError)(stale)) {
        assert.equal(stale.actualEpoch, 2);
      }

      const afterClear = yield* repository.append({
        entryId: "voice-entry-after-clear",
        conversationId: id,
        expectedEpoch: 2,
        kind: "transcript.user",
        payload: { text: "new context" },
        occurredAt: "2026-07-10T12:00:04.000Z",
      });
      assert.equal(afterClear.sequence, 3);

      const currentContext = yield* repository.listContext({ conversationId: id });
      assert.deepEqual(
        currentContext.map((entry) => entry.entryId),
        ["voice-entry-clear-boundary", "voice-entry-after-clear"],
      );
      assert.deepEqual(currentContext[0]?.payload, { previousEpoch: 1 });
    }),
  );

  it.effect("returns the most recent bounded context in chronological order", () =>
    Effect.gen(function* () {
      const repository = yield* VoiceConversationRepository;
      const id = conversationId("limit");
      yield* repository.create({
        conversationId: id,
        retention: "durable",
        title: null,
        createdAt,
      });
      for (let index = 1; index <= 4; index += 1) {
        yield* repository.append({
          entryId: `voice-entry-limit-${index}`,
          conversationId: id,
          expectedEpoch: 1,
          kind: "transcript.user",
          payload: { index },
          occurredAt: `2026-07-10T12:00:0${index}.000Z`,
        });
      }

      const context = yield* repository.listContext({ conversationId: id, limit: 2 });
      assert.deepEqual(
        context.map((entry) => entry.entryId),
        ["voice-entry-limit-3", "voice-entry-limit-4"],
      );
    }),
  );

  it.effect("hard deletes a conversation and cascades journal entries", () =>
    Effect.gen(function* () {
      const repository = yield* VoiceConversationRepository;
      const sql = yield* SqlClient.SqlClient;
      const id = conversationId("delete");
      yield* repository.create({
        conversationId: id,
        retention: "durable",
        title: null,
        createdAt,
      });
      yield* repository.append({
        entryId: "voice-entry-delete",
        conversationId: id,
        expectedEpoch: 1,
        kind: "summary",
        payload: { text: "sensitive summary" },
        occurredAt: "2026-07-10T12:00:01.000Z",
      });

      assert.isTrue(yield* repository.delete({ conversationId: id }));
      assert.isFalse(yield* repository.delete({ conversationId: id }));
      assert.isTrue(Option.isNone(yield* repository.get({ conversationId: id })));

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM voice_conversation_entries
        WHERE conversation_id = ${id}
      `;
      assert.equal(rows[0]?.count, 0);
    }),
  );
});

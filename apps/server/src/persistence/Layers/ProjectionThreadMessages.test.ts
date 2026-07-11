import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("lists bounded deterministic message pages with an exclusive cursor", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-message-page");
      const otherThreadId = ThreadId.make("thread-message-page-other");
      const rows = [
        ["message-1", "2026-02-28T18:00:00.000Z", false],
        ["message-2", "2026-02-28T18:01:00.000Z", false],
        ["message-3a", "2026-02-28T18:02:00.000Z", false],
        ["message-3b", "2026-02-28T18:02:00.000Z", false],
        ["message-4-streaming", "2026-02-28T18:03:00.000Z", true],
      ] as const;

      yield* Effect.forEach(rows, ([id, occurredAt, isStreaming]) =>
        repository.upsert({
          messageId: MessageId.make(id),
          threadId,
          turnId: null,
          role: id === "message-1" ? "user" : "assistant",
          text: id,
          isStreaming,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        }),
      );
      yield* repository.upsert({
        messageId: MessageId.make("message-other-thread"),
        threadId: otherThreadId,
        turnId: null,
        role: "assistant",
        text: "other",
        isStreaming: false,
        createdAt: "2026-02-28T18:04:00.000Z",
        updatedAt: "2026-02-28T18:04:00.000Z",
      });
      yield* repository.upsert({
        messageId: MessageId.make("message-system"),
        threadId,
        turnId: null,
        role: "system",
        text: "internal context",
        isStreaming: false,
        createdAt: "2026-02-28T18:05:00.000Z",
        updatedAt: "2026-02-28T18:05:00.000Z",
      });

      const first = yield* repository.listPageByThreadId({ threadId, limit: 2 });
      assert.deepEqual(
        first.messages.map((message) => message.messageId),
        [MessageId.make("message-3a"), MessageId.make("message-3b")],
      );
      assert.deepEqual(first.nextCursor, {
        createdAt: "2026-02-28T18:02:00.000Z",
        messageId: MessageId.make("message-3a"),
      });

      const second = yield* repository.listPageByThreadId({
        threadId,
        limit: 2,
        before: first.nextCursor!,
      });
      assert.deepEqual(
        second.messages.map((message) => message.messageId),
        [MessageId.make("message-1"), MessageId.make("message-2")],
      );
      assert.equal(second.nextCursor, null);

      const includingStreaming = yield* repository.listPageByThreadId({
        threadId,
        limit: 1,
        includeStreaming: true,
      });
      assert.deepEqual(
        includingStreaming.messages.map((message) => message.messageId),
        [MessageId.make("message-4-streaming")],
      );
      assert.ok(
        [...first.messages, ...second.messages, ...includingStreaming.messages].every(
          (message) => message.role !== "system",
        ),
      );

      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND is_streaming = 0
          AND role IN ('user', 'assistant')
        ORDER BY created_at DESC, message_id DESC
        LIMIT 3
      `;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_projection_thread_messages_completed_page")),
      );
      assert.ok(plan.every((row) => !row.detail.includes("USE TEMP B-TREE")));
    }),
  );

  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );
});

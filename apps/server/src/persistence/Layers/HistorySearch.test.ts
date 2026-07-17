import {
  MessageId,
  ProjectId,
  ThreadId,
  VoiceConversationEntryId,
  VoiceConversationId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HistorySearchRepository } from "../Services/HistorySearch.ts";
import { HistorySearchRepositoryLive } from "./HistorySearch.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  HistorySearchRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("HistorySearchRepository", (it) => {
  it.effect("searches ordinary text and reads bounded owner-safe thread context", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* HistorySearchRepository;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-search', 'Search project', '/tmp/search', NULL, '[]',
          '2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, deleted_at
        ) VALUES (
          'thread-search', 'project-search', 'Search thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z',
          NULL, NULL, 0, 0, 0, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('message-before', 'thread-search', NULL, 'user', 'before context', 0,
            '2026-07-11T10:01:00.000Z', '2026-07-11T10:01:00.000Z'),
          ('message-target', 'thread-search', NULL, 'assistant', 'alpha container format', 0,
            '2026-07-11T10:02:00.000Z', '2026-07-11T10:02:00.000Z'),
          ('message-after', 'thread-search', NULL, 'system', 'after context', 0,
            '2026-07-11T10:03:00.000Z', '2026-07-11T10:03:00.000Z')
      `;

      const matches = yield* repository.searchThread({ query: "alpha", limit: 10 });
      assert.deepStrictEqual(
        matches.map((row) => row.messageId),
        [MessageId.make("message-target")],
      );
      assert.equal(matches[0]!.projectId, ProjectId.make("project-search"));
      assert.equal(matches[0]!.threadId, ThreadId.make("thread-search"));

      const operatorText = yield* repository.searchThread({ query: "alpha OR private", limit: 10 });
      assert.deepStrictEqual(operatorText, []);
      const invalid = yield* repository.searchThread({ query: "***", limit: 10 }).pipe(Effect.flip);
      assert.equal(invalid._tag, "HistorySearchQueryError");

      const read = yield* repository.readThread({
        projectId: ProjectId.make("project-search"),
        threadId: ThreadId.make("thread-search"),
        messageId: MessageId.make("message-target"),
        before: 1,
        after: 1,
      });
      assert.isTrue(Option.isSome(read));
      if (Option.isSome(read)) {
        assert.equal(read.value.target.messageId, MessageId.make("message-target"));
        assert.deepStrictEqual(
          read.value.context.map((row) => row.messageId),
          [MessageId.make("message-before"), MessageId.make("message-after")],
        );
      }

      const wrongOwner = yield* repository.readThread({
        projectId: ProjectId.make("project-other"),
        threadId: ThreadId.make("thread-search"),
        messageId: MessageId.make("message-target"),
        before: 1,
        after: 1,
      });
      assert.isTrue(Option.isNone(wrongOwner));
      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-07-11T10:04:00.000Z'
        WHERE thread_id = 'thread-search'
      `;
      assert.isTrue(
        Option.isNone(
          yield* repository.readThread({
            projectId: ProjectId.make("project-search"),
            threadId: ThreadId.make("thread-search"),
            messageId: MessageId.make("message-target"),
            before: 1,
            after: 1,
          }),
        ),
      );
    }),
  );

  it.effect("searches and reads only the active durable voice epoch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* HistorySearchRepository;
      yield* sql`
        INSERT INTO voice_conversations (
          conversation_id, retention, title, active_epoch, next_entry_sequence,
          created_at, updated_at, last_call_at
        ) VALUES (
          'conversation-search', 'durable', 'Voice search', 1, 6,
          '2026-07-11T11:00:00.000Z', '2026-07-11T11:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO voice_conversation_entries (
          entry_id, conversation_id, epoch, sequence, kind, payload_json, occurred_at
        ) VALUES
          ('voice-before-a', 'conversation-search', 1, 1, 'transcript.user',
            '{"text":"before voice a"}', '2026-07-11T11:05:00.000Z'),
          ('voice-before-b', 'conversation-search', 1, 2, 'transcript.assistant',
            '{"text":"before voice b"}', '2026-07-11T11:01:00.000Z'),
          ('voice-target', 'conversation-search', 1, 3, 'summary',
            '{"version":1,"text":"alpha voice fact"}', '2026-07-11T11:02:00.000Z'),
          ('voice-after-a', 'conversation-search', 1, 4, 'transcript.user',
            '{"text":"after voice a"}', '2026-07-11T11:06:00.000Z'),
          ('voice-after-b', 'conversation-search', 1, 5, 'transcript.assistant',
            '{"text":"after voice b"}', '2026-07-11T11:03:00.000Z')
      `;

      assert.deepStrictEqual(
        (yield* repository.searchVoice({ query: "alpha", limit: 10 })).map((row) => row.entryId),
        [VoiceConversationEntryId.make("voice-target")],
      );
      const read = yield* repository.readVoice({
        conversationId: VoiceConversationId.make("conversation-search"),
        entryId: VoiceConversationEntryId.make("voice-target"),
        before: 2,
        after: 2,
      });
      assert.isTrue(Option.isSome(read));
      if (Option.isSome(read)) {
        assert.deepStrictEqual(
          read.value.context.map((row) => row.entryId),
          [
            VoiceConversationEntryId.make("voice-before-a"),
            VoiceConversationEntryId.make("voice-before-b"),
            VoiceConversationEntryId.make("voice-after-a"),
            VoiceConversationEntryId.make("voice-after-b"),
          ],
        );
      }

      const generations = yield* repository.getGenerations();
      yield* sql`
        UPDATE voice_conversations SET active_epoch = 2
        WHERE conversation_id = 'conversation-search'
      `;
      assert.isAbove((yield* repository.getGenerations()).voiceEntry, generations.voiceEntry);
      assert.isTrue(
        Option.isNone(
          yield* repository.readVoice({
            conversationId: VoiceConversationId.make("conversation-search"),
            entryId: VoiceConversationEntryId.make("voice-target"),
            before: 1,
            after: 1,
          }),
        ),
      );
    }),
  );

  it.effect("fails closed when index generation state is missing or malformed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* HistorySearchRepository;

      yield* sql`
        DELETE FROM history_search_index_state
        WHERE source = 'voice-entry'
      `;
      const missing = yield* repository.getGenerations().pipe(Effect.flip);
      assert.equal(missing._tag, "PersistenceSqlError");

      yield* sql`
        INSERT INTO history_search_index_state (source, generation)
        VALUES ('voice-entry', 1)
      `;
      yield* sql`
        UPDATE history_search_index_state
        SET generation = 1.5
        WHERE source = 'thread-message'
      `;
      const malformed = yield* repository.getGenerations().pipe(Effect.flip);
      assert.equal(malformed._tag, "PersistenceSqlError");
    }),
  );
});

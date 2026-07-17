import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthVoiceUseScope,
  MessageId,
  ProjectId,
  ThreadId,
  VoiceConversationEntryId,
  VoiceConversationId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { HistorySearchRepositoryLive } from "../../persistence/Layers/HistorySearch.ts";
import { HistorySearchRepository } from "../../persistence/Services/HistorySearch.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { HistoryAuthorizationPolicy } from "../Services/HistoryAuthorizationPolicy.ts";
import { HistorySearchService } from "../Services/HistorySearchService.ts";
import { HistoryAuthorizationPolicyLive } from "./HistoryAuthorizationPolicy.ts";
import { HistorySearchServiceLive } from "./HistorySearchService.ts";

const signingSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SecretStoreTest = Layer.succeed(
  ServerSecretStore,
  ServerSecretStore.of({
    get: () => Effect.succeed(Option.some(signingSecret)),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(signingSecret),
    remove: () => Effect.void,
  }),
);

const layer = it.layer(
  HistorySearchServiceLive.pipe(
    Layer.provideMerge(HistorySearchRepositoryLive),
    Layer.provideMerge(HistoryAuthorizationPolicyLive),
    Layer.provideMerge(SecretStoreTest),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const principal = {
  sessionId: AuthSessionId.make("history-search-test-session"),
  scopes: new Set([AuthOrchestrationReadScope]),
};

const seedThreadHistory = Effect.fn("seedThreadHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = 'thread-service-search'`;
  yield* sql`
    INSERT OR IGNORE INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      'project-service-search', 'Service search project', '/tmp/service-search', NULL, '[]',
      '2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
      latest_user_message_at, pending_approval_count, pending_user_input_count,
      has_actionable_proposed_plan, deleted_at
    ) VALUES (
      'thread-service-search', 'project-service-search', 'Service search thread',
      '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default', NULL, NULL, NULL,
      '2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z', NULL, NULL, 0, 0, 0, NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    ) VALUES
      ('message-service-a', 'thread-service-search', NULL, 'user', 'portable container alpha', 0,
        '2026-07-11T10:01:00.000Z', '2026-07-11T10:01:00.000Z'),
      ('message-service-b', 'thread-service-search', NULL, 'assistant', 'portable container beta', 0,
        '2026-07-11T10:02:00.000Z', '2026-07-11T10:02:00.000Z'),
      ('message-service-c', 'thread-service-search', NULL, 'user', 'portable container gamma', 0,
        '2026-07-11T10:03:00.000Z', '2026-07-11T10:03:00.000Z')
  `;
});

it.effect("retries a first page until its index generation is stable", () =>
  Effect.gen(function* () {
    const generationReads = yield* Ref.make(0);
    const searches = yield* Ref.make(0);
    const repository = HistorySearchRepository.of({
      getGenerations: () =>
        Ref.getAndUpdate(generationReads, (count) => count + 1).pipe(
          Effect.map((count) => ({ threadMessage: count === 0 ? 0 : 1, voiceEntry: 0 })),
        ),
      searchThread: () =>
        Ref.update(searches, (count) => count + 1).pipe(
          Effect.as([
            {
              source: "thread-message" as const,
              projectId: ProjectId.make("project-retry"),
              threadId: ThreadId.make("thread-retry"),
              messageId: MessageId.make("message-retry"),
              containerTitle: "Retry",
              roleOrKind: "user",
              text: "portable retry",
              occurredAt: "2026-07-11T10:00:00.000Z" as never,
              rawRank: -1,
            },
          ]),
        ),
      searchVoice: () => Effect.succeed([]),
      readThread: () => Effect.succeed(Option.none()),
      readVoice: () => Effect.succeed(Option.none()),
    });
    const result = yield* Effect.gen(function* () {
      const service = yield* HistorySearchService;
      return yield* service.search(principal, {
        query: "portable",
        sources: ["thread-message"],
        limit: 5,
      });
    }).pipe(
      Effect.provide(HistorySearchServiceLive),
      Effect.provideService(HistorySearchRepository, repository),
      Effect.provideService(HistoryAuthorizationPolicy, {
        authorizeSearch: () => Effect.succeed(true),
        authorizeRead: () => Effect.succeed(true),
      }),
      Effect.provide(SecretStoreTest),
    );

    assert.equal(result.matches.length, 1);
    assert.equal(yield* Ref.get(searches), 2);
    assert.equal(yield* Ref.get(generationReads), 4);
  }),
);

const seedVoiceHistory = Effect.fn("seedVoiceHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_conversation_entries WHERE conversation_id = 'conversation-service-search'`;
  yield* sql`
    INSERT OR IGNORE INTO voice_conversations (
      conversation_id, retention, title, active_epoch, next_entry_sequence,
      created_at, updated_at, last_call_at
    ) VALUES (
      'conversation-service-search', 'durable', 'Service voice history', 1, 3,
      '2026-07-11T09:00:00.000Z', '2026-07-11T09:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO voice_conversation_entries (
      entry_id, conversation_id, epoch, sequence, kind, payload_json, occurred_at
    ) VALUES
      ('voice-service-a', 'conversation-service-search', 1, 1, 'transcript.user',
        '{"text":"portable voice alpha"}', '2026-07-11T09:01:00.000Z'),
      ('voice-service-b', 'conversation-service-search', 1, 2, 'transcript.assistant',
        '{"text":"portable voice beta"}', '2026-07-11T09:02:00.000Z')
  `;
});

layer("HistorySearchService", (it) => {
  it.effect("signs request-bound cursors and rejects stale index generations", () =>
    Effect.gen(function* () {
      yield* seedThreadHistory();
      const service = yield* HistorySearchService;
      const input = {
        query: "portable container",
        sources: ["thread-message"] as const,
        projectId: ProjectId.make("project-service-search"),
        limit: 1,
      };
      const first = yield* service.search(principal, input);
      assert.equal(first.matches.length, 1);
      assert.isNotNull(first.nextCursor);

      const second = yield* service.search(principal, { ...input, cursor: first.nextCursor! });
      assert.equal(second.matches.length, 1);
      assert.notEqual(second.matches[0]!.ref, first.matches[0]!.ref);

      const tampered = yield* service
        .search(principal, { ...input, cursor: `${first.nextCursor!}x` })
        .pipe(Effect.flip);
      assert.equal(tampered._tag, "HistoryInvalidRequestError");
      if (tampered._tag === "HistoryInvalidRequestError") {
        assert.equal(tampered.reason, "invalid_cursor");
      }

      const rebound = yield* service
        .search(principal, { ...input, query: "different", cursor: first.nextCursor! })
        .pipe(Effect.flip);
      assert.equal(rebound._tag, "HistoryInvalidRequestError");

      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-service-d', 'thread-service-search', NULL, 'user', 'portable container delta', 0,
          '2026-07-11T10:04:00.000Z', '2026-07-11T10:04:00.000Z'
        )
      `;
      const stale = yield* service
        .search(principal, { ...input, cursor: first.nextCursor! })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "HistoryInvalidRequestError");
      if (stale._tag === "HistoryInvalidRequestError") {
        assert.equal(stale.reason, "invalid_cursor");
      }
    }),
  );

  it.effect("fails closed without source scope and validates exact owner-bound reads", () =>
    Effect.gen(function* () {
      yield* seedThreadHistory();
      const service = yield* HistorySearchService;
      const denied = yield* service
        .search(
          { sessionId: AuthSessionId.make("no-history-scope"), scopes: new Set() },
          { query: "portable", sources: ["thread-message"], limit: 5 },
        )
        .pipe(Effect.flip);
      assert.equal(denied._tag, "HistoryInvalidRequestError");

      const read = yield* service.read(principal, {
        ref: {
          type: "thread-message",
          projectId: ProjectId.make("project-service-search"),
          threadId: ThreadId.make("thread-service-search"),
          messageId: MessageId.make("message-service-b"),
        },
        before: 1,
        after: 1,
      });
      assert.equal(read.target.content, "portable container beta");
      assert.deepStrictEqual(
        read.context.map((record) => record.content),
        ["portable container alpha", "portable container gamma"],
      );

      const foreignOwner = yield* service
        .read(principal, {
          ref: {
            type: "thread-message",
            projectId: ProjectId.make("wrong-project"),
            threadId: ThreadId.make("thread-service-search"),
            messageId: MessageId.make("message-service-b"),
          },
          before: 0,
          after: 0,
        })
        .pipe(Effect.flip);
      assert.equal(foreignOwner._tag, "HistoryItemNotFoundError");
    }),
  );

  it.effect("normalizes source ranks and pages a mixed search without duplicates", () =>
    Effect.gen(function* () {
      yield* seedThreadHistory();
      yield* seedVoiceHistory();
      const service = yield* HistorySearchService;
      const combinedPrincipal = {
        sessionId: AuthSessionId.make("combined-history-scope"),
        scopes: new Set([AuthOrchestrationReadScope, AuthVoiceUseScope]),
      };
      const missingVoiceScope = yield* service
        .read(combinedPrincipal, {
          ref: {
            type: "voice-entry",
            conversationId: VoiceConversationId.make("conversation-service-search"),
            entryId: VoiceConversationEntryId.make("voice-service-a"),
          },
          before: 0,
          after: 0,
        })
        .pipe(Effect.flip);
      assert.equal(missingVoiceScope._tag, "HistoryInvalidRequestError");
      const keys: Array<string> = [];
      let cursor: string | undefined;
      do {
        const page = yield* service.search(combinedPrincipal, {
          query: "portable",
          sources: ["thread-message", "voice-entry"],
          voiceScope: { type: "all-durable" },
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const match of page.matches) {
          keys.push(
            match.ref.type === "thread-message"
              ? `thread:${match.ref.messageId}`
              : `voice:${match.ref.entryId}`,
          );
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      assert.equal(keys.length, 5);
      assert.equal(new Set(keys).size, 5);
      assert.deepStrictEqual(
        keys.map((key) => key.split(":")[0]),
        ["thread", "voice", "thread", "voice", "thread"],
      );
    }),
  );
});

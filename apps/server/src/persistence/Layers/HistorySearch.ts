import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  VoiceConversationEntryId,
  VoiceConversationId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "../Errors.ts";
import {
  HistorySearchQueryError,
  HistorySearchRepository,
  type HistorySearchRepositoryShape,
  type ThreadHistoryRecord,
  type ThreadHistorySearchInput,
  type ThreadHistorySearchRow,
  type VoiceHistoryRecord,
  type VoiceHistorySearchRow,
} from "../Services/HistorySearch.ts";

const MAX_QUERY_TERMS = 32;
const MAX_REPOSITORY_RESULTS = 100;
const isHistorySearchQueryError = Schema.is(HistorySearchQueryError);

const GenerationRow = Schema.Struct({
  source: Schema.Literals(["thread-message", "voice-entry"]),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const ThreadRecordRow = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
  roleOrKind: Schema.String,
  text: Schema.String,
  occurredAt: IsoDateTime,
});
const VoiceRecordRow = Schema.Struct({
  conversationId: VoiceConversationId,
  entryId: VoiceConversationEntryId,
  roleOrKind: Schema.String,
  text: Schema.String,
  occurredAt: IsoDateTime,
});
const VoiceReadRecordRow = Schema.Struct({
  ...VoiceRecordRow.fields,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
const ThreadSearchDbRow = Schema.Struct({
  ...ThreadRecordRow.fields,
  containerTitle: Schema.NullOr(Schema.String),
  rawRank: Schema.Number,
});
const VoiceSearchDbRow = Schema.Struct({
  ...VoiceRecordRow.fields,
  containerTitle: Schema.NullOr(Schema.String),
  rawRank: Schema.Number,
});

const decodeThreadSearchRows = Schema.decodeUnknownEffect(Schema.Array(ThreadSearchDbRow));
const decodeVoiceSearchRows = Schema.decodeUnknownEffect(Schema.Array(VoiceSearchDbRow));

const normalizeQuery = (query: string) => {
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) {
    return Effect.fail(new HistorySearchQueryError({ reason: "empty" }));
  }
  if (terms.length > MAX_QUERY_TERMS) {
    return Effect.fail(new HistorySearchQueryError({ reason: "too_many_terms" }));
  }
  return Effect.succeed(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "));
};

const boundedLimit = (limit: number) => Math.max(1, Math.min(MAX_REPOSITORY_RESULTS, limit));

const roleFlags = (roles: ThreadHistorySearchInput["roles"]) => ({
  hasRoles: roles === undefined ? 0 : 1,
  user: roles?.includes("user") === true ? 1 : 0,
  assistant: roles?.includes("assistant") === true ? 1 : 0,
  system: roles?.includes("system") === true ? 1 : 0,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getGenerationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: GenerationRow,
    execute: () => sql`
      SELECT source, generation
      FROM history_search_index_state
      ORDER BY source ASC
    `,
  });

  const loadGenerations = (operation: string) =>
    getGenerationRows().pipe(
      Effect.mapError(toPersistenceSqlError(`${operation}:query`)),
      Effect.flatMap((rows) => {
        const threadRows = rows.filter((row) => row.source === "thread-message");
        const voiceRows = rows.filter((row) => row.source === "voice-entry");
        if (threadRows.length !== 1 || voiceRows.length !== 1) {
          return Effect.fail(
            new PersistenceSqlError({
              operation,
              detail: "History search index generation state is incomplete or ambiguous",
            }),
          );
        }
        return Effect.succeed({
          threadMessage: threadRows[0]!.generation,
          voiceEntry: voiceRows[0]!.generation,
        });
      }),
    );

  const findThreadTarget = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, threadId: ThreadId, messageId: MessageId }),
    Result: ThreadRecordRow,
    execute: (input) => sql`
      SELECT
        documents.project_id AS "projectId",
        documents.thread_id AS "threadId",
        documents.message_id AS "messageId",
        documents.role AS "roleOrKind",
        documents.text,
        documents.occurred_at AS "occurredAt"
      FROM history_thread_message_documents AS documents
      INNER JOIN projection_threads AS threads
        ON threads.thread_id = documents.thread_id
        AND threads.project_id = documents.project_id
        AND threads.deleted_at IS NULL
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
        AND projects.deleted_at IS NULL
      WHERE documents.project_id = ${input.projectId}
        AND documents.thread_id = ${input.threadId}
        AND documents.message_id = ${input.messageId}
      LIMIT 1
    `,
  });
  const listThreadBefore = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      threadId: ThreadId,
      occurredAt: IsoDateTime,
      messageId: MessageId,
      limit: Schema.Number,
    }),
    Result: ThreadRecordRow,
    execute: (input) => sql`
      SELECT * FROM (
        SELECT
          project_id AS "projectId",
          thread_id AS "threadId",
          message_id AS "messageId",
          role AS "roleOrKind",
          text,
          occurred_at AS "occurredAt"
        FROM history_thread_message_documents
        WHERE project_id = ${input.projectId}
          AND thread_id = ${input.threadId}
          AND (occurred_at, message_id) < (${input.occurredAt}, ${input.messageId})
        ORDER BY occurred_at DESC, message_id DESC
        LIMIT ${input.limit}
      ) ORDER BY "occurredAt" ASC, "messageId" ASC
    `,
  });
  const listThreadAfter = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      threadId: ThreadId,
      occurredAt: IsoDateTime,
      messageId: MessageId,
      limit: Schema.Number,
    }),
    Result: ThreadRecordRow,
    execute: (input) => sql`
      SELECT
        project_id AS "projectId",
        thread_id AS "threadId",
        message_id AS "messageId",
        role AS "roleOrKind",
        text,
        occurred_at AS "occurredAt"
      FROM history_thread_message_documents
      WHERE project_id = ${input.projectId}
        AND thread_id = ${input.threadId}
        AND (occurred_at, message_id) > (${input.occurredAt}, ${input.messageId})
      ORDER BY occurred_at ASC, message_id ASC
      LIMIT ${input.limit}
    `,
  });

  const findVoiceTarget = SqlSchema.findOneOption({
    Request: Schema.Struct({
      conversationId: VoiceConversationId,
      entryId: VoiceConversationEntryId,
    }),
    Result: VoiceReadRecordRow,
    execute: (input) => sql`
      SELECT
        documents.conversation_id AS "conversationId",
        documents.entry_id AS "entryId",
        documents.sequence,
        documents.role_or_kind AS "roleOrKind",
        documents.text,
        documents.occurred_at AS "occurredAt"
      FROM history_voice_entry_documents AS documents
      INNER JOIN voice_conversations AS conversations
        ON conversations.conversation_id = documents.conversation_id
        AND conversations.active_epoch = documents.context_epoch
      WHERE documents.conversation_id = ${input.conversationId}
        AND documents.entry_id = ${input.entryId}
      LIMIT 1
    `,
  });
  const listVoiceBefore = SqlSchema.findAll({
    Request: Schema.Struct({
      conversationId: VoiceConversationId,
      entryId: VoiceConversationEntryId,
      limit: Schema.Number,
    }),
    Result: VoiceReadRecordRow,
    execute: (input) => sql`
      SELECT * FROM (
        SELECT
          documents.conversation_id AS "conversationId",
          documents.entry_id AS "entryId",
          documents.sequence,
          documents.role_or_kind AS "roleOrKind",
          documents.text,
          documents.occurred_at AS "occurredAt"
        FROM history_voice_entry_documents AS documents
        INNER JOIN history_voice_entry_documents AS target
          ON target.conversation_id = documents.conversation_id
          AND target.context_epoch = documents.context_epoch
        INNER JOIN voice_conversations AS conversations
          ON conversations.conversation_id = target.conversation_id
          AND conversations.active_epoch = target.context_epoch
        WHERE target.conversation_id = ${input.conversationId}
          AND target.entry_id = ${input.entryId}
          AND documents.sequence < target.sequence
        ORDER BY documents.sequence DESC, documents.entry_id DESC
        LIMIT ${input.limit}
      ) ORDER BY sequence ASC, "entryId" ASC
    `,
  });
  const listVoiceAfter = SqlSchema.findAll({
    Request: Schema.Struct({
      conversationId: VoiceConversationId,
      entryId: VoiceConversationEntryId,
      limit: Schema.Number,
    }),
    Result: VoiceReadRecordRow,
    execute: (input) => sql`
      SELECT
        documents.conversation_id AS "conversationId",
        documents.entry_id AS "entryId",
        documents.sequence,
        documents.role_or_kind AS "roleOrKind",
        documents.text,
        documents.occurred_at AS "occurredAt"
      FROM history_voice_entry_documents AS documents
      INNER JOIN history_voice_entry_documents AS target
        ON target.conversation_id = documents.conversation_id
        AND target.context_epoch = documents.context_epoch
      INNER JOIN voice_conversations AS conversations
        ON conversations.conversation_id = target.conversation_id
        AND conversations.active_epoch = target.context_epoch
      WHERE target.conversation_id = ${input.conversationId}
        AND target.entry_id = ${input.entryId}
        AND documents.sequence > target.sequence
      ORDER BY documents.sequence ASC, documents.entry_id ASC
      LIMIT ${input.limit}
    `,
  });

  const getGenerations: HistorySearchRepositoryShape["getGenerations"] = () =>
    loadGenerations("HistorySearchRepository.getGenerations");

  const searchThread: HistorySearchRepositoryShape["searchThread"] = Effect.fn(
    "HistorySearchRepository.searchThread",
  )(function* (input) {
    const match = yield* normalizeQuery(input.query);
    const roles = roleFlags(input.roles);
    const after = input.after;
    const rows = yield* sql
      .unsafe(
        `WITH matches AS (
          SELECT
            documents.project_id AS projectId,
            documents.thread_id AS threadId,
            documents.message_id AS messageId,
            threads.title AS containerTitle,
            documents.role AS roleOrKind,
            documents.text AS text,
            documents.occurred_at AS occurredAt,
            bm25(projection_thread_messages_fts) AS rawRank
          FROM projection_thread_messages_fts
          INNER JOIN history_thread_message_documents AS documents
            ON documents.document_id = projection_thread_messages_fts.rowid
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = documents.thread_id
            AND threads.project_id = documents.project_id
            AND threads.deleted_at IS NULL
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
            AND projects.deleted_at IS NULL
          WHERE projection_thread_messages_fts MATCH ?
            AND (? IS NULL OR documents.project_id = ?)
            AND (? IS NULL OR documents.thread_id = ?)
            AND (? = 0 OR (? = 1 AND documents.role = 'user')
              OR (? = 1 AND documents.role = 'assistant')
              OR (? = 1 AND documents.role = 'system'))
            AND (? IS NULL OR documents.occurred_at > ?)
            AND (? IS NULL OR documents.occurred_at < ?)
        )
        SELECT * FROM matches
        WHERE (? = 0 OR rawRank > ?
          OR (rawRank = ? AND occurredAt < ?)
          OR (rawRank = ? AND occurredAt = ? AND messageId > ?))
        ORDER BY rawRank ASC, occurredAt DESC, messageId ASC
        LIMIT ?`,
        [
          match,
          input.projectId ?? null,
          input.projectId ?? null,
          input.threadId ?? null,
          input.threadId ?? null,
          roles.hasRoles,
          roles.user,
          roles.assistant,
          roles.system,
          input.occurredAfter ?? null,
          input.occurredAfter ?? null,
          input.occurredBefore ?? null,
          input.occurredBefore ?? null,
          after === undefined ? 0 : 1,
          after?.rawRank ?? 0,
          after?.rawRank ?? 0,
          after?.occurredAt ?? "",
          after?.rawRank ?? 0,
          after?.occurredAt ?? "",
          after?.itemId ?? "",
          boundedLimit(input.limit),
        ],
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("HistorySearchRepository.searchThread:query")),
        Effect.flatMap(decodeThreadSearchRows),
        Effect.mapError((cause) =>
          isHistorySearchQueryError(cause)
            ? cause
            : toPersistenceSqlError("HistorySearchRepository.searchThread:decode")(cause),
        ),
      );
    return rows.map((row): ThreadHistorySearchRow => ({ ...row, source: "thread-message" }));
  });

  const searchVoice: HistorySearchRepositoryShape["searchVoice"] = Effect.fn(
    "HistorySearchRepository.searchVoice",
  )(function* (input) {
    const match = yield* normalizeQuery(input.query);
    const roles = roleFlags(input.roles);
    const after = input.after;
    const rows = yield* sql
      .unsafe(
        `WITH matches AS (
          SELECT
            documents.conversation_id AS conversationId,
            documents.entry_id AS entryId,
            conversations.title AS containerTitle,
            documents.role_or_kind AS roleOrKind,
            documents.text AS text,
            documents.occurred_at AS occurredAt,
            bm25(voice_conversation_entries_fts) AS rawRank
          FROM voice_conversation_entries_fts
          INNER JOIN history_voice_entry_documents AS documents
            ON documents.document_id = voice_conversation_entries_fts.rowid
          INNER JOIN voice_conversations AS conversations
            ON conversations.conversation_id = documents.conversation_id
            AND conversations.active_epoch = documents.context_epoch
          WHERE voice_conversation_entries_fts MATCH ?
            AND (? IS NULL OR documents.conversation_id = ?)
            AND (? = 0 OR (? = 1 AND documents.role_or_kind = 'user')
              OR (? = 1 AND documents.role_or_kind = 'assistant')
              OR (? = 1 AND documents.role_or_kind NOT IN ('user', 'assistant')))
            AND (? IS NULL OR documents.occurred_at > ?)
            AND (? IS NULL OR documents.occurred_at < ?)
        )
        SELECT * FROM matches
        WHERE (? = 0 OR rawRank > ?
          OR (rawRank = ? AND occurredAt < ?)
          OR (rawRank = ? AND occurredAt = ? AND entryId > ?))
        ORDER BY rawRank ASC, occurredAt DESC, entryId ASC
        LIMIT ?`,
        [
          match,
          input.conversationId ?? null,
          input.conversationId ?? null,
          roles.hasRoles,
          roles.user,
          roles.assistant,
          roles.system,
          input.occurredAfter ?? null,
          input.occurredAfter ?? null,
          input.occurredBefore ?? null,
          input.occurredBefore ?? null,
          after === undefined ? 0 : 1,
          after?.rawRank ?? 0,
          after?.rawRank ?? 0,
          after?.occurredAt ?? "",
          after?.rawRank ?? 0,
          after?.occurredAt ?? "",
          after?.itemId ?? "",
          boundedLimit(input.limit),
        ],
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("HistorySearchRepository.searchVoice:query")),
        Effect.flatMap(decodeVoiceSearchRows),
        Effect.mapError((cause) =>
          isHistorySearchQueryError(cause)
            ? cause
            : toPersistenceSqlError("HistorySearchRepository.searchVoice:decode")(cause),
        ),
      );
    return rows.map((row): VoiceHistorySearchRow => ({ ...row, source: "voice-entry" }));
  });

  const readThread: HistorySearchRepositoryShape["readThread"] = Effect.fn(
    "HistorySearchRepository.readThread",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const generationsBefore = yield* loadGenerations(
            "HistorySearchRepository.readThread:generation-before",
          );
          const target = yield* findThreadTarget(input).pipe(
            Effect.mapError(toPersistenceSqlError("HistorySearchRepository.readThread:target")),
          );
          if (Option.isNone(target)) return Option.none();
          const before = yield* listThreadBefore({
            projectId: input.projectId,
            threadId: input.threadId,
            messageId: input.messageId,
            occurredAt: target.value.occurredAt,
            limit: input.before,
          }).pipe(
            Effect.mapError(toPersistenceSqlError("HistorySearchRepository.readThread:before")),
          );
          const after = yield* listThreadAfter({
            projectId: input.projectId,
            threadId: input.threadId,
            messageId: input.messageId,
            occurredAt: target.value.occurredAt,
            limit: input.after,
          }).pipe(
            Effect.mapError(toPersistenceSqlError("HistorySearchRepository.readThread:after")),
          );
          const finalTarget = yield* findThreadTarget(input).pipe(
            Effect.mapError(
              toPersistenceSqlError("HistorySearchRepository.readThread:final-target"),
            ),
          );
          const generationsAfter = yield* loadGenerations(
            "HistorySearchRepository.readThread:generation-after",
          );
          if (
            Option.isNone(finalTarget) ||
            generationsBefore.threadMessage !== generationsAfter.threadMessage
          ) {
            return yield* new PersistenceSqlError({
              operation: "HistorySearchRepository.readThread:fence",
              detail: "Thread history changed during an exact read",
            });
          }
          const mapRecord = (row: typeof ThreadRecordRow.Type): ThreadHistoryRecord => ({
            ...row,
            source: "thread-message",
          });
          return Option.some({
            target: mapRecord(finalTarget.value),
            context: [...before.map(mapRecord), ...after.map(mapRecord)],
          });
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("HistorySearchRepository.readThread:transaction")(cause),
          ),
        ),
      );
  });

  const readVoice: HistorySearchRepositoryShape["readVoice"] = Effect.fn(
    "HistorySearchRepository.readVoice",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const generationsBefore = yield* loadGenerations(
            "HistorySearchRepository.readVoice:generation-before",
          );
          const target = yield* findVoiceTarget(input).pipe(
            Effect.mapError(toPersistenceSqlError("HistorySearchRepository.readVoice:target")),
          );
          if (Option.isNone(target)) return Option.none();
          const before = yield* listVoiceBefore({
            conversationId: input.conversationId,
            entryId: input.entryId,
            limit: input.before,
          }).pipe(
            Effect.mapError(toPersistenceSqlError("HistorySearchRepository.readVoice:before")),
          );
          const after = yield* listVoiceAfter({
            conversationId: input.conversationId,
            entryId: input.entryId,
            limit: input.after,
          }).pipe(
            Effect.mapError(toPersistenceSqlError("HistorySearchRepository.readVoice:after")),
          );
          const finalTarget = yield* findVoiceTarget(input).pipe(
            Effect.mapError(
              toPersistenceSqlError("HistorySearchRepository.readVoice:final-target"),
            ),
          );
          const generationsAfter = yield* loadGenerations(
            "HistorySearchRepository.readVoice:generation-after",
          );
          if (
            Option.isNone(finalTarget) ||
            generationsBefore.voiceEntry !== generationsAfter.voiceEntry
          ) {
            return yield* new PersistenceSqlError({
              operation: "HistorySearchRepository.readVoice:fence",
              detail: "Voice history changed during an exact read",
            });
          }
          const mapRecord = (row: typeof VoiceReadRecordRow.Type): VoiceHistoryRecord => ({
            source: "voice-entry",
            conversationId: row.conversationId,
            entryId: row.entryId,
            roleOrKind: row.roleOrKind,
            text: row.text,
            occurredAt: row.occurredAt,
          });
          return Option.some({
            target: mapRecord(finalTarget.value),
            context: [...before.map(mapRecord), ...after.map(mapRecord)],
          });
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("HistorySearchRepository.readVoice:transaction")(cause),
          ),
        ),
      );
  });

  return HistorySearchRepository.of({
    getGenerations,
    searchThread,
    searchVoice,
    readThread,
    readVoice,
  });
});

export const HistorySearchRepositoryLive = Layer.effect(HistorySearchRepository, make);

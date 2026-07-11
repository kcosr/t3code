import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DurableVoiceConversation,
  EphemeralVoiceConversationPersistenceError,
  VoiceConversationAlreadyExistsError,
  VoiceConversationEntryConflictError,
  VoiceConversationEpochConflictError,
  VoiceConversationJournalEntry,
  VoiceConversationNotFoundError,
  VoiceConversationRepository,
  type VoiceConversationRepositoryShape,
} from "../Services/VoiceConversations.ts";

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_CONTEXT_LIMIT = 1_000;

const ConversationRow = DurableVoiceConversation;
const JournalEntryRow = VoiceConversationJournalEntry.mapFields(
  Struct.assign({ payload: Schema.fromJsonString(Schema.Unknown) }),
);
const AllocatedSequence = Schema.Struct({
  epoch: Schema.Number,
  sequence: Schema.Number,
});
const DeletedConversation = Schema.Struct({ conversationId: Schema.String });

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeVoiceConversationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findConversation = SqlSchema.findOneOption({
    Request: Schema.Struct({ conversationId: Schema.String }),
    Result: ConversationRow,
    execute: ({ conversationId }) => sql`
      SELECT
        conversation_id AS "conversationId",
        retention,
        title,
        active_epoch AS "activeEpoch",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM voice_conversations
      WHERE conversation_id = ${conversationId}
      LIMIT 1
    `,
  });

  const insertConversation = SqlSchema.findOneOption({
    Request: Schema.Struct({
      conversationId: Schema.String,
      title: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
    Result: ConversationRow,
    execute: (input) => sql`
      INSERT INTO voice_conversations (
        conversation_id,
        retention,
        title,
        active_epoch,
        next_entry_sequence,
        created_at,
        updated_at
      )
      VALUES (
        ${input.conversationId},
        'durable',
        ${input.title},
        1,
        1,
        ${input.createdAt},
        ${input.createdAt}
      )
      ON CONFLICT (conversation_id) DO NOTHING
      RETURNING
        conversation_id AS "conversationId",
        retention,
        title,
        active_epoch AS "activeEpoch",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  });

  const listConversations = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Number }),
    Result: ConversationRow,
    execute: ({ limit }) => sql`
      SELECT
        conversation_id AS "conversationId",
        retention,
        title,
        active_epoch AS "activeEpoch",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM voice_conversations
      ORDER BY updated_at DESC, conversation_id ASC
      LIMIT ${limit}
    `,
  });

  const deleteConversation = SqlSchema.findOneOption({
    Request: Schema.Struct({ conversationId: Schema.String }),
    Result: DeletedConversation,
    execute: ({ conversationId }) => sql`
      DELETE FROM voice_conversations
      WHERE conversation_id = ${conversationId}
      RETURNING conversation_id AS "conversationId"
    `,
  });

  const findJournalEntry = SqlSchema.findOneOption({
    Request: Schema.Struct({ entryId: Schema.String }),
    Result: JournalEntryRow,
    execute: ({ entryId }) => sql`
      SELECT
        entry_id AS "entryId",
        conversation_id AS "conversationId",
        epoch,
        sequence,
        kind,
        payload_json AS "payload",
        occurred_at AS "occurredAt"
      FROM voice_conversation_entries
      WHERE entry_id = ${entryId}
      LIMIT 1
    `,
  });

  const allocateSequence = SqlSchema.findOneOption({
    Request: Schema.Struct({
      conversationId: Schema.String,
      expectedEpoch: Schema.Number,
      occurredAt: Schema.String,
    }),
    Result: AllocatedSequence,
    execute: (input) => sql`
      UPDATE voice_conversations
      SET
        next_entry_sequence = next_entry_sequence + 1,
        updated_at = MAX(updated_at, ${input.occurredAt})
      WHERE conversation_id = ${input.conversationId}
        AND active_epoch = ${input.expectedEpoch}
      RETURNING
        active_epoch AS epoch,
        next_entry_sequence - 1 AS sequence
    `,
  });

  const advanceContextEpoch = SqlSchema.findOneOption({
    Request: Schema.Struct({
      conversationId: Schema.String,
      expectedEpoch: Schema.Number,
      clearedAt: Schema.String,
    }),
    Result: AllocatedSequence,
    execute: (input) => sql`
      UPDATE voice_conversations
      SET
        active_epoch = active_epoch + 1,
        next_entry_sequence = next_entry_sequence + 1,
        updated_at = MAX(updated_at, ${input.clearedAt})
      WHERE conversation_id = ${input.conversationId}
        AND active_epoch = ${input.expectedEpoch}
      RETURNING
        active_epoch AS epoch,
        next_entry_sequence - 1 AS sequence
    `,
  });

  const insertJournalEntry = SqlSchema.findOne({
    Request: Schema.Struct({
      entryId: Schema.String,
      conversationId: Schema.String,
      epoch: Schema.Number,
      sequence: Schema.Number,
      kind: Schema.String,
      payloadJson: Schema.String,
      occurredAt: Schema.String,
    }),
    Result: JournalEntryRow,
    execute: (input) => sql`
      INSERT INTO voice_conversation_entries (
        entry_id,
        conversation_id,
        epoch,
        sequence,
        kind,
        payload_json,
        occurred_at
      )
      VALUES (
        ${input.entryId},
        ${input.conversationId},
        ${input.epoch},
        ${input.sequence},
        ${input.kind},
        ${input.payloadJson},
        ${input.occurredAt}
      )
      RETURNING
        entry_id AS "entryId",
        conversation_id AS "conversationId",
        epoch,
        sequence,
        kind,
        payload_json AS "payload",
        occurred_at AS "occurredAt"
    `,
  });

  const listContextEntries = SqlSchema.findAll({
    Request: Schema.Struct({
      conversationId: Schema.String,
      epoch: Schema.Number,
      limit: Schema.Number,
    }),
    Result: JournalEntryRow,
    execute: (input) => sql`
      SELECT * FROM (
        SELECT
          entry_id AS "entryId",
          conversation_id AS "conversationId",
          epoch,
          sequence,
          kind,
          payload_json AS "payload",
          occurred_at AS "occurredAt"
        FROM voice_conversation_entries
        WHERE conversation_id = ${input.conversationId}
          AND epoch = ${input.epoch}
        ORDER BY sequence DESC
        LIMIT ${input.limit}
      )
      ORDER BY sequence ASC
    `,
  });

  const getConversationOrFail = Effect.fn("VoiceConversationRepository.getConversationOrFail")(
    function* (conversationId: DurableVoiceConversation["conversationId"]) {
      const conversation = yield* findConversation({ conversationId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceConversationRepository.getConversationOrFail:query"),
        ),
      );
      if (Option.isNone(conversation)) {
        return yield* new VoiceConversationNotFoundError({ conversationId });
      }
      return conversation.value;
    },
  );

  const requireAllocatedSequence = Effect.fn(
    "VoiceConversationRepository.requireAllocatedSequence",
  )(function* (input: {
    readonly conversationId: DurableVoiceConversation["conversationId"];
    readonly expectedEpoch: DurableVoiceConversation["activeEpoch"];
    readonly allocated: Option.Option<typeof AllocatedSequence.Type>;
  }) {
    if (Option.isSome(input.allocated)) return input.allocated.value;
    const conversation = yield* getConversationOrFail(input.conversationId);
    return yield* new VoiceConversationEpochConflictError({
      conversationId: conversation.conversationId,
      expectedEpoch: input.expectedEpoch,
      actualEpoch: conversation.activeEpoch,
    });
  });

  const create: VoiceConversationRepositoryShape["create"] = Effect.fn(
    "VoiceConversationRepository.create",
  )(function* (input) {
    if (input.retention !== "durable") {
      return yield* new EphemeralVoiceConversationPersistenceError({
        conversationId: input.conversationId,
      });
    }
    const inserted = yield* insertConversation(input).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.create:query")),
    );
    if (Option.isNone(inserted)) {
      return yield* new VoiceConversationAlreadyExistsError({
        conversationId: input.conversationId,
      });
    }
    return inserted.value;
  });

  const get: VoiceConversationRepositoryShape["get"] = (input) =>
    findConversation(input).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.get:query")),
    );

  const list: VoiceConversationRepositoryShape["list"] = (input = {}) =>
    listConversations({ limit: input.limit ?? DEFAULT_LIST_LIMIT }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.list:query")),
    );

  const deleteConversationById: VoiceConversationRepositoryShape["delete"] = (input) =>
    deleteConversation(input).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.delete:query")),
      Effect.map(Option.isSome),
    );

  const append: VoiceConversationRepositoryShape["append"] = Effect.fn(
    "VoiceConversationRepository.append",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const payloadJson = yield* encodePayload(input.payload).pipe(
            Effect.mapError(toPersistenceDecodeError("VoiceConversationRepository.append:payload")),
          );
          const existing = yield* findJournalEntry({ entryId: input.entryId }).pipe(
            Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.append:get-entry")),
          );
          if (Option.isSome(existing)) {
            const existingPayloadJson = yield* encodePayload(existing.value.payload).pipe(
              Effect.mapError(
                toPersistenceDecodeError("VoiceConversationRepository.append:existing-payload"),
              ),
            );
            if (
              existing.value.conversationId !== input.conversationId ||
              existing.value.epoch !== input.expectedEpoch ||
              existing.value.kind !== input.kind ||
              existing.value.occurredAt !== input.occurredAt ||
              existingPayloadJson !== payloadJson
            ) {
              return yield* new VoiceConversationEntryConflictError({
                conversationId: input.conversationId,
                entryId: input.entryId,
              });
            }
            return existing.value;
          }

          const allocated = yield* allocateSequence(input).pipe(
            Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.append:allocate")),
          );
          const { epoch, sequence } = yield* requireAllocatedSequence({
            conversationId: input.conversationId,
            expectedEpoch: input.expectedEpoch,
            allocated,
          });
          return yield* insertJournalEntry({
            entryId: input.entryId,
            conversationId: input.conversationId,
            epoch,
            sequence,
            kind: input.kind,
            payloadJson,
            occurredAt: input.occurredAt,
          }).pipe(
            Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.append:insert")),
          );
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("VoiceConversationRepository.append:transaction")(cause),
          ),
        ),
      );
  });

  const clearContext: VoiceConversationRepositoryShape["clearContext"] = Effect.fn(
    "VoiceConversationRepository.clearContext",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findJournalEntry({ entryId: input.entryId }).pipe(
            Effect.mapError(
              toPersistenceSqlError("VoiceConversationRepository.clearContext:get-entry"),
            ),
          );
          if (Option.isSome(existing)) {
            if (
              existing.value.conversationId !== input.conversationId ||
              existing.value.kind !== "context-cleared" ||
              existing.value.epoch !== input.expectedEpoch + 1 ||
              existing.value.occurredAt !== input.clearedAt
            ) {
              return yield* new VoiceConversationEntryConflictError({
                conversationId: input.conversationId,
                entryId: input.entryId,
              });
            }
            return yield* getConversationOrFail(input.conversationId);
          }

          const allocated = yield* advanceContextEpoch(input).pipe(
            Effect.mapError(
              toPersistenceSqlError("VoiceConversationRepository.clearContext:advance"),
            ),
          );
          const { epoch, sequence } = yield* requireAllocatedSequence({
            conversationId: input.conversationId,
            expectedEpoch: input.expectedEpoch,
            allocated,
          });
          const payloadJson = yield* encodePayload({ previousEpoch: input.expectedEpoch }).pipe(
            Effect.mapError(
              toPersistenceDecodeError("VoiceConversationRepository.clearContext:payload"),
            ),
          );
          yield* insertJournalEntry({
            entryId: input.entryId,
            conversationId: input.conversationId,
            epoch,
            sequence,
            kind: "context-cleared",
            payloadJson,
            occurredAt: input.clearedAt,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError("VoiceConversationRepository.clearContext:insert"),
            ),
          );
          return yield* getConversationOrFail(input.conversationId);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("VoiceConversationRepository.clearContext:transaction")(cause),
          ),
        ),
      );
  });

  const listContext: VoiceConversationRepositoryShape["listContext"] = Effect.fn(
    "VoiceConversationRepository.listContext",
  )(function* (input) {
    const conversation = yield* getConversationOrFail(input.conversationId);
    return yield* listContextEntries({
      conversationId: input.conversationId,
      epoch: conversation.activeEpoch,
      limit: input.limit ?? DEFAULT_CONTEXT_LIMIT,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceConversationRepository.listContext:query")),
    );
  });

  return VoiceConversationRepository.of({
    create,
    get,
    list,
    delete: deleteConversationById,
    clearContext,
    append,
    listContext,
  });
});

export const VoiceConversationRepositoryLive = Layer.effect(
  VoiceConversationRepository,
  makeVoiceConversationRepository,
);

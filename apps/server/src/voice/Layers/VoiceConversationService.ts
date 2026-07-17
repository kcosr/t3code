import {
  VOICE_CONVERSATION_TRANSCRIPT_ENTRY_MAX_CHARS,
  NonNegativeInt,
  PositiveInt,
  VoiceConversationEntryId,
  VoiceConversationId,
  VoiceConversationListPage,
  VoiceConversationTranscriptEntry,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  VoiceConversationRepository,
  type DurableVoiceConversation,
  type VoiceConversationJournalEntry,
  type VoiceConversationTranscriptRow,
} from "../../persistence/Services/VoiceConversations.ts";
import { VoiceError } from "../Errors.ts";
import {
  VoiceConversationService,
  type VoiceConversationServiceShape,
} from "../Services/VoiceConversationService.ts";

type EphemeralConversation = {
  readonly conversationId: VoiceConversationId;
  readonly retention: "ephemeral";
  readonly title: string | null;
  readonly activeEpoch: number;
  readonly lastCallAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

interface EphemeralState {
  readonly conversations: ReadonlyMap<VoiceConversationId, EphemeralConversation>;
  readonly entries: ReadonlyMap<VoiceConversationId, ReadonlyArray<VoiceConversationJournalEntry>>;
  readonly clears: ReadonlyMap<
    string,
    { readonly activeEpoch: number; readonly clearedAt: string }
  >;
}

const TranscriptCursor = Schema.Struct({
  version: Schema.Literal(1),
  conversationId: VoiceConversationId,
  snapshotThroughSequence: NonNegativeInt,
  beforeSequence: PositiveInt,
});
const ConversationListCursor = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.String,
  conversationId: VoiceConversationId,
});
const decodeConversationListCursorJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConversationListCursor),
);
const encodeConversationListCursorJson = Schema.encodeSync(
  Schema.fromJsonString(ConversationListCursor),
);
const decodeTranscriptCursorJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TranscriptCursor),
);
const encodeTranscriptCursorJson = Schema.encodeSync(Schema.fromJsonString(TranscriptCursor));
const encodeTranscriptEntryJson = Schema.encodeSync(
  Schema.fromJsonString(VoiceConversationTranscriptEntry),
);
const encodeJournalPayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const DEFAULT_TRANSCRIPT_LIMIT = 30;
const DEFAULT_CONVERSATION_LIST_LIMIT = 30;
const TRANSCRIPT_PAGE_MAX_BYTES = 64 * 1_024;
const TRANSCRIPT_ENTRIES_MAX_BYTES = TRANSCRIPT_PAGE_MAX_BYTES - 4_096;
const textEncoder = new TextEncoder();

const mapDurable = (conversation: DurableVoiceConversation) => ({
  ...conversation,
  retention: "durable" as const,
});

const repositoryError = (operation: string) => (cause: unknown) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation,
    detail: "Voice conversation storage is unavailable",
    retryable: true,
    cause,
  });

const conversationNotFound = (operation: string) =>
  new VoiceError({
    reason: "conversation-not-found",
    operation,
    detail: "Voice conversation was not found",
    retryable: false,
  });

const staleEpoch = (operation: string) =>
  new VoiceError({
    reason: "invalid-context",
    operation,
    detail: "Voice conversation context epoch is stale",
    retryable: false,
  });

const entryConflict = (operation: string) =>
  new VoiceError({
    reason: "invalid-context",
    operation,
    detail: "Voice conversation entry id was reused with different content",
    retryable: false,
  });

const mapRepositoryError = (operation: string) => (cause: { readonly _tag?: string }) =>
  cause._tag === "VoiceConversationEpochConflictError"
    ? staleEpoch(operation)
    : cause._tag === "VoiceConversationEntryConflictError"
      ? entryConflict(operation)
      : cause._tag === "VoiceConversationNotFoundError"
        ? conversationNotFound(operation)
        : repositoryError(operation)(cause);

const invalidCursor = (cause?: unknown) =>
  new VoiceError({
    reason: "invalid-context",
    operation: "conversation.transcript.cursor",
    detail: "Voice conversation transcript cursor is invalid",
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });

const invalidListCursor = (cause?: unknown) =>
  new VoiceError({
    reason: "invalid-context",
    operation: "conversation.list.cursor",
    detail: "Voice conversation list cursor is invalid",
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });

const decodeListCursor = (cursor: string) =>
  Effect.try({
    try: () => Buffer.from(cursor, "base64url").toString("utf8"),
    catch: invalidListCursor,
  }).pipe(Effect.flatMap(decodeConversationListCursorJson), Effect.mapError(invalidListCursor));

const encodeListCursor = (cursor: typeof ConversationListCursor.Type) =>
  Buffer.from(encodeConversationListCursorJson(cursor), "utf8").toString("base64url");

const decodeCursor = (conversationId: VoiceConversationId, cursor: string) =>
  Effect.try({
    try: () => Buffer.from(cursor, "base64url").toString("utf8"),
    catch: invalidCursor,
  }).pipe(
    Effect.flatMap(decodeTranscriptCursorJson),
    Effect.mapError(invalidCursor),
    Effect.flatMap((decoded) =>
      decoded.conversationId === conversationId
        ? Effect.succeed(decoded)
        : Effect.fail(invalidCursor()),
    ),
  );

const encodeCursor = (cursor: typeof TranscriptCursor.Type) =>
  Buffer.from(encodeTranscriptCursorJson(cursor), "utf8").toString("base64url");

const truncateText = (text: string) => {
  if (text.length <= VOICE_CONVERSATION_TRANSCRIPT_ENTRY_MAX_CHARS) {
    return { text, truncated: false } as const;
  }
  return {
    text: text.slice(0, VOICE_CONVERSATION_TRANSCRIPT_ENTRY_MAX_CHARS),
    truncated: true,
  } as const;
};

const fitNewestEntry = (entry: VoiceConversationTranscriptRow, maxBytes: number) => {
  let candidate = { ...entry, ...truncateText(entry.text) };
  if (textEncoder.encode(encodeTranscriptEntryJson(candidate)).byteLength + 1 <= maxBytes) {
    return candidate;
  }
  let low = 0;
  let high = candidate.text.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const attempt = { ...candidate, text: candidate.text.slice(0, midpoint), truncated: true };
    if (textEncoder.encode(encodeTranscriptEntryJson(attempt)).byteLength + 1 <= maxBytes) {
      low = midpoint;
    } else high = midpoint - 1;
  }
  candidate = { ...candidate, text: candidate.text.slice(0, low), truncated: true };
  return candidate;
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* VoiceConversationRepository;
  const ephemeral = yield* SynchronizedRef.make<EphemeralState>({
    conversations: new Map(),
    entries: new Map(),
    clears: new Map(),
  });

  const create: VoiceConversationServiceShape["create"] = Effect.fn(
    "VoiceConversationService.create",
  )(function* (input) {
    const conversationId = VoiceConversationId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const now = DateTime.formatIso(yield* DateTime.now);
    if (input.retention === "durable") {
      return yield* repository
        .create({
          conversationId,
          retention: "durable",
          title: input.title ?? null,
          createdAt: now,
        })
        .pipe(Effect.map(mapDurable), Effect.mapError(repositoryError("conversation.create")));
    }
    const conversation: EphemeralConversation = {
      conversationId,
      retention: "ephemeral",
      title: input.title ?? null,
      activeEpoch: 1,
      lastCallAt: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* SynchronizedRef.update(ephemeral, (current) => {
      const conversations = new Map(current.conversations);
      const entries = new Map(current.entries);
      conversations.set(conversationId, conversation);
      entries.set(conversationId, []);
      return { ...current, conversations, entries };
    });
    return conversation;
  });

  const listDurable: VoiceConversationServiceShape["listDurable"] = Effect.fn(
    "VoiceConversationService.listDurable",
  )(function* (query) {
    const cursor = query.cursor === undefined ? undefined : yield* decodeListCursor(query.cursor);
    const page = yield* repository
      .list({
        limit: query.limit ?? DEFAULT_CONVERSATION_LIST_LIMIT,
        ...(cursor === undefined
          ? {}
          : {
              beforeUpdatedAt: cursor.updatedAt,
              beforeConversationId: cursor.conversationId,
            }),
      })
      .pipe(Effect.mapError(repositoryError("conversation.list")));
    const conversations = page.conversations.map(mapDurable);
    const last = conversations.at(-1);
    return {
      conversations,
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeListCursor({
              version: 1,
              updatedAt: last.updatedAt,
              conversationId: last.conversationId,
            })
          : null,
    } satisfies VoiceConversationListPage;
  });

  const get: VoiceConversationServiceShape["get"] = (conversationId) =>
    Effect.gen(function* () {
      const inMemory = (yield* SynchronizedRef.get(ephemeral)).conversations.get(conversationId);
      if (inMemory !== undefined) return Option.some(inMemory);
      return yield* repository
        .get({ conversationId })
        .pipe(
          Effect.map(Option.map(mapDurable)),
          Effect.mapError(repositoryError("conversation.get")),
        );
    });

  const deleteConversation: VoiceConversationServiceShape["delete"] = (conversationId) =>
    SynchronizedRef.modify(ephemeral, (current) => {
      if (!current.conversations.has(conversationId)) return [false, current] as const;
      const conversations = new Map(current.conversations);
      const entries = new Map(current.entries);
      conversations.delete(conversationId);
      entries.delete(conversationId);
      const clears = new Map(
        [...current.clears].filter(([key]) => !key.startsWith(`${conversationId}:`)),
      );
      return [true, { conversations, entries, clears }] as const;
    }).pipe(
      Effect.flatMap((deletedEphemeral) =>
        deletedEphemeral
          ? Effect.succeed(true)
          : repository
              .delete({ conversationId })
              .pipe(Effect.mapError(repositoryError("conversation.delete"))),
      ),
    );

  const updateTitle: VoiceConversationServiceShape["updateTitle"] = Effect.fn(
    "VoiceConversationService.updateTitle",
  )(function* (conversationId, input) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const inMemory = yield* SynchronizedRef.modify(ephemeral, (current) => {
      const existing = current.conversations.get(conversationId);
      if (existing === undefined) return [undefined, current] as const;
      const updated = { ...existing, title: input.title, updatedAt: now };
      const conversations = new Map(current.conversations);
      conversations.set(conversationId, updated);
      return [updated, { ...current, conversations }] as const;
    });
    if (inMemory !== undefined) return inMemory;
    const updated = yield* repository
      .updateTitle({ conversationId, title: input.title, updatedAt: now })
      .pipe(Effect.mapError(repositoryError("conversation.update-title")));
    if (Option.isNone(updated)) return yield* conversationNotFound("conversation.update-title");
    return mapDurable(updated.value);
  });

  const markCallStarted: VoiceConversationServiceShape["markCallStarted"] = Effect.fn(
    "VoiceConversationService.markCallStarted",
  )(function* (conversationId, expectedEpoch) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const inMemory = yield* SynchronizedRef.modifyEffect(ephemeral, (current) => {
      const existing = current.conversations.get(conversationId);
      if (existing === undefined) return Effect.succeed([undefined, current] as const);
      if (existing.activeEpoch !== expectedEpoch) {
        return Effect.fail(staleEpoch("conversation.call-started"));
      }
      const updated = { ...existing, lastCallAt: now, updatedAt: now };
      const conversations = new Map(current.conversations);
      conversations.set(conversationId, updated);
      return Effect.succeed([updated, { ...current, conversations }] as const);
    });
    if (inMemory !== undefined) return inMemory;
    return yield* repository
      .markCallStarted({ conversationId, expectedEpoch, startedAt: now })
      .pipe(
        Effect.map(mapDurable),
        Effect.mapError(mapRepositoryError("conversation.call-started")),
      );
  });

  const clearContext: VoiceConversationServiceShape["clearContext"] = Effect.fn(
    "VoiceConversationService.clearContext",
  )(function* (conversationId, expectedEpoch, idempotencyKey) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const inMemory = yield* SynchronizedRef.modifyEffect(ephemeral, (current) => {
      const clearKey = `${conversationId}:${idempotencyKey}`;
      const previous = current.clears.get(clearKey);
      if (previous !== undefined) return Effect.succeed([previous, current] as const);
      const existing = current.conversations.get(conversationId);
      if (existing === undefined) return Effect.succeed([undefined, current] as const);
      if (existing.activeEpoch !== expectedEpoch)
        return Effect.fail(staleEpoch("conversation.clear"));
      const updated = { ...existing, activeEpoch: existing.activeEpoch + 1, updatedAt: now };
      const conversations = new Map(current.conversations);
      const clears = new Map(current.clears);
      conversations.set(conversationId, updated);
      const result = { activeEpoch: updated.activeEpoch, clearedAt: now };
      clears.set(clearKey, result);
      return Effect.succeed([result, { ...current, conversations, clears }] as const);
    });
    if (inMemory !== undefined) {
      return { conversationId, ...inMemory };
    }
    const existing = yield* repository
      .get({ conversationId })
      .pipe(Effect.mapError(repositoryError("conversation.clear.get")));
    if (Option.isNone(existing)) {
      return yield* conversationNotFound("conversation.clear");
    }
    const entryId = VoiceConversationEntryId.make(
      `context-clear:${conversationId}:${idempotencyKey}`,
    );
    const updated = yield* repository
      .clearContext({
        conversationId,
        entryId,
        expectedEpoch,
        clearedAt: now,
      })
      .pipe(Effect.mapError(mapRepositoryError("conversation.clear")));
    return {
      conversationId,
      activeEpoch: updated.conversation.activeEpoch,
      clearedAt: updated.clearedAt,
    };
  });

  const listContext: VoiceConversationServiceShape["listContext"] = (
    conversationId,
    expectedEpoch,
  ) =>
    Effect.gen(function* () {
      const inMemory = yield* SynchronizedRef.get(ephemeral);
      const conversation = inMemory.conversations.get(conversationId);
      const entries = inMemory.entries.get(conversationId);
      if (conversation !== undefined && entries !== undefined) {
        if (conversation.activeEpoch !== expectedEpoch) {
          return yield* staleEpoch("conversation.context.list");
        }
        return entries.filter((entry) => entry.epoch === expectedEpoch);
      }
      return yield* repository
        .listContext({ conversationId, expectedEpoch })
        .pipe(Effect.mapError(mapRepositoryError("conversation.context.list")));
    });

  const appendWithEntryId = Effect.fn("VoiceConversationService.appendWithEntryId")(
    function* (input: {
      readonly entryId: VoiceConversationEntryId;
      readonly conversationId: VoiceConversationId;
      readonly expectedEpoch: number;
      readonly kind: VoiceConversationJournalEntry["kind"];
      readonly payload: unknown;
    }) {
      const conversation = yield* get(input.conversationId);
      if (Option.isNone(conversation)) {
        return yield* new VoiceError({
          reason: "conversation-not-found",
          operation: "conversation.context.append",
          detail: "Voice conversation was not found",
          retryable: false,
        });
      }
      if (conversation.value.activeEpoch !== input.expectedEpoch) {
        return yield* staleEpoch("conversation.context.append");
      }
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      if (conversation.value.retention === "durable") {
        return yield* repository
          .append({
            entryId: input.entryId,
            conversationId: input.conversationId,
            expectedEpoch: input.expectedEpoch,
            kind: input.kind,
            payload: input.payload,
            occurredAt,
          })
          .pipe(Effect.mapError(mapRepositoryError("conversation.context.append")));
      }
      const inputPayloadJson = yield* encodeJournalPayload(input.payload).pipe(
        Effect.mapError(repositoryError("conversation.context.append")),
      );
      return yield* SynchronizedRef.modifyEffect(ephemeral, (current) => {
        const currentConversation = current.conversations.get(input.conversationId);
        if (currentConversation === undefined) {
          return Effect.fail(conversationNotFound("conversation.context.append"));
        }
        if (currentConversation.activeEpoch !== input.expectedEpoch) {
          return Effect.fail(staleEpoch("conversation.context.append"));
        }
        const entries = current.entries.get(input.conversationId) ?? [];
        const existing = entries.find((entry) => entry.entryId === input.entryId);
        if (existing !== undefined) {
          return encodeJournalPayload(existing.payload).pipe(
            Effect.mapError(repositoryError("conversation.context.append")),
            Effect.flatMap((existingPayloadJson) =>
              existing.kind !== input.kind || existingPayloadJson !== inputPayloadJson
                ? Effect.fail(entryConflict("conversation.context.append"))
                : Effect.succeed([existing, current] as const),
            ),
          );
        }
        const entry: VoiceConversationJournalEntry = {
          entryId: input.entryId,
          conversationId: input.conversationId,
          epoch: input.expectedEpoch,
          sequence: entries.length + 1,
          kind: input.kind,
          payload: input.payload,
          occurredAt,
        };
        const nextEntries = new Map(current.entries);
        nextEntries.set(input.conversationId, [...entries, entry]);
        return Effect.succeed([entry, { ...current, entries: nextEntries }] as const);
      });
    },
  );

  const appendContext: VoiceConversationServiceShape["appendContext"] = (input) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.flatMap((uuid) =>
        appendWithEntryId({
          ...input,
          entryId: VoiceConversationEntryId.make(`voice-entry:${uuid}`),
        }),
      ),
    );

  const appendContextIdempotent: VoiceConversationServiceShape["appendContextIdempotent"] =
    appendWithEntryId;

  const listTranscript: VoiceConversationServiceShape["listTranscript"] = Effect.fn(
    "VoiceConversationService.listTranscript",
  )(function* (conversationId, query) {
    const conversation = yield* repository
      .get({ conversationId })
      .pipe(Effect.mapError(repositoryError("conversation.transcript.get")));
    if (Option.isNone(conversation)) return yield* conversationNotFound("conversation.transcript");

    const cursor =
      query.cursor === undefined ? undefined : yield* decodeCursor(conversationId, query.cursor);
    const snapshotThroughSequence =
      cursor?.snapshotThroughSequence ??
      (yield* repository
        .getTranscriptSnapshotSequence({ conversationId })
        .pipe(Effect.mapError(repositoryError("conversation.transcript.snapshot"))));
    const beforeSequence = cursor?.beforeSequence ?? snapshotThroughSequence + 1;
    const limit = query.limit ?? DEFAULT_TRANSCRIPT_LIMIT;
    const page = yield* repository
      .listTranscript({ conversationId, snapshotThroughSequence, beforeSequence, limit })
      .pipe(Effect.mapError(repositoryError("conversation.transcript.list")));

    const selected = [] as Array<{
      readonly entryId: VoiceConversationEntryId;
      readonly contextEpoch: number;
      readonly sequence: number;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly truncated: boolean;
      readonly occurredAt: string;
    }>;
    let bytes = 2;
    for (let index = page.entries.length - 1; index >= 0; index -= 1) {
      const row = page.entries[index];
      if (row === undefined) continue;
      const entry =
        selected.length === 0
          ? fitNewestEntry(row, TRANSCRIPT_ENTRIES_MAX_BYTES - bytes)
          : { ...row, ...truncateText(row.text) };
      const entryBytes = textEncoder.encode(encodeTranscriptEntryJson(entry)).byteLength + 1;
      if (bytes + entryBytes > TRANSCRIPT_ENTRIES_MAX_BYTES) break;
      selected.push(entry);
      bytes += entryBytes;
    }
    selected.reverse();
    const omittedForBytes = selected.length < page.entries.length;
    const oldest = selected[0];
    const nextCursor =
      oldest !== undefined && (page.hasMore || omittedForBytes)
        ? encodeCursor({
            version: 1,
            conversationId,
            snapshotThroughSequence,
            beforeSequence: oldest.sequence,
          })
        : null;
    return {
      conversationId,
      activeContextEpoch: conversation.value.activeEpoch,
      entries: selected,
      nextCursor,
    };
  });

  return VoiceConversationService.of({
    create,
    listDurable,
    get,
    updateTitle,
    markCallStarted,
    delete: deleteConversation,
    clearContext,
    listTranscript,
    listContext,
    appendContext,
    appendContextIdempotent,
  });
});

export const VoiceConversationServiceLive = Layer.effect(VoiceConversationService, make);

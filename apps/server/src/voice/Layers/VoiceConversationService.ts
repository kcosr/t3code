import { VoiceConversationId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  VoiceConversationRepository,
  type DurableVoiceConversation,
  type VoiceConversationJournalEntry,
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
  readonly createdAt: string;
  readonly updatedAt: string;
};

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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* VoiceConversationRepository;
  const ephemeral = yield* SynchronizedRef.make<
    ReadonlyMap<VoiceConversationId, EphemeralConversation>
  >(new Map());
  const ephemeralEntries = yield* SynchronizedRef.make<
    ReadonlyMap<VoiceConversationId, ReadonlyArray<VoiceConversationJournalEntry>>
  >(new Map());

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
      createdAt: now,
      updatedAt: now,
    };
    yield* SynchronizedRef.update(ephemeral, (current) => {
      const next = new Map(current);
      next.set(conversationId, conversation);
      return next;
    });
    yield* SynchronizedRef.update(ephemeralEntries, (current) => {
      const next = new Map(current);
      next.set(conversationId, []);
      return next;
    });
    return conversation;
  });

  const listDurable = repository.list().pipe(
    Effect.map((conversations) => conversations.map(mapDurable)),
    Effect.mapError(repositoryError("conversation.list")),
  );

  const get: VoiceConversationServiceShape["get"] = (conversationId) =>
    Effect.gen(function* () {
      const inMemory = (yield* SynchronizedRef.get(ephemeral)).get(conversationId);
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
      if (!current.has(conversationId)) return [false, current] as const;
      const next = new Map(current);
      next.delete(conversationId);
      return [true, next] as const;
    }).pipe(
      Effect.flatMap((deletedEphemeral) =>
        deletedEphemeral
          ? Effect.succeed(true)
          : repository
              .delete({ conversationId })
              .pipe(Effect.mapError(repositoryError("conversation.delete"))),
      ),
      Effect.tap((deleted) =>
        deleted
          ? SynchronizedRef.update(ephemeralEntries, (current) => {
              const next = new Map(current);
              next.delete(conversationId);
              return next;
            })
          : Effect.void,
      ),
    );

  const clearContext: VoiceConversationServiceShape["clearContext"] = Effect.fn(
    "VoiceConversationService.clearContext",
  )(function* (conversationId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const inMemory = yield* SynchronizedRef.modify(ephemeral, (current) => {
      const existing = current.get(conversationId);
      if (existing === undefined) return [undefined, current] as const;
      const updated = { ...existing, activeEpoch: existing.activeEpoch + 1, updatedAt: now };
      const next = new Map(current);
      next.set(conversationId, updated);
      return [updated, next] as const;
    });
    if (inMemory !== undefined) {
      yield* SynchronizedRef.update(ephemeralEntries, (current) => {
        const next = new Map(current);
        next.set(conversationId, []);
        return next;
      });
      return { conversationId, activeEpoch: inMemory.activeEpoch, clearedAt: now };
    }
    const existing = yield* repository
      .get({ conversationId })
      .pipe(Effect.mapError(repositoryError("conversation.clear.get")));
    if (Option.isNone(existing)) {
      return yield* new VoiceError({
        reason: "conversation-not-found",
        operation: "conversation.clear",
        detail: "Voice conversation was not found",
        retryable: false,
      });
    }
    const entryId = `context-clear:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
    const updated = yield* repository
      .clearContext({
        conversationId,
        entryId,
        expectedEpoch: existing.value.activeEpoch,
        clearedAt: now,
      })
      .pipe(Effect.mapError(repositoryError("conversation.clear")));
    return { conversationId, activeEpoch: updated.activeEpoch, clearedAt: now };
  });

  const listContext: VoiceConversationServiceShape["listContext"] = (conversationId) =>
    Effect.gen(function* () {
      const inMemory = yield* SynchronizedRef.get(ephemeralEntries);
      const entries = inMemory.get(conversationId);
      if (entries !== undefined) return entries;
      return yield* repository
        .listContext({ conversationId })
        .pipe(Effect.mapError(repositoryError("conversation.context.list")));
    });

  const appendWithEntryId = Effect.fn("VoiceConversationService.appendWithEntryId")(
    function* (input: {
      readonly entryId: string;
      readonly conversationId: VoiceConversationId;
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
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      if (conversation.value.retention === "durable") {
        return yield* repository
          .append({
            entryId: input.entryId,
            conversationId: input.conversationId,
            expectedEpoch: conversation.value.activeEpoch,
            kind: input.kind,
            payload: input.payload,
            occurredAt,
          })
          .pipe(Effect.mapError(repositoryError("conversation.context.append")));
      }
      return yield* SynchronizedRef.modify(ephemeralEntries, (current) => {
        const entries = current.get(input.conversationId) ?? [];
        const existing = entries.find((entry) => entry.entryId === input.entryId);
        if (existing !== undefined) return [existing, current] as const;
        const entry: VoiceConversationJournalEntry = {
          entryId: input.entryId,
          conversationId: input.conversationId,
          epoch: conversation.value.activeEpoch,
          sequence: entries.length + 1,
          kind: input.kind,
          payload: input.payload,
          occurredAt,
        };
        const next = new Map(current);
        next.set(input.conversationId, [...entries, entry]);
        return [entry, next] as const;
      });
    },
  );

  const appendContext: VoiceConversationServiceShape["appendContext"] = (input) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.flatMap((uuid) => appendWithEntryId({ ...input, entryId: `voice-entry:${uuid}` })),
    );

  const appendContextIdempotent: VoiceConversationServiceShape["appendContextIdempotent"] =
    appendWithEntryId;

  return VoiceConversationService.of({
    create,
    listDurable,
    get,
    delete: deleteConversation,
    clearContext,
    listContext,
    appendContext,
    appendContextIdempotent,
  });
});

export const VoiceConversationServiceLive = Layer.effect(VoiceConversationService, make);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { VoiceConversationEntryId, VoiceConversationTranscriptPage } from "@t3tools/contracts";

import { VoiceConversationRepositoryLive } from "../../persistence/Layers/VoiceConversations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { VoiceConversationService } from "../Services/VoiceConversationService.ts";
import { VoiceConversationServiceLive } from "./VoiceConversationService.ts";

const layer = VoiceConversationServiceLive.pipe(
  Layer.provide(VoiceConversationRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);
const encodeTranscriptPage = Schema.encodeSync(
  Schema.fromJsonString(VoiceConversationTranscriptPage),
);

it.effect("keeps ephemeral conversations out of durable history", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const ephemeral = yield* conversations.create({ retention: "ephemeral", title: "Temporary" });
    const durable = yield* conversations.create({ retention: "durable", title: "Continue later" });

    expect(
      (yield* conversations.listDurable({})).conversations.map((item) => item.conversationId),
    ).toEqual([durable.conversationId]);
    expect(Option.getOrNull(yield* conversations.get(ephemeral.conversationId))).toMatchObject({
      retention: "ephemeral",
      title: "Temporary",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("clears context epochs and hard deletes both retention modes", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const ephemeral = yield* conversations.create({ retention: "ephemeral" });
    const durable = yield* conversations.create({ retention: "durable" });

    expect(
      (yield* conversations.clearContext(ephemeral.conversationId, 1, "clear-ephemeral"))
        .activeEpoch,
    ).toBe(2);
    const durableClear = yield* conversations.clearContext(
      durable.conversationId,
      1,
      "clear-durable",
    );
    expect(durableClear.activeEpoch).toBe(2);
    expect(yield* conversations.clearContext(durable.conversationId, 1, "clear-durable")).toEqual(
      durableClear,
    );
    expect(yield* conversations.delete(ephemeral.conversationId)).toBe(true);
    expect(yield* conversations.delete(durable.conversationId)).toBe(true);
    expect(Option.isNone(yield* conversations.get(ephemeral.conversationId))).toBe(true);
    expect(Option.isNone(yield* conversations.get(durable.conversationId))).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("appends explicit journal identities idempotently for both retention modes", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    for (const retention of ["ephemeral", "durable"] as const) {
      const conversation = yield* conversations.create({ retention });
      const input = {
        entryId: VoiceConversationEntryId.make(`tool-result-${retention}`),
        conversationId: conversation.conversationId,
        expectedEpoch: 1,
        kind: "tool-result" as const,
        payload: { toolCallId: "call-one", outcome: "succeeded" },
      };
      const first = yield* conversations.appendContextIdempotent(input);
      const duplicate = yield* conversations.appendContextIdempotent(input);
      expect(duplicate).toEqual(first);
      expect(yield* conversations.listContext(conversation.conversationId, 1)).toHaveLength(1);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects changed reuse of an ephemeral journal entry id", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const conversation = yield* conversations.create({ retention: "ephemeral" });
    const input = {
      entryId: VoiceConversationEntryId.make("ephemeral-conflict"),
      conversationId: conversation.conversationId,
      expectedEpoch: 1,
      kind: "transcript.user" as const,
      payload: { text: "original" },
    };
    yield* conversations.appendContextIdempotent(input);
    const changed = yield* conversations
      .appendContextIdempotent({ ...input, payload: { text: "changed" } })
      .pipe(Effect.flip);
    expect(changed.reason).toBe("invalid-context");
  }).pipe(Effect.provide(layer)),
);

it.effect("pages every durable conversation and rejects invalid list cursors", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const created: Array<{ readonly conversationId: string; readonly updatedAt: string }> = [];
    for (let index = 0; index < 105; index += 1) {
      const conversation = yield* conversations.create({
        retention: "durable",
        title: `Conversation ${index}`,
      });
      created.push(conversation);
    }

    const traversed: Array<string> = [];
    let cursor: string | undefined;
    do {
      const page = yield* conversations.listDurable({
        limit: 17,
        ...(cursor === undefined ? {} : { cursor }),
      });
      traversed.push(...page.conversations.map(({ conversationId }) => conversationId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(traversed).toHaveLength(105);
    expect(new Set(traversed).size).toBe(105);
    expect(traversed).toEqual(
      [...created]
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.conversationId.localeCompare(right.conversationId),
        )
        .map(({ conversationId }) => conversationId),
    );

    const invalid = yield* conversations.listDurable({ cursor: "not-a-cursor" }).pipe(Effect.flip);
    expect(invalid.reason).toBe("invalid-context");
  }).pipe(Effect.provide(layer)),
);

it.effect("records call starts separately from rename and clear timestamps", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const conversation = yield* conversations.create({ retention: "durable" });
    expect(conversation.lastCallAt).toBeNull();
    const called = yield* conversations.markCallStarted(conversation.conversationId, 1);
    expect(called.lastCallAt).not.toBeNull();
    const renamed = yield* conversations.updateTitle(conversation.conversationId, {
      title: "Renamed",
    });
    expect(renamed.lastCallAt).toBe(called.lastCallAt);
    yield* conversations.clearContext(conversation.conversationId, 1, "clear-after-call");
    const reloaded = Option.getOrThrow(yield* conversations.get(conversation.conversationId));
    expect(reloaded.lastCallAt).toBe(called.lastCallAt);
    const stale = yield* conversations
      .markCallStarted(conversation.conversationId, 1)
      .pipe(Effect.flip);
    expect(stale.reason).toBe("invalid-context");
  }).pipe(Effect.provide(layer)),
);

it.effect("pages a stable redacted transcript across context epochs", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const conversation = yield* conversations.create({ retention: "durable", title: "History" });
    yield* conversations.appendContext({
      conversationId: conversation.conversationId,
      expectedEpoch: 1,
      kind: "transcript.user",
      payload: { text: "first", providerCallId: "must-not-leak" },
    });
    yield* conversations.appendContext({
      conversationId: conversation.conversationId,
      expectedEpoch: 1,
      kind: "tool-request",
      payload: { argumentsJson: "secret-tool-arguments" },
    });
    yield* conversations.clearContext(conversation.conversationId, 1, "clear-history");
    yield* conversations.appendContext({
      conversationId: conversation.conversationId,
      expectedEpoch: 2,
      kind: "transcript.assistant",
      payload: { text: "second", internalError: "must-not-leak" },
    });

    const first = yield* conversations.listTranscript(conversation.conversationId, { limit: 1 });
    expect(first.activeContextEpoch).toBe(2);
    expect(first.entries).toMatchObject([{ contextEpoch: 2, role: "assistant", text: "second" }]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.entries[0]).not.toHaveProperty("payload");
    expect(first.entries[0]).not.toHaveProperty("kind");

    yield* conversations.appendContext({
      conversationId: conversation.conversationId,
      expectedEpoch: 2,
      kind: "transcript.user",
      payload: { text: "appended after snapshot" },
    });
    const second = yield* conversations.listTranscript(conversation.conversationId, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.entries).toMatchObject([{ contextEpoch: 1, role: "user", text: "first" }]);
    expect(second.nextCursor).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect("requires the expected epoch for ephemeral appends and idempotent clears", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const conversation = yield* conversations.create({ retention: "ephemeral" });
    const first = yield* conversations.clearContext(conversation.conversationId, 1, "same-clear");
    const duplicate = yield* conversations.clearContext(
      conversation.conversationId,
      1,
      "same-clear",
    );
    expect(duplicate).toEqual(first);
    const stale = yield* conversations
      .appendContext({
        conversationId: conversation.conversationId,
        expectedEpoch: 1,
        kind: "transcript.user",
        payload: { text: "late" },
      })
      .pipe(Effect.flip);
    expect(stale.reason).toBe("invalid-context");
    const staleRead = yield* conversations
      .listContext(conversation.conversationId, 1)
      .pipe(Effect.flip);
    expect(staleRead.reason).toBe("invalid-context");
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects invalid, cross-conversation, and ephemeral transcript cursors", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const first = yield* conversations.create({ retention: "durable" });
    const second = yield* conversations.create({ retention: "durable" });
    const ephemeral = yield* conversations.create({ retention: "ephemeral" });
    for (const text of ["one", "two"]) {
      yield* conversations.appendContext({
        conversationId: first.conversationId,
        expectedEpoch: 1,
        kind: "transcript.user",
        payload: { text },
      });
    }
    const page = yield* conversations.listTranscript(first.conversationId, { limit: 1 });
    const invalid = yield* conversations
      .listTranscript(first.conversationId, { cursor: "not-a-cursor" })
      .pipe(Effect.flip);
    expect(invalid.reason).toBe("invalid-context");
    const crossConversation = yield* conversations
      .listTranscript(second.conversationId, { cursor: page.nextCursor! })
      .pipe(Effect.flip);
    expect(crossConversation.reason).toBe("invalid-context");
    const ephemeralResult = yield* conversations
      .listTranscript(ephemeral.conversationId, {})
      .pipe(Effect.flip);
    expect(ephemeralResult.reason).toBe("conversation-not-found");
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds transcript page bytes without skipping entries", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const conversation = yield* conversations.create({ retention: "durable" });
    for (let index = 1; index <= 6; index += 1) {
      yield* conversations.appendContext({
        conversationId: conversation.conversationId,
        expectedEpoch: 1,
        kind: index % 2 === 0 ? "transcript.assistant" : "transcript.user",
        payload: { text: `${index}:${"\n".repeat(16_500)}` },
      });
    }

    const sequences: Array<number> = [];
    let cursor: string | undefined;
    do {
      const page = yield* conversations.listTranscript(conversation.conversationId, {
        limit: 6,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(new TextEncoder().encode(encodeTranscriptPage(page)).byteLength).toBeLessThanOrEqual(
        64 * 1_024,
      );
      expect(page.entries.every(({ truncated }) => truncated)).toBe(true);
      sequences.unshift(...page.entries.map(({ sequence }) => sequence));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
  }).pipe(Effect.provide(layer)),
);

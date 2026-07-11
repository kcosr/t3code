import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VoiceConversationRepositoryLive } from "../../persistence/Layers/VoiceConversations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { VoiceConversationService } from "../Services/VoiceConversationService.ts";
import { VoiceConversationServiceLive } from "./VoiceConversationService.ts";

const layer = VoiceConversationServiceLive.pipe(
  Layer.provide(VoiceConversationRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

it.effect("keeps ephemeral conversations out of durable history", () =>
  Effect.gen(function* () {
    const conversations = yield* VoiceConversationService;
    const ephemeral = yield* conversations.create({ retention: "ephemeral", title: "Temporary" });
    const durable = yield* conversations.create({ retention: "durable", title: "Continue later" });

    expect((yield* conversations.listDurable).map((item) => item.conversationId)).toEqual([
      durable.conversationId,
    ]);
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

    expect((yield* conversations.clearContext(ephemeral.conversationId)).activeEpoch).toBe(2);
    expect((yield* conversations.clearContext(durable.conversationId)).activeEpoch).toBe(2);
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
        entryId: `tool-result-${retention}`,
        conversationId: conversation.conversationId,
        kind: "tool-result" as const,
        payload: { toolCallId: "call-one", outcome: "succeeded" },
      };
      const first = yield* conversations.appendContextIdempotent(input);
      const duplicate = yield* conversations.appendContextIdempotent(input);
      expect(duplicate).toEqual(first);
      expect(yield* conversations.listContext(conversation.conversationId)).toHaveLength(1);
    }
  }).pipe(Effect.provide(layer)),
);

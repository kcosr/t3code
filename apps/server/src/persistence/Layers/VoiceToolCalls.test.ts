import { assert, it } from "@effect/vitest";
import {
  CommandId,
  VoiceConfirmationId,
  VoiceConversationId,
  VoiceSessionId,
  VoiceToolCallId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VoiceConversationRepository } from "../Services/VoiceConversations.ts";
import { VoiceToolCallRepository } from "../Services/VoiceToolCalls.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VoiceConversationRepositoryLive } from "./VoiceConversations.ts";
import { VoiceToolCallRepositoryLive } from "./VoiceToolCalls.ts";

const layer = it.layer(
  Layer.mergeAll(VoiceConversationRepositoryLive, VoiceToolCallRepositoryLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

layer("VoiceToolCallRepository", (it) => {
  it.effect("persists requested, pending, and terminal state idempotently", () =>
    Effect.gen(function* () {
      const conversations = yield* VoiceConversationRepository;
      const calls = yield* VoiceToolCallRepository;
      const conversationId = VoiceConversationId.make("conversation-tool-persistence");
      const toolCallId = VoiceToolCallId.make("tool-call-one");
      const sessionId = VoiceSessionId.make("session-one");
      yield* conversations.create({
        conversationId,
        retention: "durable",
        title: null,
        createdAt: "2026-07-10T12:00:00.000Z",
      });

      const request = {
        conversationId,
        toolCallId,
        providerFunctionCallId: "provider-call-one",
        toolName: "archive_thread",
        canonicalArgumentsJson: '{"threadId":"thread-one"}',
        sessionId,
        createdAt: "2026-07-10T12:00:01.000Z",
      };
      const created = yield* calls.createRequested(request);
      const duplicate = yield* calls.createRequested(request);
      assert.isTrue(created.created);
      assert.isFalse(duplicate.created);
      assert.strictEqual(duplicate.call.status, "requested");

      const confirmationId = VoiceConfirmationId.make("confirmation-one");
      const commandId = CommandId.make(`voice:${conversationId}:${toolCallId}`);
      const pending = yield* calls.markPending({
        conversationId,
        toolCallId,
        sessionId,
        confirmationId,
        summary: "Archive thread",
        commandId,
        commandJson: '{"type":"thread.archive"}',
        updatedAt: "2026-07-10T12:00:02.000Z",
        expiresAt: "2026-07-10T12:00:32.000Z",
      });
      assert.strictEqual(pending.status, "pending-confirmation");
      assert.strictEqual(pending.commandId, commandId);
      assert.deepEqual(Option.getOrNull(yield* calls.getByConfirmationId(confirmationId)), pending);

      const terminal = yield* calls.markTerminal({
        conversationId,
        toolCallId,
        status: "succeeded",
        resultOutput: '{"sequence":42}',
        updatedAt: "2026-07-10T12:00:03.000Z",
      });
      assert.strictEqual(terminal.status, "succeeded");
      assert.strictEqual(terminal.resultOutput, '{"sequence":42}');

      const ignoredReplay = yield* calls.markTerminal({
        conversationId,
        toolCallId,
        status: "failed",
        resultOutput: '{"error":"late"}',
        updatedAt: "2026-07-10T12:00:04.000Z",
      });
      assert.strictEqual(ignoredReplay.status, "succeeded");
      assert.strictEqual(ignoredReplay.resultOutput, '{"sequence":42}');
    }),
  );

  it.effect("deletes tool-call records with their durable conversation", () =>
    Effect.gen(function* () {
      const conversations = yield* VoiceConversationRepository;
      const calls = yield* VoiceToolCallRepository;
      const conversationId = VoiceConversationId.make("conversation-tool-cascade");
      const toolCallId = VoiceToolCallId.make("tool-call-cascade");
      yield* conversations.create({
        conversationId,
        retention: "durable",
        title: null,
        createdAt: "2026-07-10T12:01:00.000Z",
      });
      yield* calls.createRequested({
        conversationId,
        toolCallId,
        providerFunctionCallId: "provider-call-cascade",
        toolName: "list_projects",
        canonicalArgumentsJson: '{"limit":10}',
        sessionId: VoiceSessionId.make("session-cascade"),
        createdAt: "2026-07-10T12:01:01.000Z",
      });
      yield* conversations.delete({ conversationId });
      assert.isTrue(Option.isNone(yield* calls.get({ conversationId, toolCallId })));
    }),
  );
});

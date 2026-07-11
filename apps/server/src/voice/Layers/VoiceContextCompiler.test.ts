import { expect, it } from "@effect/vitest";
import { VoiceConversationId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { VoiceConversationJournalEntry } from "../../persistence/Services/VoiceConversations.ts";
import { VoiceContextCompiler } from "../Services/VoiceContextCompiler.ts";
import { VoiceContextCompilerLive } from "./VoiceContextCompiler.ts";

const conversationId = VoiceConversationId.make("conversation-1");
const entry = (
  sequence: number,
  kind: VoiceConversationJournalEntry["kind"],
  payload: unknown,
): VoiceConversationJournalEntry => ({
  entryId: `entry-${sequence}`,
  conversationId,
  epoch: 1,
  sequence,
  kind,
  payload,
  occurredAt: `2026-07-10T20:00:0${sequence}.000Z`,
});

it.effect("compiles normalized journal entries without provider state", () =>
  Effect.gen(function* () {
    const compiler = yield* VoiceContextCompiler;
    const compiled = yield* compiler.compile({
      tokenBudget: 1_000,
      entries: [
        entry(1, "summary", { version: 1, text: "The user is working in T3." }),
        entry(2, "transcript.user", { text: "Open my active thread." }),
        entry(3, "tool-result", { tool: "get_thread_status", outcome: "succeeded" }),
        entry(4, "call-boundary", { reason: "handoff" }),
      ],
    });

    expect(compiled.items).toEqual([
      { role: "system", text: "Voice conversation summary v1: The user is working in T3." },
      { role: "user", text: "Open my active thread." },
      { role: "system", text: "T3 tool get_thread_status succeeded" },
    ]);
    expect(compiled.includedThroughSequence).toBe(3);
  }).pipe(Effect.provide(VoiceContextCompilerLive)),
);

it.effect("selects the newest complete items within the token budget", () =>
  Effect.gen(function* () {
    const compiler = yield* VoiceContextCompiler;
    const compiled = yield* compiler.compile({
      tokenBudget: 3,
      entries: [
        entry(1, "transcript.user", { text: "this older entry is too long" }),
        entry(2, "transcript.assistant", { text: "short" }),
      ],
    });

    expect(compiled.items).toEqual([{ role: "assistant", text: "short" }]);
  }).pipe(Effect.provide(VoiceContextCompilerLive)),
);

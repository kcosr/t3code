import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VoiceConversationJournalEntry } from "../../persistence/Services/VoiceConversations.ts";
import type { RealtimeContextItem } from "./VoiceProvider.ts";

export interface VoiceCompiledContext {
  readonly items: ReadonlyArray<RealtimeContextItem>;
  readonly includedThroughSequence: number;
  readonly estimatedTokens: number;
}

export interface VoiceContextCompilerShape {
  readonly compile: (input: {
    readonly entries: ReadonlyArray<VoiceConversationJournalEntry>;
    readonly tokenBudget: number;
  }) => Effect.Effect<VoiceCompiledContext>;
}

export class VoiceContextCompiler extends Context.Service<
  VoiceContextCompiler,
  VoiceContextCompilerShape
>()("t3/voice/Services/VoiceContextCompiler") {}

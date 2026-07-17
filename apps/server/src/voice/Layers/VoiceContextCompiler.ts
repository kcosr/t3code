import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { VoiceConversationJournalEntry } from "../../persistence/Services/VoiceConversations.ts";
import {
  VoiceContextCompiler,
  type VoiceCompiledContext,
  type VoiceContextCompilerShape,
} from "../Services/VoiceContextCompiler.ts";
import type { RealtimeContextItem } from "../Services/VoiceProvider.ts";

const TranscriptPayload = Schema.Struct({ text: Schema.String });
const SummaryPayload = Schema.Struct({ version: Schema.Number, text: Schema.String });
const ToolResultPayload = Schema.Struct({
  tool: Schema.String,
  outcome: Schema.String,
  result: Schema.optionalKey(Schema.String),
});
const ContextChangePayload = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
});

const decodeTranscript = Schema.decodeUnknownExit(TranscriptPayload);
const decodeSummary = Schema.decodeUnknownExit(SummaryPayload);
const decodeToolResult = Schema.decodeUnknownExit(ToolResultPayload);
const decodeContextChange = Schema.decodeUnknownExit(ContextChangePayload);

const UNTRUSTED_HISTORY_TOOLS = new Set(["search_history", "read_history"]);

export const voiceFocusContextItem = (focus: {
  readonly projectId?: string;
  readonly threadId?: string;
}): RealtimeContextItem | undefined => {
  const targets = [
    focus.projectId === undefined ? undefined : `project ${focus.projectId}`,
    focus.threadId === undefined ? undefined : `thread ${focus.threadId}`,
  ].filter((target): target is string => target !== undefined);
  return targets.length === 0
    ? undefined
    : { role: "system", text: `Active T3 context: ${targets.join(", ")}` };
};

const entryToItem = (entry: VoiceConversationJournalEntry): RealtimeContextItem | undefined => {
  switch (entry.kind) {
    case "transcript.user":
    case "transcript.assistant": {
      const decoded = decodeTranscript(entry.payload);
      if (decoded._tag === "Failure" || decoded.value.text.trim().length === 0) return undefined;
      return {
        role: entry.kind === "transcript.user" ? "user" : "assistant",
        text: decoded.value.text.trim(),
      };
    }
    case "summary": {
      const decoded = decodeSummary(entry.payload);
      if (decoded._tag === "Failure" || decoded.value.text.trim().length === 0) return undefined;
      return {
        role: "system",
        text: `Voice conversation summary v${decoded.value.version}: ${decoded.value.text.trim()}`,
      };
    }
    case "tool-result": {
      const decoded = decodeToolResult(entry.payload);
      if (decoded._tag === "Failure") return undefined;
      const payload = decoded.value;
      // History results contain user-authored transcript text. Older journals may still have
      // captured that text, so never elevate it to a system item during context replay.
      const safeResult = UNTRUSTED_HISTORY_TOOLS.has(payload.tool) ? undefined : payload.result;
      const suffix = safeResult === undefined ? "" : `: ${safeResult}`;
      return {
        role: "system",
        text: `T3 tool ${payload.tool} ${payload.outcome}${suffix}`,
      };
    }
    case "context-change": {
      const decoded = decodeContextChange(entry.payload);
      if (decoded._tag === "Failure") return undefined;
      return voiceFocusContextItem(decoded.value);
    }
    case "call-boundary":
    case "device-handoff":
    case "context-cleared":
    case "tool-request":
      return undefined;
  }
};

const estimateTokens = (item: RealtimeContextItem): number =>
  Math.max(1, Math.ceil(item.text.length / 4));

const compile: VoiceContextCompilerShape["compile"] = Effect.fn("VoiceContextCompiler.compile")(
  function* ({ entries, tokenBudget }) {
    const candidates = entries.flatMap((entry) => {
      const item = entryToItem(entry);
      return item === undefined ? [] : [{ item, sequence: entry.sequence }];
    });
    const selected: Array<(typeof candidates)[number]> = [];
    let used = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      const size = estimateTokens(candidate.item);
      if (used + size > tokenBudget) continue;
      selected.push(candidate);
      used += size;
    }
    selected.reverse();
    return {
      items: selected.map(({ item }) => item),
      includedThroughSequence: selected.at(-1)?.sequence ?? 0,
      estimatedTokens: used,
    } satisfies VoiceCompiledContext;
  },
);

export const VoiceContextCompilerLive = Layer.succeed(VoiceContextCompiler, { compile });

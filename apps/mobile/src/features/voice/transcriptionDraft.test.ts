import { VoiceRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyTranscriptionEvent,
  beginTranscriptionDraft,
  renderTranscriptionDraft,
} from "./transcriptionDraft";

const REQUEST_ID = VoiceRequestId.make("request-1");

describe("transcriptionDraft", () => {
  it("preserves the existing composer text while deltas stream", () => {
    const started = beginTranscriptionDraft("Review this change.");
    const first = applyTranscriptionEvent(started, {
      type: "delta",
      requestId: REQUEST_ID,
      text: "Then ",
    });
    const second = applyTranscriptionEvent(first, {
      type: "delta",
      requestId: REQUEST_ID,
      text: "run tests",
    });

    expect(renderTranscriptionDraft(second)).toBe("Review this change. Then run tests");
  });

  it("uses the authoritative final transcript without duplicating deltas", () => {
    const partial = applyTranscriptionEvent(beginTranscriptionDraft(""), {
      type: "delta",
      requestId: REQUEST_ID,
      text: "helo",
    });
    const final = applyTranscriptionEvent(partial, {
      type: "final",
      result: { requestId: REQUEST_ID, text: "hello" },
    });

    expect(renderTranscriptionDraft(final)).toBe("hello");
  });
});

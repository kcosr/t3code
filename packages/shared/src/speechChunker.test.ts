import { describe, expect, it } from "vite-plus/test";

import { appendSpeechText, initialSpeechChunkerState } from "./speechChunker.js";

describe("speechChunker", () => {
  it("emits complete phrases before the text response finishes", () => {
    const first = appendSpeechText(
      initialSpeechChunkerState(),
      "This is the first complete sentence. The next",
      false,
      { minimumChars: 10, maximumChars: 80 },
    );
    expect(first.segments).toEqual([
      { index: 0, text: "This is the first complete sentence.", finalSegment: false },
    ]);
    expect(first.state.buffer).toBe("The next");

    const second = appendSpeechText(first.state, " sentence finishes now.", true, {
      minimumChars: 10,
      maximumChars: 80,
    });
    expect(second.segments).toEqual([
      { index: 1, text: "The next sentence finishes now.", finalSegment: false },
    ]);
    expect(second.state.finished).toBe(true);
  });

  it("flushes a final partial phrase", () => {
    const result = appendSpeechText(initialSpeechChunkerState(), "A short final answer", true);
    expect(result.segments).toEqual([
      { index: 0, text: "A short final answer", finalSegment: true },
    ]);
  });

  it("bounds long text at a word boundary", () => {
    const result = appendSpeechText(
      initialSpeechChunkerState(),
      "alpha beta gamma delta epsilon",
      false,
      { minimumChars: 5, maximumChars: 18 },
    );
    expect(result.segments[0]).toEqual({
      index: 0,
      text: "alpha beta gamma",
      finalSegment: false,
    });
  });

  it("rejects appends after completion", () => {
    const finished = appendSpeechText(initialSpeechChunkerState(), "done", true).state;
    expect(() => appendSpeechText(finished, "more", false)).toThrow(
      "Cannot append text after speech chunking has finished",
    );
  });
});

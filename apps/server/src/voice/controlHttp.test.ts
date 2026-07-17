import { describe, expect, it } from "vite-plus/test";

import { __testing } from "./controlHttp.ts";

describe("voice capability descriptors", () => {
  it("advertises the enforceable Android transcription upload policy", () => {
    expect(
      __testing.descriptor("transcription.request", "ready", {
        maxUploadBytes: 32 * 1024 * 1024,
        maxInputDurationSeconds: 30 * 60,
        maxSpeechTextBytes: 8 * 1024,
      }),
    ).toEqual({
      capability: "transcription.request",
      state: "ready",
      inputFormats: ["audio/mp4"],
      outputFormats: [],
      maxInputBytes: 32 * 1024 * 1024,
      maxInputDurationSeconds: 30 * 60,
    });
  });

  it("advertises the enforceable speech input limit", () => {
    expect(
      __testing.descriptor("speech.streaming", "ready", {
        maxUploadBytes: 32 * 1024 * 1024,
        maxInputDurationSeconds: 30 * 60,
        maxSpeechTextBytes: 8 * 1024,
      }),
    ).toEqual({
      capability: "speech.streaming",
      state: "ready",
      inputFormats: [],
      outputFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
      maxInputBytes: 8 * 1024,
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { __testing } from "./controlHttp.ts";

describe("voice capability descriptors", () => {
  it("advertises the enforceable Android transcription upload policy", () => {
    expect(
      __testing.descriptor("transcription.request", "ready", {
        maxUploadBytes: 32 * 1024 * 1024,
        maxInputDurationSeconds: 30 * 60,
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
});

import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { __testing } from "./controlHttp.ts";

describe("voice capability descriptors", () => {
  it("caps native runtime authority at the earlier parent-session expiry", () => {
    const now = DateTime.makeUnsafe("2026-07-13T00:00:00.000Z");
    expect(
      DateTime.formatIso(
        __testing.nativeRuntimeExpiresAt(now, DateTime.makeUnsafe("2026-07-13T03:00:00.000Z")),
      ),
    ).toBe("2026-07-13T03:00:00.000Z");
    expect(DateTime.formatIso(__testing.nativeRuntimeExpiresAt(now))).toBe(
      "2026-08-12T00:00:00.000Z",
    );
  });

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

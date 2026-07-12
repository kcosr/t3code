import { describe, expect, it } from "vite-plus/test";

import { validateRecordingAgainstCapability } from "./dictationPolicy";

const capability = {
  capability: "transcription.request" as const,
  state: "ready" as const,
  inputFormats: ["audio/mp4" as const],
  outputFormats: [],
  maxInputBytes: 32 * 1024 * 1024,
  maxInputDurationSeconds: 30 * 60,
};

describe("dictation capability preflight", () => {
  it("accepts recordings at the advertised limits", () => {
    expect(() =>
      validateRecordingAgainstCapability(
        { byteLength: 32 * 1024 * 1024, durationMs: 30 * 60 * 1_000 },
        capability,
      ),
    ).not.toThrow();
  });

  it("rejects recordings over the advertised byte or duration limit", () => {
    expect(() =>
      validateRecordingAgainstCapability(
        { byteLength: 32 * 1024 * 1024 + 1, durationMs: 1_000 },
        capability,
      ),
    ).toThrow("Recording is too large for this environment");
    expect(() =>
      validateRecordingAgainstCapability(
        { byteLength: 1, durationMs: 30 * 60 * 1_000 + 1 },
        capability,
      ),
    ).toThrow("Recording is too long for this environment");
  });
});

import { describe, expect, it } from "vite-plus/test";

import type {
  T3VoiceNativeModule,
  T3VoiceRecordingTerminatedEvent,
} from "@t3tools/mobile-voice-native";
import { validateRecordingAgainstCapability } from "./dictationPolicy";
import {
  discardOrphanedRecordingTerminationIfUnowned,
  dictationTerminationOwnership,
} from "./dictationTermination";

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

describe("orphaned dictation termination cleanup", () => {
  it("keeps a redelivered completion owned while its recording is being transcribed", () => {
    expect(
      dictationTerminationOwnership({
        recordingId: "recording-a",
        activeRecordingId: null,
        stoppingRecordingId: null,
        transcribingRecordingId: "recording-a",
      }),
    ).toBe("transcribing");
    expect(
      dictationTerminationOwnership({
        recordingId: "recording-b",
        activeRecordingId: null,
        stoppingRecordingId: null,
        transcribingRecordingId: "recording-a",
      }),
    ).toBe("orphaned");
  });

  it("delegates orphan ownership cleanup atomically to native", async () => {
    const calls: Array<unknown> = [];
    const native = {
      discardUnownedRecordingTerminationAsync: async (input: unknown) => {
        calls.push(input);
        return false;
      },
    } as unknown as T3VoiceNativeModule;
    const event = {
      ownerDomain: "COMPOSER_DICTATION",
      operationId: "operation-a",
      recordingId: "recording-a",
      recording: null,
      outcome: "cancelled",
      reason: "no-speech",
    } as T3VoiceRecordingTerminatedEvent;

    await expect(discardOrphanedRecordingTerminationIfUnowned(native, event)).resolves.toBe(false);
    expect(calls).toEqual([{ operationId: "operation-a" }]);
  });
});

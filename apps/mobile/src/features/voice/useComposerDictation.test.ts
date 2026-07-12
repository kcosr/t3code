import { describe, expect, it } from "vite-plus/test";

import type {
  T3VoiceNativeModule,
  T3VoiceRecordingTerminatedEvent,
} from "@t3tools/mobile-voice-native";
import { validateRecordingAgainstCapability } from "./dictationPolicy";
import { cleanupOrphanedRecordingTermination } from "./dictationTermination";

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
  it("deletes retained completed audio", async () => {
    const calls: Array<unknown> = [];
    const native = {
      deleteRecordingAsync: async (input: unknown) => {
        calls.push(["delete", input]);
      },
      acknowledgeRecordingTerminationAsync: async (input: unknown) => {
        calls.push(["acknowledge", input]);
      },
    } as unknown as T3VoiceNativeModule;
    const event: T3VoiceRecordingTerminatedEvent = {
      recordingId: "recording-a",
      recording: {
        recordingId: "recording-a",
        uri: "file:///recording-a.m4a",
        mimeType: "audio/mp4",
        durationMs: 1_000,
        byteLength: 4_096,
      },
      outcome: "completed",
      reason: "speech-ended",
    };

    await cleanupOrphanedRecordingTermination(native, event);

    expect(calls).toEqual([
      ["delete", { recordingId: "recording-a", uri: "file:///recording-a.m4a" }],
    ]);
  });

  it.each(["cancelled", "failed"] as const)("acknowledges %s outcomes", async (outcome) => {
    const calls: Array<unknown> = [];
    const native = {
      deleteRecordingAsync: async (input: unknown) => {
        calls.push(["delete", input]);
      },
      acknowledgeRecordingTerminationAsync: async (input: unknown) => {
        calls.push(["acknowledge", input]);
      },
    } as unknown as T3VoiceNativeModule;
    const event = {
      recordingId: "recording-a",
      recording: null,
      outcome,
      reason: outcome === "cancelled" ? "no-speech" : "finalization-failed",
    } as T3VoiceRecordingTerminatedEvent;

    await cleanupOrphanedRecordingTermination(native, event);

    expect(calls).toEqual([["acknowledge", { recordingId: "recording-a" }]]);
  });
});

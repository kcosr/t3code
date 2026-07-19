import { VoiceRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type {
  T3VoiceNativeModule,
  T3VoiceRecordingTerminatedEvent,
} from "@t3tools/mobile-voice-native";

import {
  applyTranscriptionEvent,
  beginTranscriptionDraft,
  canStartComposerDictation,
  cleanupOrphanedRecordingTermination,
  dictationTerminationOwnership,
  renderTranscriptionDraft,
  validateRecordingAgainstCapability,
} from "./composerDictationPolicy";

const capability = {
  capability: "transcription.request" as const,
  state: "ready" as const,
  inputFormats: ["audio/mp4" as const],
  outputFormats: [],
  maxInputBytes: 32 * 1024 * 1024,
  maxInputDurationSeconds: 30 * 60,
};

const REQUEST_ID = VoiceRequestId.make("request-1");

describe("canStartComposerDictation", () => {
  it("rejects a stale idle render after native recording ownership was acquired", () => {
    expect(
      canStartComposerDictation({
        phase: "idle",
        startPending: false,
        activeRecordingId: "recording-1",
        stoppingRecordingId: null,
        transcribingRecordingId: null,
      }),
    ).toBe(false);
  });

  it("admits only a fully idle dictation lifecycle", () => {
    expect(
      canStartComposerDictation({
        phase: "idle",
        startPending: false,
        activeRecordingId: null,
        stoppingRecordingId: null,
        transcribingRecordingId: null,
      }),
    ).toBe(true);
    expect(
      canStartComposerDictation({
        phase: "idle",
        startPending: false,
        activeRecordingId: null,
        stoppingRecordingId: "recording-1",
        transcribingRecordingId: null,
      }),
    ).toBe(false);
  });
});

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

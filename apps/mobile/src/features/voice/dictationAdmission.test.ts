import { describe, expect, it } from "vite-plus/test";

import { canStartComposerDictation } from "./dictationAdmission";

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

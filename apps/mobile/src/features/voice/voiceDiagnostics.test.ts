import { describe, expect, it } from "vitest";

import { formatVoiceDiagnostics } from "./voiceDiagnostics";

describe("formatVoiceDiagnostics", () => {
  it("exports bounded detector measurements without adding content fields", () => {
    const output = formatVoiceDiagnostics([
      {
        elapsedRealtimeMillis: 1_000,
        generation: 4,
        category: "endpoint",
        code: "endpoint-terminated",
        primaryCount: 0,
        secondaryCount: 0,
        endpointElapsedMs: 3_500,
        levelDbfsBucket: -39,
        noiseFloorDbfsBucket: -54,
        releaseThresholdDbfsBucket: -45,
        speechConfirmed: true,
        silenceElapsedMs: 2_250,
        silenceResetCount: 2,
      },
    ]);

    expect(JSON.parse(output)).toEqual({
      version: 1,
      entries: [
        expect.objectContaining({
          category: "endpoint",
          code: "endpoint-terminated",
          silenceResetCount: 2,
        }),
      ],
    });
    expect(output).not.toMatch(/transcript|audio|text|sdp|credential/i);
  });

  it("drops native fields outside the redacted export allowlist", () => {
    const output = formatVoiceDiagnostics([
      {
        elapsedRealtimeMillis: 1,
        generation: 1,
        category: "state",
        code: "active",
        primaryCount: 0,
        secondaryCount: 0,
        transcript: "must not leave the device",
        providerPayload: "must not leave the device",
      } as never,
    ]);

    expect(output).not.toContain("must not leave the device");
    expect(JSON.parse(output).entries[0]).toEqual({
      elapsedRealtimeMillis: 1,
      generation: 1,
      category: "state",
      code: "active",
      primaryCount: 0,
      secondaryCount: 0,
    });
  });

  it("accepts the native Realtime drain timeout code", () => {
    const output = formatVoiceDiagnostics([
      {
        elapsedRealtimeMillis: 5_000,
        generation: 8,
        category: "terminal",
        code: "realtime-drain-timed-out",
        primaryCount: 1,
        secondaryCount: 0,
      },
    ]);

    expect(JSON.parse(output).entries[0].code).toBe("realtime-drain-timed-out");
  });
});

import { describe, expect, it } from "vitest";

import {
  assertVoiceRuntimeProtocolAvailable,
  VoiceRuntimeProtocolIncompatibleError,
  voiceRuntimeProtocolAvailability,
} from "./protocol.ts";

describe("voice runtime protocol compatibility", () => {
  it("reports the canonical protocol as available", () => {
    expect(voiceRuntimeProtocolAvailability({ voiceRuntimeProtocolMajor: 1 })).toEqual({
      status: "available",
      protocolMajor: 1,
    });
    expect(() =>
      assertVoiceRuntimeProtocolAvailable({ voiceRuntimeProtocolMajor: 1 }),
    ).not.toThrow();
  });

  it("reports and rejects an incompatible environment without fallback", () => {
    const availability = voiceRuntimeProtocolAvailability({ voiceRuntimeProtocolMajor: 2 });
    expect(availability).toEqual({
      status: "unavailable",
      reason: "incompatible-protocol-major",
      requiredMajor: 1,
      actualMajor: 2,
    });
    expect(() => assertVoiceRuntimeProtocolAvailable({ voiceRuntimeProtocolMajor: 2 })).toThrow(
      VoiceRuntimeProtocolIncompatibleError,
    );
  });
});

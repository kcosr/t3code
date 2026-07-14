import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  VoiceRuntimeRealtimeHandoffExchangeInput,
  VoiceRuntimeRealtimeSessionCreateInput,
  VoiceRuntimeRealtimeWebRtcOfferInput,
} from "./voiceRuntime.ts";

const strict = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema as never)(value, { onExcessProperty: "error" });

describe("Realtime runtime contracts", () => {
  const fence = {
    runtimeId: "runtime-contract",
    runtimeInstanceId: "instance-contract",
    generation: 3,
    modeSessionId: "mode-contract",
  };

  it("requires the complete process and authority fence", () => {
    expect(
      strict(VoiceRuntimeRealtimeSessionCreateInput, {
        ...fence,
        clientOperationId: "start-contract",
      }),
    ).toMatchObject(fence);
    expect(() =>
      strict(VoiceRuntimeRealtimeSessionCreateInput, {
        runtimeId: fence.runtimeId,
        generation: fence.generation,
        modeSessionId: fence.modeSessionId,
        clientOperationId: "start-contract",
      }),
    ).toThrow();
    expect(() =>
      strict(VoiceRuntimeRealtimeWebRtcOfferInput, {
        ...fence,
        leaseGeneration: 1,
        clientOperationId: "offer-contract",
        sdp: "offer",
        legacySessionId: "not-accepted",
      }),
    ).toThrow();
  });

  it("validates a complete exact Thread transition request", () => {
    expect(
      strict(VoiceRuntimeRealtimeHandoffExchangeInput, {
        ...fence,
        leaseGeneration: 7,
        clientOperationId: "handoff-contract",
        actionSequence: 9,
        nextGeneration: 4,
        threadModeSessionId: "thread-mode-contract",
        environmentId: "environment-contract",
        speechPreset: "default",
        endpointPolicy: {
          endSilenceMs: 2_200,
          noSpeechTimeoutMs: null,
          maximumUtteranceMs: 600_000,
        },
        speechEnabled: true,
        rearmGuardMs: 500,
      }),
    ).toMatchObject({ nextGeneration: 4, threadModeSessionId: "thread-mode-contract" });
  });
});

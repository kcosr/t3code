import { expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { VoiceProviderAdapter } from "./VoiceProvider.ts";
import { makeVoiceProviderRegistry } from "./VoiceProviderRegistry.ts";

const fakeProvider: VoiceProviderAdapter = {
  id: "fake",
  capabilities: new Set(["transcription.request"]),
  transcriber: {
    transcribe: (request) =>
      Stream.make({
        type: "final",
        result: { requestId: request.requestId, text: "fake transcript" },
      }),
  },
};

it.effect("resolves providers by capability without exposing vendor contracts", () =>
  Effect.gen(function* () {
    const registry = makeVoiceProviderRegistry(
      [fakeProvider],
      new Map([["transcription.request", "fake"]]),
    );
    const provider = yield* registry.resolve("transcription.request");
    const events = yield* provider
      .transcriber!.transcribe({
        requestId: "voice-request-1" as never,
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "audio/wav",
      })
      .pipe(Stream.runCollect);

    expect(Array.from(events)).toEqual([
      {
        type: "final",
        result: { requestId: "voice-request-1", text: "fake transcript" },
      },
    ]);
  }),
);

it.effect("fails explicitly when a capability has no selected provider", () =>
  Effect.gen(function* () {
    const registry = makeVoiceProviderRegistry([fakeProvider], new Map());
    const error = yield* Effect.flip(registry.resolve("speech.streaming"));

    expect(error.reason).toBe("not-configured");
  }),
);

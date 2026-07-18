import { expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { VoiceProviderAdapter } from "./VoiceProvider.ts";
import {
  makeDynamicVoiceProviderRegistry,
  makeVoiceProviderRegistry,
} from "./VoiceProviderRegistry.ts";

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

const openAi: VoiceProviderAdapter = {
  id: "openai",
  capabilities: new Set(["transcription.request", "speech.streaming", "agent.realtime"]),
};

const speechServer: VoiceProviderAdapter = {
  id: "openai-speech-server",
  capabilities: new Set(["transcription.request", "speech.streaming"]),
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

it.effect("observes selection changes for subsequent resolves", () =>
  Effect.gen(function* () {
    const selection = yield* Ref.make("openai");
    const registry = makeDynamicVoiceProviderRegistry([openAi, speechServer], (capability) =>
      capability === "agent.realtime" ? Effect.succeed("openai") : Ref.get(selection),
    );

    expect((yield* registry.resolve("transcription.request")).id).toBe("openai");
    yield* Ref.set(selection, "openai-speech-server");
    expect((yield* registry.resolve("transcription.request")).id).toBe("openai-speech-server");
    expect((yield* registry.resolve("agent.realtime")).id).toBe("openai");
  }),
);

it.effect("never resolves realtime to the speech-server adapter", () =>
  Effect.gen(function* () {
    const registry = makeDynamicVoiceProviderRegistry([openAi, speechServer], () =>
      Effect.succeed("openai-speech-server"),
    );
    const error = yield* Effect.flip(registry.resolve("agent.realtime"));
    expect(error.reason).toBe("not-configured");
  }),
);

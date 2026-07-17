import { expect, it } from "@effect/vitest";
import { VoiceRequestId, VoiceSessionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { observeVoiceMediaStream, voiceDiagnostic } from "./VoiceObservability.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);

it("builds correlated voice diagnostics without accepting content-bearing fields", () => {
  expect(
    voiceDiagnostic({
      type: "session-ended",
      sessionId: VoiceSessionId.make("voice-session-1"),
      leaseGeneration: 2,
      outcome: "error",
      reason: "provider-closed",
      previousPhase: "speaking",
      sessionDurationMs: 12_345,
      providerAttached: true,
      providerActivityObserved: true,
    }),
  ).toEqual({
    level: "warning",
    message: "voice.session.ended",
    annotations: {
      sessionId: VoiceSessionId.make("voice-session-1"),
      leaseGeneration: 2,
      outcome: "error",
      reason: "provider-closed",
      previousPhase: "speaking",
      sessionDurationMs: 12_345,
      providerAttached: true,
      providerActivityObserved: true,
    },
  });
  expect(
    voiceDiagnostic({
      type: "provider-sideband-attached",
      sessionId: VoiceSessionId.make("voice-session-1"),
      leaseGeneration: 2,
      outcome: "success",
      durationMs: 87,
    }),
  ).toEqual({
    level: "info",
    message: "voice.provider.sideband-attach",
    annotations: {
      sessionId: "voice-session-1",
      leaseGeneration: 2,
      outcome: "success",
      durationMs: 87,
    },
  });
});

it.effect("logs successful and failed media stream completion", () => {
  const messages: Array<ReadonlyArray<unknown>> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    messages.push(message as ReadonlyArray<unknown>);
  });
  return Effect.gen(function* () {
    yield* observeVoiceMediaStream(Stream.make(new Uint8Array(3), new Uint8Array(2)), {
      operation: "speech",
      requestId: VoiceRequestId.make("voice-request-success"),
      inputBytes: 5,
    }).pipe(Stream.runDrain);
    yield* observeVoiceMediaStream(Stream.fail("provider-failed"), {
      operation: "transcription",
      requestId: VoiceRequestId.make("voice-request-failure"),
      inputBytes: 855,
      inputDurationMs: 1_000,
    }).pipe(Stream.runDrain, Effect.flip);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject([
      "voice.media.completed",
      {
        operation: "speech",
        requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        outcome: "success",
        inputBytes: 5,
        outputBytes: 5,
      },
    ]);
    expect(messages[1]).toMatchObject([
      "voice.media.completed",
      {
        operation: "transcription",
        requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        outcome: "failure",
        inputBytes: 855,
        inputDurationMs: 1_000,
        outputBytes: 0,
      },
    ]);

    const streamStarted = yield* Deferred.make<void>();
    const interrupted = yield* observeVoiceMediaStream(
      Stream.fromEffectDrain(Deferred.succeed(streamStarted, undefined)).pipe(
        Stream.concat(Stream.never),
      ),
      {
        operation: "speech",
        requestId: VoiceRequestId.make("voice-request-cancelled"),
      },
    ).pipe(Stream.runDrain, Effect.forkChild);
    yield* Deferred.await(streamStarted);
    yield* Fiber.interrupt(interrupted);
    expect(messages[2]).toMatchObject([
      "voice.media.completed",
      {
        operation: "speech",
        requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        outcome: "cancelled",
        outputBytes: 0,
      },
    ]);
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it("reports media counters and timings without text, audio, or provider payloads", () => {
  const privateRequestId = VoiceRequestId.make("PRIVATE transcript\napi-key");
  const diagnostic = voiceDiagnostic({
    type: "media-completed",
    operation: "speech",
    requestId: privateRequestId,
    outcome: "success",
    durationMs: 420,
    firstByteMs: 120,
    inputBytes: 14,
    outputBytes: 48_000,
  });
  expect(diagnostic).toEqual({
    level: "info",
    message: "voice.media.completed",
    annotations: {
      operation: "speech",
      requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      outcome: "success",
      durationMs: 420,
      firstByteMs: 120,
      inputBytes: 14,
      outputBytes: 48_000,
    },
  });
  expect(Object.keys(diagnostic.annotations)).not.toContain("text");
  expect(Object.keys(diagnostic.annotations)).not.toContain("audio");
  expect(Object.keys(diagnostic.annotations)).not.toContain("providerMessage");
  expect(encodeUnknownJson(diagnostic)).not.toContain(privateRequestId);
  expect(encodeUnknownJson(diagnostic)).not.toContain("PRIVATE transcript");
});

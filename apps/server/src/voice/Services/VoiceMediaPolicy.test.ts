import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  boundVoiceByteStream,
  boundVoiceMediaEffect,
  validateVoiceMultipartShape,
  VoiceMediaRequestLimiter,
  VoiceMediaRequestLimiterLive,
} from "./VoiceMediaPolicy.ts";

describe("VoiceMediaPolicy", () => {
  it.effect("accepts exactly one audio file and one metadata field in either order", () =>
    Effect.gen(function* () {
      yield* validateVoiceMultipartShape([
        { kind: "file", key: "audio" },
        { kind: "field", key: "metadata" },
      ]);
      yield* validateVoiceMultipartShape([
        { kind: "field", key: "metadata" },
        { kind: "file", key: "audio" },
      ]);
    }),
  );

  it.effect("rejects missing, duplicate, and unexpected multipart parts", () =>
    Effect.gen(function* () {
      for (const parts of [
        [{ kind: "file" as const, key: "audio" }],
        [
          { kind: "file" as const, key: "audio" },
          { kind: "file" as const, key: "audio" },
        ],
        [
          { kind: "file" as const, key: "audio" },
          { kind: "field" as const, key: "metadata" },
          { kind: "field" as const, key: "extra" },
        ],
      ]) {
        const error = yield* validateVoiceMultipartShape(parts).pipe(Effect.flip);
        assert.equal(error.reason, "invalid-multipart");
      }
    }),
  );

  it.effect("rejects concurrency and releases each permit idempotently", () =>
    Effect.gen(function* () {
      const limiter = yield* VoiceMediaRequestLimiter;
      const first = yield* limiter.acquire(1);
      const error = yield* limiter.acquire(1).pipe(Effect.flip);
      assert.equal(error.reason, "quota-exceeded");
      yield* first.release;
      yield* first.release;
      const next = yield* limiter.acquire(1);
      yield* next.release;
    }).pipe(Effect.provide(VoiceMediaRequestLimiterLive)),
  );

  it.effect("fails instead of truncating when provider output crosses the byte limit", () =>
    Effect.gen(function* () {
      const error = yield* boundVoiceByteStream(Stream.make(new Uint8Array(3), new Uint8Array(3)), {
        maximumBytes: 5,
        firstByteTimeoutSeconds: 5,
        totalTimeoutSeconds: 5,
      }).pipe(Stream.runCollect, Effect.flip);
      assert.equal(error.reason, "payload-too-large");
    }),
  );

  it.effect("applies the short timeout only while waiting for the first chunk", () =>
    Effect.gen(function* () {
      const delayedSecondChunk = Stream.make(new Uint8Array([1])).pipe(
        Stream.concat(
          Stream.fromEffect(Effect.sleep("2 seconds").pipe(Effect.as(new Uint8Array([2])))),
        ),
      );
      const fiber = yield* boundVoiceByteStream(delayedSecondChunk, {
        maximumBytes: 2,
        firstByteTimeoutSeconds: 1,
        totalTimeoutSeconds: 5,
      }).pipe(Stream.runCollect, Effect.forkChild);
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      const output = yield* Fiber.join(fiber);
      assert.deepEqual(
        Array.from(output, (chunk) => Array.from(chunk)),
        [[1], [2]],
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("times out before the first chunk and releases an acquired permit", () =>
    Effect.gen(function* () {
      const limiter = yield* VoiceMediaRequestLimiter;
      const permit = yield* limiter.acquire(1);
      const fiber = yield* boundVoiceMediaEffect(Effect.never, 1).pipe(
        Effect.ensuring(permit.release),
        Effect.flip,
        Effect.forkChild,
      );
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      assert.equal(error.reason, "request-timeout");
      const next = yield* limiter.acquire(1);
      yield* next.release;
    }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), VoiceMediaRequestLimiterLive))),
  );
});

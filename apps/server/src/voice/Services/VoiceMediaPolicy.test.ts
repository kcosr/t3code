import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  boundVoiceByteStream,
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
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Movie } from "mp4box";

import {
  inspectVoiceMp4,
  validateVoiceMp4ContainerLayout,
  validateVoiceMp4Info,
} from "./VoiceMp4Inspector.ts";

const movie = (overrides: Partial<Movie> = {}): Movie =>
  ({
    hasMoov: true,
    isFragmented: false,
    tracks: [
      {
        codec: "mp4a.40.2",
        nb_samples: 100,
        size: 8_000,
        samples_duration: 48_000,
        timescale: 24_000,
        audio: { sample_rate: 24_000, channel_count: 1, sample_size: 16 },
      },
    ],
    audioTracks: [],
    ...overrides,
  }) as unknown as Movie;

const validMovie = (): Movie => {
  const value = movie();
  return { ...value, audioTracks: value.tracks };
};

describe("VoiceMp4Inspector", () => {
  it.effect("accepts the reproducible ffmpeg AAC-LC mono fixture", () =>
    Effect.gen(function* () {
      // Generated with ffmpeg 6.1.1 from anullsrc at 24 kHz for 100 ms; metadata stripped.
      const bytes = NodeFS.readFileSync(
        new URL("./fixtures/silence-aac-lc-mono.m4a", import.meta.url),
      );
      assert.equal(
        NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        "f2eecd0066dd8d378b1fb9244ad4ff3946816d77544347688191d5d282b07fcf",
      );
      const result = yield* inspectVoiceMp4(bytes, 1);
      assert.equal(result.codec, "aac-lc");
      assert.equal(result.channelCount, 1);
      assert.equal(result.sampleRate, 24_000);
      assert.equal(result.byteLength, 855);
    }),
  );

  it.effect("accepts one or more media-data boxes but rejects missing data and fragments", () =>
    Effect.gen(function* () {
      yield* validateVoiceMp4ContainerLayout(1, 0);
      yield* validateVoiceMp4ContainerLayout(2, 0);
      assert.equal(
        (yield* validateVoiceMp4ContainerLayout(0, 0).pipe(Effect.flip)).reason,
        "invalid-media",
      );
      assert.equal(
        (yield* validateVoiceMp4ContainerLayout(1, 1).pipe(Effect.flip)).reason,
        "invalid-media",
      );
    }),
  );
  it.effect("accepts one complete mono AAC-LC track within the duration limit", () =>
    Effect.gen(function* () {
      const result = yield* validateVoiceMp4Info(validMovie(), {
        maximumDurationSeconds: 2,
        byteLength: 12_345,
      });
      assert.deepEqual(result, {
        mediaType: "audio/mp4",
        codec: "aac-lc",
        durationMilliseconds: 2_000,
        sampleRate: 24_000,
        channelCount: 1,
        byteLength: 12_345,
      });
    }),
  );

  it.effect("rejects fragmented, multi-track, encrypted, and non-AAC-LC media", () =>
    Effect.gen(function* () {
      const base = validMovie();
      const invalid = [
        { ...base, isFragmented: true },
        { ...base, tracks: [...base.tracks, base.tracks[0]!] },
        {
          ...base,
          tracks: [{ ...base.tracks[0]!, codec: "enca" }],
          audioTracks: [{ ...base.audioTracks[0]!, codec: "enca" }],
        },
        {
          ...base,
          tracks: [{ ...base.tracks[0]!, codec: "mp4a.40.5" }],
          audioTracks: [{ ...base.audioTracks[0]!, codec: "mp4a.40.5" }],
        },
      ];
      for (const value of invalid) {
        const error = yield* validateVoiceMp4Info(value, {
          maximumDurationSeconds: 120,
          byteLength: 1_000,
        }).pipe(Effect.flip);
        assert.equal(error.reason, "unsupported-media");
      }
    }),
  );

  it.effect("enforces mono, sample-rate, completeness, and duration", () =>
    Effect.gen(function* () {
      const base = validMovie();
      const stereo = {
        ...base.audioTracks[0]!,
        audio: { sample_rate: 24_000, channel_count: 2, sample_size: 16 },
      };
      assert.equal(
        (yield* validateVoiceMp4Info(
          { ...base, tracks: [stereo], audioTracks: [stereo] },
          { maximumDurationSeconds: 120, byteLength: 1_000 },
        ).pipe(Effect.flip)).reason,
        "unsupported-media",
      );
      assert.equal(
        (yield* validateVoiceMp4Info(base, {
          maximumDurationSeconds: 1,
          byteLength: 1_000,
        }).pipe(Effect.flip)).reason,
        "duration-limit",
      );
      const empty = { ...base.audioTracks[0]!, nb_samples: 0 };
      assert.equal(
        (yield* validateVoiceMp4Info(
          { ...base, tracks: [empty], audioTracks: [empty] },
          { maximumDurationSeconds: 120, byteLength: 1_000 },
        ).pipe(Effect.flip)).reason,
        "invalid-media",
      );
    }),
  );

  it.effect("rejects malformed and truncated bytes without exposing parser content", () =>
    Effect.gen(function* () {
      for (const bytes of [new Uint8Array(), new Uint8Array([0, 0, 0, 20, 0x66, 0x74])]) {
        const error = yield* inspectVoiceMp4(bytes, 120).pipe(Effect.flip);
        assert.equal(error.reason, "invalid-media");
        assert.notProperty(error, "bytes");
      }
    }),
  );
});

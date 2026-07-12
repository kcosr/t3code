import * as Effect from "effect/Effect";
import { createFile, type Movie } from "mp4box";

import { VoiceMediaPolicyError } from "./VoiceMediaPolicy.ts";

export interface ValidatedVoiceMp4 {
  readonly mediaType: "audio/mp4";
  readonly codec: "aac-lc";
  readonly durationMilliseconds: number;
  readonly sampleRate: number;
  readonly channelCount: 1;
  readonly byteLength: number;
}

const invalidMedia = () => new VoiceMediaPolicyError({ reason: "invalid-media" });
const unsupportedMedia = () => new VoiceMediaPolicyError({ reason: "unsupported-media" });

export const validateVoiceMp4ContainerLayout = (
  mediaDataBoxCount: number,
  movieFragmentBoxCount: number,
): Effect.Effect<void, VoiceMediaPolicyError> =>
  mediaDataBoxCount >= 1 && movieFragmentBoxCount === 0 ? Effect.void : Effect.fail(invalidMedia());

export const validateVoiceMp4Info = (
  info: Movie,
  options: { readonly maximumDurationSeconds: number; readonly byteLength: number },
): Effect.Effect<ValidatedVoiceMp4, VoiceMediaPolicyError> => {
  if (
    !info.hasMoov ||
    info.isFragmented ||
    info.tracks.length !== 1 ||
    info.audioTracks.length !== 1
  ) {
    return Effect.fail(unsupportedMedia());
  }
  const track = info.audioTracks[0];
  if (track === undefined || track.nb_samples <= 0 || track.size <= 0 || track.timescale <= 0) {
    return Effect.fail(invalidMedia());
  }
  if (track.codec !== "mp4a.40.2" || track.audio === undefined) {
    return Effect.fail(unsupportedMedia());
  }
  const { channel_count: channelCount, sample_rate: sampleRate } = track.audio;
  if (channelCount !== 1 || sampleRate < 8_000 || sampleRate > 48_000) {
    return Effect.fail(unsupportedMedia());
  }
  const durationSeconds = track.samples_duration / track.timescale;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return Effect.fail(invalidMedia());
  }
  if (durationSeconds > options.maximumDurationSeconds) {
    return Effect.fail(new VoiceMediaPolicyError({ reason: "duration-limit" }));
  }
  return Effect.succeed({
    mediaType: "audio/mp4",
    codec: "aac-lc",
    durationMilliseconds: Math.ceil(durationSeconds * 1_000),
    sampleRate,
    channelCount: 1,
    byteLength: options.byteLength,
  });
};

export const inspectVoiceMp4 = (
  bytes: Uint8Array,
  maximumDurationSeconds: number,
): Effect.Effect<ValidatedVoiceMp4, VoiceMediaPolicyError> =>
  Effect.try({
    try: () => {
      const file = createFile();
      let info: Movie | undefined;
      let parseFailed = false;
      file.onReady = (value) => {
        info = value;
      };
      file.onError = () => {
        parseFailed = true;
      };
      const copy = Uint8Array.from(bytes).buffer as ArrayBuffer & { fileStart: number };
      copy.fileStart = 0;
      file.appendBuffer(copy, true);
      file.flush();
      if (parseFailed || info === undefined) {
        throw invalidMedia();
      }
      return {
        info,
        mediaDataBoxCount: file.mdats.length,
        movieFragmentBoxCount: file.moofs.length,
      };
    },
    catch: (cause) => (cause instanceof VoiceMediaPolicyError ? cause : invalidMedia()),
  }).pipe(
    Effect.flatMap(({ info, mediaDataBoxCount, movieFragmentBoxCount }) =>
      validateVoiceMp4ContainerLayout(mediaDataBoxCount, movieFragmentBoxCount).pipe(
        Effect.andThen(
          validateVoiceMp4Info(info, { maximumDurationSeconds, byteLength: bytes.byteLength }),
        ),
      ),
    ),
  );

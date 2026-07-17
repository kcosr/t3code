import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

export const VOICE_MULTIPART_MAX_PARTS = 2;
export const VOICE_MULTIPART_METADATA_MAX_BYTES = 16 * 1024;
export const VOICE_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const VOICE_SPEECH_FIRST_BYTE_TIMEOUT_SECONDS = 15;
export const VOICE_SPEECH_REQUEST_MAX_BYTES = 16 * 1024;
export const VOICE_TRANSCRIPTION_OUTPUT_MAX_BYTES = 512 * 1024;

export type VoiceMediaPolicyReason =
  | "invalid-multipart"
  | "invalid-media"
  | "unsupported-media"
  | "payload-too-large"
  | "duration-limit"
  | "quota-exceeded"
  | "request-timeout";

export class VoiceMediaPolicyError extends Data.TaggedError("VoiceMediaPolicyError")<{
  readonly reason: VoiceMediaPolicyReason;
}> {}

export interface VoiceMultipartPartDescriptor {
  readonly kind: "field" | "file";
  readonly key: string;
}

export const validateVoiceMultipartShape = (
  parts: ReadonlyArray<VoiceMultipartPartDescriptor>,
): Effect.Effect<void, VoiceMediaPolicyError> => {
  const audioParts = parts.filter((part) => part.kind === "file" && part.key === "audio");
  const metadataParts = parts.filter((part) => part.kind === "field" && part.key === "metadata");
  return parts.length === VOICE_MULTIPART_MAX_PARTS &&
    audioParts.length === 1 &&
    metadataParts.length === 1
    ? Effect.void
    : Effect.fail(new VoiceMediaPolicyError({ reason: "invalid-multipart" }));
};

export interface VoiceMediaRequestLimiterShape {
  readonly acquire: (maximum: number) => Effect.Effect<VoiceMediaPermit, VoiceMediaPolicyError>;
}

export interface VoiceMediaPermit {
  readonly release: Effect.Effect<void>;
}

export class VoiceMediaRequestLimiter extends Context.Service<
  VoiceMediaRequestLimiter,
  VoiceMediaRequestLimiterShape
>()("t3/voice/Services/VoiceMediaPolicy/VoiceMediaRequestLimiter") {}

export const makeVoiceMediaRequestLimiter = Effect.gen(function* () {
  const active = yield* SynchronizedRef.make(0);
  const acquire = (maximum: number) =>
    SynchronizedRef.modify(active, (current) =>
      current >= maximum ? [false, current] : [true, current + 1],
    ).pipe(
      Effect.flatMap((acquired) =>
        acquired
          ? Effect.void
          : Effect.fail(new VoiceMediaPolicyError({ reason: "quota-exceeded" })),
      ),
    );
  const release = SynchronizedRef.update(active, (current) => Math.max(0, current - 1));
  const acquirePermit = (maximum: number) =>
    Effect.gen(function* () {
      yield* acquire(maximum);
      const released = yield* Ref.make(false);
      return {
        release: Ref.getAndSet(released, true).pipe(
          Effect.flatMap((alreadyReleased) => (alreadyReleased ? Effect.void : release)),
        ),
      } satisfies VoiceMediaPermit;
    });
  return VoiceMediaRequestLimiter.of({
    acquire: acquirePermit,
  });
});

export const VoiceMediaRequestLimiterLive = Layer.effect(
  VoiceMediaRequestLimiter,
  makeVoiceMediaRequestLimiter,
);

export const boundVoiceMediaEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutSeconds: number,
): Effect.Effect<A, E | VoiceMediaPolicyError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: `${timeoutSeconds} seconds`,
      orElse: () => Effect.fail(new VoiceMediaPolicyError({ reason: "request-timeout" })),
    }),
  );

export const boundVoiceByteStream = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  options: {
    readonly maximumBytes: number;
    readonly firstByteTimeoutSeconds: number;
    readonly totalTimeoutSeconds: number;
  },
): Stream.Stream<Uint8Array, E | VoiceMediaPolicyError, R> =>
  Stream.unwrap(
    Effect.all([Ref.make(0), Ref.make(false)]).pipe(
      Effect.map(([observedBytes, observedFirstChunk]) => {
        const firstByteTimeout = Stream.fromEffect(
          Effect.sleep(`${options.firstByteTimeoutSeconds} seconds`).pipe(
            Effect.andThen(Ref.get(observedFirstChunk)),
            Effect.flatMap((observed) =>
              observed
                ? Effect.never
                : Effect.fail(new VoiceMediaPolicyError({ reason: "request-timeout" })),
            ),
          ),
        );
        const firstByteBound = stream.pipe(
          Stream.tap(() => Ref.set(observedFirstChunk, true)),
          Stream.merge(firstByteTimeout, { haltStrategy: "left" }),
        );
        return firstByteBound.pipe(
          Stream.mapEffect((chunk) =>
            Ref.updateAndGet(observedBytes, (current) => current + chunk.byteLength).pipe(
              Effect.flatMap((total) =>
                total <= options.maximumBytes
                  ? Effect.succeed(chunk)
                  : Effect.fail(new VoiceMediaPolicyError({ reason: "payload-too-large" })),
              ),
            ),
          ),
          Stream.interruptWhen(
            Effect.sleep(`${options.totalTimeoutSeconds} seconds`).pipe(
              Effect.andThen(Effect.fail(new VoiceMediaPolicyError({ reason: "request-timeout" }))),
            ),
          ),
        );
      }),
    ),
  );

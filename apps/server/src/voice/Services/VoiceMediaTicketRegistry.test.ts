import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, VoiceRequestId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { __testing } from "./VoiceMediaTicketRegistry.ts";

const makeRegistry = (now: () => number) =>
  __testing.make({ now, lifetimeMs: 1_000 }).pipe(Effect.provide(NodeServices.layer));

it.effect("consumes a media ticket exactly once for its bound operation", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issue({
      authSessionId: AuthSessionId.make("auth-1"),
      operation: "speech-stream",
      requestId: VoiceRequestId.make("request-consume"),
    });

    expect(yield* registry.consume(issued.token, "transcription-upload")).toBeUndefined();
    expect(yield* registry.consume(issued.token, "speech-stream")).toMatchObject({
      authSessionId: "auth-1",
      operation: "speech-stream",
    });
    expect(yield* registry.consume(issued.token, "speech-stream")).toBeUndefined();
  }),
);

it.effect("expires and revokes tickets by their owning auth sessions", () =>
  Effect.gen(function* () {
    let now = 1_000;
    const registry = yield* makeRegistry(() => now);
    const authSessionId = AuthSessionId.make("auth-1");
    const first = yield* registry.issue({
      authSessionId,
      requestId: VoiceRequestId.make("request-1"),
      operation: "speech-stream",
    });
    yield* registry.revokeAuthSession(authSessionId);
    expect(yield* registry.consume(first.token, "speech-stream")).toBeUndefined();

    const second = yield* registry.issue({
      authSessionId,
      operation: "speech-stream",
      requestId: VoiceRequestId.make("request-2"),
    });
    now += 2_000;
    expect(yield* registry.consume(second.token, "speech-stream")).toBeUndefined();
  }),
);

it.effect("caps outstanding tickets per auth session and globally after pruning", () =>
  Effect.gen(function* () {
    let now = 1_000;
    const registry = yield* __testing
      .make({
        now: () => now,
        lifetimeMs: 1_000,
        maximumOutstandingPerAuthSession: 2,
        maximumOutstandingGlobal: 3,
      })
      .pipe(Effect.provide(NodeServices.layer));
    const firstOwner = AuthSessionId.make("auth-cap-1");
    const secondOwner = AuthSessionId.make("auth-cap-2");
    yield* registry.issue({
      authSessionId: firstOwner,
      operation: "speech-stream",
      requestId: VoiceRequestId.make("cap-1"),
    });
    yield* registry.issue({
      authSessionId: firstOwner,
      operation: "speech-stream",
      requestId: VoiceRequestId.make("cap-2"),
    });
    expect(
      (yield* registry
        .issue({
          authSessionId: firstOwner,
          operation: "speech-stream",
          requestId: VoiceRequestId.make("cap-3"),
        })
        .pipe(Effect.flip))._tag,
    ).toBe("VoiceMediaTicketLimitError");
    yield* registry.issue({
      authSessionId: secondOwner,
      operation: "speech-stream",
      requestId: VoiceRequestId.make("cap-4"),
    });
    expect(
      (yield* registry
        .issue({
          authSessionId: AuthSessionId.make("auth-cap-3"),
          operation: "speech-stream",
          requestId: VoiceRequestId.make("cap-5"),
        })
        .pipe(Effect.flip))._tag,
    ).toBe("VoiceMediaTicketLimitError");

    now += 2_000;
    yield* registry.issue({
      authSessionId: AuthSessionId.make("auth-cap-3"),
      operation: "speech-stream",
      requestId: VoiceRequestId.make("cap-6"),
    });
  }),
);

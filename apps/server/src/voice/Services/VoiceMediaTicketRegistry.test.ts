import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, VoiceSessionId } from "@t3tools/contracts";
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
    });

    expect(yield* registry.consume(issued.token, "transcription-upload")).toBeUndefined();
    expect(yield* registry.consume(issued.token, "speech-stream")).toMatchObject({
      authSessionId: "auth-1",
      operation: "speech-stream",
    });
    expect(yield* registry.consume(issued.token, "speech-stream")).toBeUndefined();
  }),
);

it.effect("expires and revokes tickets by their owning sessions", () =>
  Effect.gen(function* () {
    let now = 1_000;
    const registry = yield* makeRegistry(() => now);
    const authSessionId = AuthSessionId.make("auth-1");
    const voiceSessionId = VoiceSessionId.make("voice-1");
    const first = yield* registry.issue({
      authSessionId,
      voiceSessionId,
      operation: "voice-heartbeat",
    });
    yield* registry.revokeVoiceSession(voiceSessionId);
    expect(yield* registry.consume(first.token, "voice-heartbeat")).toBeUndefined();

    const second = yield* registry.issue({ authSessionId, operation: "speech-stream" });
    now += 2_000;
    expect(yield* registry.consume(second.token, "speech-stream")).toBeUndefined();
  }),
);

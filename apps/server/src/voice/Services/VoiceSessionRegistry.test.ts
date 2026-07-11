import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, VoiceConversationId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VoiceSessionRegistry, VoiceSessionRegistryLive } from "./VoiceSessionRegistry.ts";

const layer = VoiceSessionRegistryLive.pipe(Layer.provide(NodeServices.layer));

it.effect("atomically fences an old session during explicit takeover", () =>
  Effect.gen(function* () {
    const registry = yield* VoiceSessionRegistry;
    const conversationId = VoiceConversationId.make("conversation-1");
    const first = yield* registry.acquire({
      conversationId,
      ownerAuthSessionId: AuthSessionId.make("auth-phone"),
      takeover: false,
    });
    const blocked = yield* Effect.flip(
      registry.acquire({
        conversationId,
        ownerAuthSessionId: AuthSessionId.make("auth-desktop"),
        takeover: false,
      }),
    );
    expect(blocked.reason).toBe("takeover-required");

    const second = yield* registry.acquire({
      conversationId,
      ownerAuthSessionId: AuthSessionId.make("auth-desktop"),
      takeover: true,
    });
    expect(second.lease.generation).toBe(2);
    expect(Option.getOrUndefined(second.replacedSessionId)).toBe(first.lease.sessionId);
    expect(yield* registry.isCurrent(first.lease)).toBe(false);
    expect(yield* registry.release(first.lease)).toBe(false);
    expect(yield* registry.isCurrent(second.lease)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("allows only one winner when non-takeover acquisitions race", () =>
  Effect.gen(function* () {
    const registry = yield* VoiceSessionRegistry;
    const conversationId = VoiceConversationId.make("conversation-race");
    const results = yield* Effect.all(
      Array.from({ length: 8 }, (_, index) =>
        Effect.result(
          registry.acquire({
            conversationId,
            ownerAuthSessionId: AuthSessionId.make(`auth-${index}`),
            takeover: false,
          }),
        ),
      ),
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

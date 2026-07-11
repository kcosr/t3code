import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SessionStore } from "../../auth/SessionStore.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";
import { VoiceSessionLifecycleLive } from "./VoiceSessionLifecycle.ts";

it.effect("terminates voice state when an authenticated client is removed", () =>
  Effect.gen(function* () {
    const sessionId = AuthSessionId.make("revoked-client");
    const revoked = yield* Deferred.make<AuthSessionId>();
    const dependencies = Layer.mergeAll(
      Layer.mock(SessionStore)({
        cookieName: "t3-test-session",
        streamChanges: Stream.make({ type: "clientRemoved", sessionId }),
      }),
      Layer.mock(VoiceSessionService)({
        revokeAuthSession: (owner) => Deferred.succeed(revoked, owner).pipe(Effect.asVoid),
      }),
    );

    yield* Effect.gen(function* () {
      expect(yield* Deferred.await(revoked)).toBe(sessionId);
    }).pipe(
      Effect.provide(VoiceSessionLifecycleLive.pipe(Layer.provide(dependencies))),
      Effect.timeout("1 second"),
    );
  }),
);

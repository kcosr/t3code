import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SessionStore } from "../../auth/SessionStore.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";
import { VoiceRuntimeAuthorityRepository } from "../../persistence/Services/VoiceRuntimeAuthorities.ts";
import { VoiceSessionLifecycleLive } from "./VoiceSessionLifecycle.ts";

it.effect("terminates voice state when an authenticated client is removed", () =>
  Effect.gen(function* () {
    const sessionId = AuthSessionId.make("revoked-client");
    const sessionsRevoked = yield* Deferred.make<AuthSessionId>();
    const authorityCleared = yield* Deferred.make<AuthSessionId>();
    const dependencies = Layer.mergeAll(
      Layer.mock(SessionStore)({
        cookieName: "t3-test-session",
        streamChanges: Stream.make({ type: "clientRemoved", sessionId }),
      }),
      Layer.mock(VoiceSessionService)({
        revokeAuthSession: (owner) => Deferred.succeed(sessionsRevoked, owner).pipe(Effect.asVoid),
      }),
      Layer.mock(VoiceRuntimeAuthorityRepository)({
        clearAuthSession: (owner) => Deferred.succeed(authorityCleared, owner).pipe(Effect.asVoid),
      }),
    );

    yield* Effect.gen(function* () {
      expect(yield* Deferred.await(sessionsRevoked)).toBe(sessionId);
      expect(yield* Deferred.await(authorityCleared)).toBe(sessionId);
    }).pipe(
      Effect.provide(VoiceSessionLifecycleLive.pipe(Layer.provide(dependencies))),
      Effect.timeout("1 second"),
    );
  }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, VoiceSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { __testing } from "./VoiceNativeControlGrantRegistry.ts";

const scope = (authSessionId: string, sessionId: string, expiresAt = 2_000) => ({
  authSessionId: AuthSessionId.make(authSessionId),
  sessionId: VoiceSessionId.make(sessionId),
  leaseGeneration: 3,
  expiresAt,
});

it.effect("authorizes a native control grant repeatedly without storing a raw token", () =>
  Effect.gen(function* () {
    const registry = yield* __testing
      .make({ now: () => 1_000 })
      .pipe(Effect.provide(NodeServices.layer));
    const token = yield* registry.issue(scope("auth-1", "session-1"));

    expect(yield* registry.authorize(token)).toEqual(scope("auth-1", "session-1"));
    expect(yield* registry.authorize(token)).toEqual(scope("auth-1", "session-1"));
    expect(yield* registry.authorize(`${token}x`)).toBeUndefined();
    expect(yield* registry.authorize("")).toBeUndefined();
    expect(yield* registry.authorize("x".repeat(129))).toBeUndefined();
  }),
);

it.effect("derives one stable grant for an idempotent session scope", () =>
  Effect.gen(function* () {
    const registry = yield* __testing
      .make({ now: () => 1_000 })
      .pipe(Effect.provide(NodeServices.layer));
    const first = yield* registry.issue(scope("auth-1", "session-1"));
    const second = yield* registry.issue(scope("auth-1", "session-1"));
    const otherScope = yield* registry.issue(scope("auth-1", "session-2"));

    expect(second).toBe(first);
    expect(otherScope).not.toBe(first);
    expect(yield* registry.authorize(first)).toEqual(scope("auth-1", "session-1"));
    expect(yield* registry.authorize(second)).toEqual(scope("auth-1", "session-1"));
  }),
);

it.effect("expires grants and revokes them by session or auth session", () =>
  Effect.gen(function* () {
    let now = 1_000;
    const registry = yield* __testing
      .make({ now: () => now })
      .pipe(Effect.provide(NodeServices.layer));
    const first = yield* registry.issue(scope("auth-1", "session-1"));
    const second = yield* registry.issue(scope("auth-1", "session-2"));
    const third = yield* registry.issue(scope("auth-2", "session-3"));

    yield* registry.revokeSession(VoiceSessionId.make("session-1"));
    expect(yield* registry.authorize(first)).toBeUndefined();
    expect(yield* registry.authorize(second)).toBeDefined();
    yield* registry.revokeAuthSession(AuthSessionId.make("auth-1"));
    expect(yield* registry.authorize(second)).toBeUndefined();
    expect(yield* registry.authorize(third)).toBeDefined();

    now = 2_000;
    expect(yield* registry.authorize(third)).toBeUndefined();
  }),
);

it.effect("never reissues a revoked scope token", () =>
  Effect.gen(function* () {
    const registry = yield* __testing
      .make({ now: () => 1_000 })
      .pipe(Effect.provide(NodeServices.layer));
    const grantScope = scope("auth-1", "session-1");
    const first = yield* registry.issue(grantScope);

    yield* registry.revokeSession(grantScope.sessionId);
    const replacement = yield* registry.issue(grantScope);

    expect(replacement).not.toBe(first);
    expect(yield* registry.authorize(first)).toBeUndefined();
    expect(yield* registry.authorize(replacement)).toEqual(grantScope);
  }),
);

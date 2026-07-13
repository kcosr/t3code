import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, VoiceSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VoiceNativeControlGrantRepositoryLive } from "../../persistence/Layers/VoiceNativeControlGrants.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";

import { __testing } from "./VoiceNativeControlGrantRegistry.ts";

const persistence = VoiceNativeControlGrantRepositoryLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(NodeServices.layer),
);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | import("effect/Crypto").Crypto
    | import("../../persistence/Services/VoiceNativeControlGrants.ts").VoiceNativeControlGrantRepository
  >,
) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 43 });
    return yield* effect;
  }).pipe(Effect.provide(persistence));

const scope = (authSessionId: string, sessionId: string, expiresAt = 2_000) => ({
  authSessionId: AuthSessionId.make(authSessionId),
  sessionId: VoiceSessionId.make(sessionId),
  leaseGeneration: 3,
  expiresAt,
  capabilities: new Set(["session-control", "handoff-actions"] as const),
});

it.effect("authorizes a native control grant repeatedly without storing a raw token", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* __testing.make({ now: () => 1_000 });
      const token = yield* registry.issue(scope("auth-1", "session-1"));

      expect(yield* registry.authorize(token)).toEqual(scope("auth-1", "session-1"));
      expect(yield* registry.authorize(token)).toEqual(scope("auth-1", "session-1"));
      expect(yield* registry.authorize(`${token}x`)).toBeUndefined();
      expect(yield* registry.authorize("")).toBeUndefined();
      expect(yield* registry.authorize("x".repeat(129))).toBeUndefined();
    }),
  ),
);

it.effect("issues independent recoverable grants for a repeated session scope", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* __testing.make({ now: () => 1_000 });
      const first = yield* registry.issue(scope("auth-1", "session-1"));
      const second = yield* registry.issue(scope("auth-1", "session-1"));
      const otherScope = yield* registry.issue(scope("auth-1", "session-2"));

      expect(second).not.toBe(first);
      expect(otherScope).not.toBe(first);
      expect(yield* registry.authorize(first)).toEqual(scope("auth-1", "session-1"));
      expect(yield* registry.authorize(second)).toEqual(scope("auth-1", "session-1"));
    }),
  ),
);

it.effect("expires grants and revokes them by session or auth session", () =>
  run(
    Effect.gen(function* () {
      let now = 1_000;
      const registry = yield* __testing.make({ now: () => now });
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
  ),
);

it.effect("never reissues a revoked scope token", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* __testing.make({ now: () => 1_000 });
      const grantScope = scope("auth-1", "session-1");
      const first = yield* registry.issue(grantScope);

      yield* registry.revokeSession(grantScope.sessionId);
      const replacement = yield* registry.issue(grantScope);

      expect(replacement).not.toBe(first);
      expect(yield* registry.authorize(first)).toBeUndefined();
      expect(yield* registry.authorize(replacement)).toEqual(grantScope);
    }),
  ),
);

it.effect("retains only handoff authority when live session control is released", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* __testing.make({ now: () => 1_000 });
      const grantScope = scope("auth-1", "session-1");
      const token = yield* registry.issue(grantScope);

      yield* registry.releaseSessionControl(grantScope.sessionId);

      expect(yield* registry.authorize(token)).toEqual({
        ...grantScope,
        capabilities: new Set(["handoff-actions"]),
      });
      yield* registry.revokeAuthSession(grantScope.authSessionId);
      expect(yield* registry.authorize(token)).toBeUndefined();
    }),
  ),
);

it.effect("authorizes an issued token from a fresh registry instance", () =>
  run(
    Effect.gen(function* () {
      const beforeRestart = yield* __testing.make({ now: () => 1_000 });
      const grantScope = scope("auth-restart", "session-restart");
      const token = yield* beforeRestart.issue(grantScope);

      const afterRestart = yield* __testing.make({ now: () => 1_001 });
      expect(yield* afterRestart.authorize(token)).toEqual(grantScope);
    }),
  ),
);

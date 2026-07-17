import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AuthSessions from "./AuthSessions.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const issuedAt = DateTime.makeUnsafe("2026-07-17T00:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2026-07-18T00:00:00.000Z");
const revokedAt = DateTime.makeUnsafe("2026-07-17T01:00:00.000Z");

const input = (
  sessionId: string,
  overrides: Partial<AuthSessions.CreateAuthSessionInput> = {},
): AuthSessions.CreateAuthSessionInput => ({
  sessionId: AuthSessionId.make(sessionId),
  parentSessionId: null,
  subject: sessionId,
  scopes: ["voice:use"],
  method: "bearer-access-token",
  client: {
    label: null,
    ipAddress: null,
    userAgent: null,
    deviceType: "unknown",
    os: null,
    browser: null,
  },
  issuedAt,
  expiresAt,
  ...overrides,
});

const repositoryLayer = AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(repositoryLayer)("AuthSessionRepository conditional parent issuance", (it) => {
  it.effect("leaves no active child when child creation serializes before parent revocation", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const parentSessionId = AuthSessionId.make("parent-child-first");
      const childSessionId = AuthSessionId.make("child-child-first");
      yield* sessions.create(input(parentSessionId));

      assert.isTrue(
        yield* sessions.createWithActiveParent({
          ...input(childSessionId),
          parentSessionId,
        }),
      );
      const revoked = yield* sessions.revoke({ sessionId: parentSessionId, revokedAt });
      const active = yield* sessions.listActive({ now: issuedAt });
      const child = Option.getOrThrow(yield* sessions.getById({ sessionId: childSessionId }));

      assert.deepStrictEqual(new Set(revoked), new Set([parentSessionId, childSessionId]));
      assert.isFalse(active.some((row) => row.sessionId === childSessionId));
      assert.equal(child.revokedAt?.epochMilliseconds, revokedAt.epochMilliseconds);
    }),
  );

  it.effect("rejects child creation when parent revocation serializes first", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const parentSessionId = AuthSessionId.make("parent-revoke-first");
      const childSessionId = AuthSessionId.make("child-revoke-first");
      yield* sessions.create(input(parentSessionId));
      yield* sessions.revoke({ sessionId: parentSessionId, revokedAt });

      assert.isFalse(
        yield* sessions.createWithActiveParent({
          ...input(childSessionId),
          parentSessionId,
        }),
      );
      assert.isTrue(Option.isNone(yield* sessions.getById({ sessionId: childSessionId })));
      assert.isFalse(
        (yield* sessions.listActive({ now: issuedAt })).some(
          (row) => row.sessionId === childSessionId,
        ),
      );
    }),
  );

  it.effect("requires an unexpired parent while preserving parentless issuance", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const expiredParentSessionId = AuthSessionId.make("expired-parent");
      const childSessionId = AuthSessionId.make("expired-parent-child");
      const parentlessSessionId = AuthSessionId.make("parentless-session");
      yield* sessions.create(
        input(expiredParentSessionId, {
          expiresAt: issuedAt,
        }),
      );

      assert.isFalse(
        yield* sessions.createWithActiveParent({
          ...input(childSessionId),
          parentSessionId: expiredParentSessionId,
        }),
      );
      yield* sessions.create(input(parentlessSessionId));

      assert.isTrue(Option.isNone(yield* sessions.getById({ sessionId: childSessionId })));
      assert.isTrue(Option.isSome(yield* sessions.getById({ sessionId: parentlessSessionId })));
    }),
  );

  it.effect("rejects a child whose expiration would exceed the parent expiration", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const parentSessionId = AuthSessionId.make("short-parent");
      const childSessionId = AuthSessionId.make("long-child");
      const parentExpiresAt = DateTime.makeUnsafe("2026-07-17T12:00:00.000Z");
      yield* sessions.create(input(parentSessionId, { expiresAt: parentExpiresAt }));

      assert.isFalse(
        yield* sessions.createWithActiveParent({
          ...input(childSessionId),
          parentSessionId,
        }),
      );
      assert.isTrue(Option.isNone(yield* sessions.getById({ sessionId: childSessionId })));
    }),
  );
});

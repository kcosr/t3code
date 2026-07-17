import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const makeServerConfigLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const makeSessionStoreLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeSessionStoreWithSqlLayer = () =>
  SessionStore.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(makeServerConfigLayer()),
  );

const repositoryFailure = new PersistenceSqlError({
  operation: "AuthSessionRepository.getById:query",
  detail: "sqlite is unavailable",
});

const failingSessionLookupRepositoryLayer = Layer.succeed(AuthSessions.AuthSessionRepository, {
  create: () => Effect.void,
  createWithActiveParent: () => Effect.succeed(true),
  getById: () => Effect.fail(repositoryFailure),
  listActive: () => Effect.succeed([]),
  revoke: () => Effect.fail(repositoryFailure),
  revokeAllExcept: () => Effect.fail(repositoryFailure),
  setLastConnectedAt: () => Effect.void,
});

const failingSessionLookupCredentialLayer = Layer.effect(
  SessionStore.SessionStore,
  SessionStore.make,
).pipe(
  Layer.provide(failingSessionLookupRepositoryLayer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(makeServerConfigLayer()),
);

it.layer(NodeServices.layer)("SessionStore.layer", (it) => {
  it.effect("issues and verifies signed browser session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.subject).toBe("desktop-bootstrap");
      expect(verified.scopes).toEqual(["orchestration:read", "access:write"]);
      expect(verified.client.label).toBe("Desktop app");
      expect(verified.client.browser).toBe("Electron");
      expect(verified.expiresAt?.toString()).toBe(issued.expiresAt.toString());
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
  it.effect("rejects malformed session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

      expect(error._tag).toBe("MalformedSessionTokenError");
      expect(error.message).toContain("Malformed session token");
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
  it.effect("preserves repository failures while verifying session and websocket credentials", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "repository-failure",
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      const revokeError = yield* Effect.flip(sessions.revoke(issued.sessionId));
      const revokeOthersError = yield* Effect.flip(sessions.revokeAllExcept(issued.sessionId));

      expect(sessionError._tag).toBe("SessionCredentialVerificationError");
      expect(websocketError._tag).toBe("WebSocketTokenVerificationError");
      expect(sessionError.cause).toBe(repositoryFailure);
      expect(websocketError.cause).toBe(repositoryFailure);
      if (sessionError._tag === "SessionCredentialVerificationError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
      }
      if (websocketError._tag === "WebSocketTokenVerificationError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
      }
      expect(revokeError).toMatchObject({
        _tag: "SessionRevocationError",
        sessionId: issued.sessionId,
        cause: repositoryFailure,
      });
      expect(revokeOthersError).toMatchObject({
        _tag: "OtherSessionsRevocationError",
        currentSessionId: issued.sessionId,
        cause: repositoryFailure,
      });
    }).pipe(Effect.provide(failingSessionLookupCredentialLayer)),
  );
  it.effect("verifies session tokens against the Effect clock", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "test-clock",
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("bearer-access-token");
      expect(verified.subject).toBe("test-clock");
      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "voice:use",
      ]);
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("clamps issuance to an absolute expiration boundary", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const requestedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const notAfter = DateTime.makeUnsafe(requestedAt + Duration.toMillis(Duration.hours(1)));

      yield* TestClock.adjust(Duration.minutes(5));
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "absolute-expiration-cap",
        ttl: Duration.hours(1),
        notAfter,
      });

      expect(issued.expiresAt.epochMilliseconds).toBe(notAfter.epochMilliseconds);
      expect((yield* sessions.verify(issued.token)).expiresAt?.epochMilliseconds).toBe(
        notAfter.epochMilliseconds,
      );
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error._tag).toBe("WebSocketSessionExpiredError");
      if (error._tag === "WebSocketSessionExpiredError") {
        expect(error.sessionId).toBe(issued.sessionId);
        expect(error.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(error.observedAt.epochMilliseconds).toBeGreaterThan(
          error.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("includes expiry context when session and websocket tokens expire", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived-token",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId, {
        ttl: Duration.seconds(1),
      });

      yield* TestClock.adjust(Duration.seconds(2));

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));

      expect(sessionError._tag).toBe("SessionTokenExpiredError");
      if (sessionError._tag === "SessionTokenExpiredError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
        expect(sessionError.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(sessionError.observedAt.epochMilliseconds).toBeGreaterThan(
          sessionError.expiresAt.epochMilliseconds,
        );
      }
      expect(websocketError._tag).toBe("WebSocketTokenExpiredError");
      if (websocketError._tag === "WebSocketTokenExpiredError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
        expect(websocketError.expiresAt.epochMilliseconds).toBe(
          websocket.expiresAt.epochMilliseconds,
        );
        expect(websocketError.observedAt.epochMilliseconds).toBeGreaterThan(
          websocketError.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("enforces the persisted session expiration when it precedes the signed claim", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const issuedAt = yield* DateTime.now;
      const persistedExpiresAt = DateTime.add(issuedAt, { minutes: 5 });
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "persisted-expiration",
        ttl: Duration.hours(1),
      });
      yield* sql`
        UPDATE auth_sessions
        SET expires_at = ${DateTime.formatIso(persistedExpiresAt)}
        WHERE session_id = ${issued.sessionId}
      `;

      const verified = yield* sessions.verify(issued.token);
      expect(verified.expiresAt?.epochMilliseconds).toBe(persistedExpiresAt.epochMilliseconds);

      yield* TestClock.adjust(Duration.minutes(6));
      const error = yield* Effect.flip(sessions.verify(issued.token));

      expect(error._tag).toBe("SessionTokenExpiredError");
      if (error._tag === "SessionTokenExpiredError") {
        expect(error.expiresAt.epochMilliseconds).toBe(persistedExpiresAt.epochMilliseconds);
      }
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreWithSqlLayer(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read"],
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);
      const nativeChild = yield* sessions.issue({
        parentSessionId: client.sessionId,
        subject: `native-voice:${client.sessionId}`,
        method: "bearer-access-token",
        scopes: ["orchestration:read", "orchestration:operate", "voice:use"],
      });

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));
      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      expect(beforeRevoke).toHaveLength(3);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === administrative.sessionId)?.client
          .deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(2);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(administrative.sessionId);
      expect(revokedClient._tag).toBe("SessionTokenRevokedError");
      if (revokedClient._tag === "SessionTokenRevokedError") {
        expect(revokedClient.sessionId).toBe(client.sessionId);
        expect(revokedClient.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect(revokedClientWebSocket._tag).toBe("WebSocketSessionRevokedError");
      if (revokedClientWebSocket._tag === "WebSocketSessionRevokedError") {
        expect(revokedClientWebSocket.sessionId).toBe(client.sessionId);
        expect(revokedClientWebSocket.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect((yield* Effect.flip(sessions.verify(nativeChild.token)))._tag).toBe(
        "SessionTokenRevokedError",
      );
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("revokes child sessions and publishes their removals with the parent", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({
        subject: "paired-mobile",
        method: "dpop-access-token",
      });
      const child = yield* sessions.issue({
        parentSessionId: parent.sessionId,
        subject: `native-voice:${parent.sessionId}`,
        method: "bearer-access-token",
      });
      const removals = yield* sessions.streamChanges.pipe(
        Stream.filter((change) => change.type === "clientRemoved"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      expect((yield* sessions.verify(child.token)).parentSessionId).toBe(parent.sessionId);
      expect(yield* sessions.revoke(parent.sessionId)).toBe(true);
      const removedSessionIds = Array.from(yield* Fiber.join(removals)).map(
        (change) => change.sessionId,
      );
      const parentError = yield* Effect.flip(sessions.verify(parent.token));
      const childError = yield* Effect.flip(sessions.verify(child.token));

      expect(new Set(removedSessionIds)).toEqual(new Set([parent.sessionId, child.sessionId]));
      expect(parentError._tag).toBe("SessionTokenRevokedError");
      expect(childError._tag).toBe("SessionTokenRevokedError");
      expect(yield* sessions.listActive()).toHaveLength(0);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("rejects child issuance after the parent session is revoked", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({
        subject: "paired-mobile",
        method: "dpop-access-token",
      });

      expect(yield* sessions.revoke(parent.sessionId)).toBe(true);
      const error = yield* Effect.flip(
        sessions.issue({
          parentSessionId: parent.sessionId,
          subject: `native-voice:${parent.sessionId}`,
          method: "bearer-access-token",
        }),
      );

      expect(error).toMatchObject({
        _tag: "SessionParentUnavailableError",
        parentSessionId: parent.sessionId,
      });
      expect(yield* sessions.listActive()).toHaveLength(0);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("persists lastConnectedAt on first connect and updates it after reconnect", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "reconnect-test",
        method: "bearer-access-token",
      });

      const beforeConnect = yield* sessions.listActive();
      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const firstConnect = yield* sessions.listActive();
      const firstConnectedAt = firstConnect[0]?.lastConnectedAt;

      expect(firstConnect[0]?.connected).toBe(true);
      expect(firstConnectedAt).not.toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const stillConnected = yield* sessions.listActive();

      expect(stillConnected[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* sessions.markDisconnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      const afterDisconnect = yield* sessions.listActive();

      expect(afterDisconnect[0]?.connected).toBe(false);
      expect(afterDisconnect[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const afterReconnect = yield* sessions.listActive();

      expect(afterReconnect[0]?.connected).toBe(true);
      expect(afterReconnect[0]?.lastConnectedAt).not.toBeNull();
      expect(afterReconnect[0]?.lastConnectedAt?.toString()).not.toBe(firstConnectedAt?.toString());
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );
});

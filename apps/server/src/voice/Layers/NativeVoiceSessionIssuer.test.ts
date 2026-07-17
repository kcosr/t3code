import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthVoiceUseScope,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { SessionParentUnavailableError, SessionStore } from "../../auth/SessionStore.ts";
import { NativeVoiceSessionIssuer } from "../Services/NativeVoiceSessionIssuer.ts";
import {
  NATIVE_VOICE_SESSION_SCOPES,
  NATIVE_VOICE_SESSION_TTL,
  NativeVoiceSessionIssuerLive,
} from "./NativeVoiceSessionIssuer.ts";

const parentSessionId = AuthSessionId.make("parent-session");

const parent = (
  scopes: ReadonlyArray<(typeof NATIVE_VOICE_SESSION_SCOPES)[number]> = [
    AuthVoiceUseScope,
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
  ],
  expiresAt?: DateTime.DateTime,
): EnvironmentSessionPrincipalShape => ({
  sessionId: parentSessionId,
  subject: "paired-mobile",
  method: "dpop-access-token",
  scopes: new Set(scopes),
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

const makeTest = Effect.fn("test.makeNativeVoiceSessionIssuer")(function* (
  issueError?: SessionParentUnavailableError,
) {
  const issuedInput = yield* Ref.make<Parameters<SessionStore["Service"]["issue"]>[0] | null>(null);
  const sessionStore = {
    issue: (input: Parameters<SessionStore["Service"]["issue"]>[0]) =>
      Effect.gen(function* () {
        yield* Ref.set(issuedInput, input);
        if (issueError !== undefined) {
          return yield* issueError;
        }
        const issuedAt = yield* DateTime.now;
        const ttlExpiresAt = DateTime.add(issuedAt, {
          milliseconds: Duration.toMillis(input?.ttl ?? Duration.days(30)),
        });
        const expiresAt =
          input?.notAfter !== undefined &&
          input.notAfter.epochMilliseconds < ttlExpiresAt.epochMilliseconds
            ? input.notAfter
            : ttlExpiresAt;
        return {
          sessionId: AuthSessionId.make("native-session"),
          token: "native-bearer-token",
          method: input?.method ?? "browser-session-cookie",
          client: input?.client ?? { deviceType: "unknown" },
          expiresAt,
          scopes: input?.scopes ?? [],
        };
      }),
  } as unknown as SessionStore["Service"];
  const layer = NativeVoiceSessionIssuerLive.pipe(
    Layer.provide(Layer.succeed(SessionStore, sessionStore)),
  );
  return { issuedInput, layer };
});

describe("NativeVoiceSessionIssuer", () => {
  it.effect("requires every narrow native runtime scope before issuing", () =>
    Effect.gen(function* () {
      const test = yield* makeTest();
      const result = yield* NativeVoiceSessionIssuer.pipe(
        Effect.flatMap((issuer) =>
          issuer.issue(parent([AuthVoiceUseScope, AuthOrchestrationReadScope])),
        ),
        Effect.result,
        Effect.provide(test.layer),
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "NativeVoiceSessionScopeRequiredError");
        if (result.failure._tag === "NativeVoiceSessionScopeRequiredError") {
          assert.equal(result.failure.requiredScope, AuthOrchestrationOperateScope);
        }
      }
      assert.isNull(yield* Ref.get(test.issuedInput));
    }),
  );

  it.effect("does not allow a native child credential to mint a successor", () =>
    Effect.gen(function* () {
      const test = yield* makeTest();
      const result = yield* NativeVoiceSessionIssuer.pipe(
        Effect.flatMap((issuer) =>
          issuer.issue({
            ...parent(),
            parentSessionId,
            subject: "descriptive-native-runtime-subject",
          }),
        ),
        Effect.result,
        Effect.provide(test.layer),
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "NativeVoiceSessionReissuanceNotAllowedError");
      }
      assert.isNull(yield* Ref.get(test.issuedInput));
    }),
  );

  it.effect("reports a revoked parent as an expected native issuance conflict", () =>
    Effect.gen(function* () {
      const test = yield* makeTest(new SessionParentUnavailableError({ parentSessionId }));
      const result = yield* NativeVoiceSessionIssuer.pipe(
        Effect.flatMap((issuer) => issuer.issue(parent())),
        Effect.result,
        Effect.provide(test.layer),
      );

      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "NativeVoiceParentSessionInactiveError");
      }
      assert.isNotNull(yield* Ref.get(test.issuedInput));
    }),
  );

  it.effect("issues a twelve-hour bearer with exactly the native scopes", () =>
    Effect.gen(function* () {
      const test = yield* makeTest();
      const credential = yield* NativeVoiceSessionIssuer.pipe(
        Effect.flatMap((issuer) => issuer.issue(parent())),
        Effect.provide(test.layer),
      );
      const input = yield* Ref.get(test.issuedInput);
      assert.isNotNull(input);
      assert.equal(input?.method, "bearer-access-token");
      assert.deepStrictEqual(input?.scopes, NATIVE_VOICE_SESSION_SCOPES);
      assert.equal(
        Duration.toMillis(input?.ttl ?? Duration.zero),
        Duration.toMillis(NATIVE_VOICE_SESSION_TTL),
      );
      assert.equal(input?.subject, `native-voice:${parentSessionId}`);
      assert.equal(input?.parentSessionId, parentSessionId);
      assert.deepStrictEqual(input?.client, {
        label: "Android voice runtime",
        deviceType: "mobile",
        os: "Android",
      });
      assert.equal(credential.accessToken, "native-bearer-token");
    }),
  );

  it.effect("caps a DPoP child's expiration at its one-hour parent expiration", () =>
    Effect.gen(function* () {
      const test = yield* makeTest();
      const now = yield* DateTime.now;
      const parentExpiresAt = DateTime.add(now, { hours: 1 });
      const credential = yield* NativeVoiceSessionIssuer.pipe(
        Effect.flatMap((issuer) => issuer.issue(parent(undefined, parentExpiresAt))),
        Effect.provide(test.layer),
      );
      const input = yield* Ref.get(test.issuedInput);
      assert.isNotNull(input);
      assert.equal(
        Duration.toMillis(input?.ttl ?? Duration.zero),
        Duration.toMillis(Duration.hours(1)),
      );
      assert.equal(input?.notAfter?.epochMilliseconds, parentExpiresAt.epochMilliseconds);
      assert.equal(
        DateTime.makeUnsafe(credential.expiresAt).epochMilliseconds,
        parentExpiresAt.epochMilliseconds,
      );
    }),
  );
});

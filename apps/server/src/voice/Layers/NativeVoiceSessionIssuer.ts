import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthVoiceUseScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SessionStore } from "../../auth/SessionStore.ts";
import {
  NativeVoiceSessionIssuer,
  NativeVoiceParentSessionInactiveError,
  NativeVoiceSessionReissuanceNotAllowedError,
  NativeVoiceSessionScopeRequiredError,
} from "../Services/NativeVoiceSessionIssuer.ts";

export const NATIVE_VOICE_SESSION_TTL = Duration.hours(12);
export const NATIVE_VOICE_SESSION_SUBJECT_PREFIX = "native-voice:";

export const NATIVE_VOICE_SESSION_SCOPES = [
  AuthVoiceUseScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const satisfies ReadonlyArray<AuthEnvironmentScope>;

const make = Effect.gen(function* () {
  const sessions = yield* SessionStore;

  const issue: NativeVoiceSessionIssuer["Service"]["issue"] = Effect.fn(
    "NativeVoiceSessionIssuer.issue",
  )(function* (parent) {
    if (parent.parentSessionId !== undefined) {
      return yield* new NativeVoiceSessionReissuanceNotAllowedError();
    }

    for (const requiredScope of NATIVE_VOICE_SESSION_SCOPES) {
      if (!parent.scopes.has(requiredScope)) {
        return yield* new NativeVoiceSessionScopeRequiredError({ requiredScope });
      }
    }

    const now = yield* DateTime.now;
    const maximumTtlMillis = Duration.toMillis(NATIVE_VOICE_SESSION_TTL);
    const parentTtlMillis =
      parent.expiresAt === undefined
        ? maximumTtlMillis
        : Math.max(0, parent.expiresAt.epochMilliseconds - now.epochMilliseconds);
    const ttl = Duration.millis(Math.min(maximumTtlMillis, parentTtlMillis));
    const issued = yield* sessions
      .issue({
        ttl,
        ...(parent.expiresAt === undefined ? {} : { notAfter: DateTime.toUtc(parent.expiresAt) }),
        parentSessionId: parent.sessionId,
        subject: `${NATIVE_VOICE_SESSION_SUBJECT_PREFIX}${parent.sessionId}`,
        method: "bearer-access-token",
        scopes: NATIVE_VOICE_SESSION_SCOPES,
        client: {
          label: "Android voice runtime",
          deviceType: "mobile",
          os: "Android",
        },
      })
      .pipe(
        Effect.catchTag("SessionParentUnavailableError", () =>
          Effect.fail(new NativeVoiceParentSessionInactiveError()),
        ),
      );

    return {
      accessToken: issued.token,
      expiresAt: DateTime.formatIso(issued.expiresAt),
    };
  });

  return NativeVoiceSessionIssuer.of({ issue });
});

export const NativeVoiceSessionIssuerLive = Layer.effect(NativeVoiceSessionIssuer, make);

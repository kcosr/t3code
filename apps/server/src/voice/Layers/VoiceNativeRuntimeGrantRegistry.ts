import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";

import { VoiceNativeRuntimeGrantRepository } from "../../persistence/Services/VoiceNativeRuntimeGrants.ts";
import { VoiceNativeRealtimeStartRepository } from "../../persistence/Services/VoiceNativeRealtimeStarts.ts";
import { VoiceNativeThreadTurnStore } from "../../persistence/Services/VoiceNativeThreadTurns.ts";
import { VoiceError } from "../Errors.ts";
import { VoiceNativeControlGrantRegistry } from "../Services/VoiceNativeControlGrantRegistry.ts";
import {
  VoiceNativeRuntimeGrantRegistry,
  type VoiceNativeRuntimeGrantRegistryShape,
} from "../Services/VoiceNativeRuntimeGrantRegistry.ts";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* VoiceNativeRuntimeGrantRepository;
  const realtimeStarts = yield* VoiceNativeRealtimeStartRepository;
  const childGrants = yield* VoiceNativeControlGrantRegistry;
  const threadTurns = yield* VoiceNativeThreadTurnStore;
  const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

  const issue: VoiceNativeRuntimeGrantRegistryShape["issue"] = (scope) =>
    Effect.gen(function* () {
      const token = yield* crypto
        .randomBytes(32)
        .pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);
      const now = yield* Clock.currentTimeMillis;
      const replacement = yield* repository.replace({ tokenHash: hash(token), ...scope }, now).pipe(
        Effect.mapError(
          (cause) =>
            new VoiceError({
              reason: "provider-unavailable",
              operation: "native-runtime-grant.issue",
              detail: "Native voice authority storage is unavailable",
              retryable: true,
              cause,
            }),
        ),
      );
      if (replacement === "stale") {
        return yield* new VoiceError({
          reason: "invalid-phase",
          operation: "native-runtime-grant.issue",
          detail: "Native voice readiness generation or immutable scope does not match",
          retryable: false,
        });
      }
      if (replacement === "issued") {
        yield* Effect.all(
          [
            childGrants.revokeRuntime(scope.authSessionId, scope.runtimeId),
            realtimeStarts.revokeRuntime(scope.authSessionId, scope.runtimeId).pipe(Effect.orDie),
          ],
          { discard: true },
        ).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Could not purge derived native voice control grants", {
              runtimeId: scope.runtimeId,
            }),
          ),
        );
      }
      return { token, refreshed: replacement === "refreshed" };
    });

  return VoiceNativeRuntimeGrantRegistry.of({
    issue,
    authorize: (token) =>
      Effect.gen(function* () {
        if (token.length === 0 || token.length > 128) return undefined;
        const now = yield* Clock.currentTimeMillis;
        const record = yield* repository.findActive(hash(token), now).pipe(Effect.orDie);
        return record === undefined
          ? undefined
          : {
              authSessionId: record.authSessionId,
              runtimeId: record.runtimeId,
              generation: record.generation,
              grantedScopes: record.grantedScopes,
              target: record.target,
              expiresAt: record.expiresAt,
            };
      }),
    revokeRuntime: (authSessionId, runtimeId) =>
      Effect.gen(function* () {
        const revoked = yield* repository
          .revokeRuntime(authSessionId, runtimeId)
          .pipe(Effect.orDie);
        yield* Effect.all(
          [
            childGrants.revokeRuntime(authSessionId, runtimeId),
            threadTurns.revokeRuntime(authSessionId, runtimeId).pipe(Effect.orDie),
            realtimeStarts.revokeRuntime(authSessionId, runtimeId).pipe(Effect.orDie),
          ],
          { discard: true },
        ).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Could not purge derived native voice runtime authority", {
              runtimeId,
            }),
          ),
        );
        return revoked;
      }),
    revokeAuthSession: (authSessionId) =>
      Effect.all(
        [
          repository.revokeAuthSession(authSessionId).pipe(Effect.orDie),
          childGrants.revokeAuthSession(authSessionId),
          threadTurns.revokeAuthSession(authSessionId).pipe(Effect.orDie),
          realtimeStarts.revokeAuthSession(authSessionId).pipe(Effect.orDie),
        ],
        { discard: true },
      ),
  });
});

export const VoiceNativeRuntimeGrantRegistryLive = Layer.effect(
  VoiceNativeRuntimeGrantRegistry,
  make,
);

export const __testing = { make };

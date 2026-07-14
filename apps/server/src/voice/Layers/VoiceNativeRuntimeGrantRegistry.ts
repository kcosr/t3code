import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { VoiceNativeRuntimeGrantRepository } from "../../persistence/Services/VoiceNativeRuntimeGrants.ts";
import { VoiceNativeRealtimeStartRepository } from "../../persistence/Services/VoiceNativeRealtimeStarts.ts";
import { VoiceNativeThreadTurnStore } from "../../persistence/Services/VoiceNativeThreadTurns.ts";
import { VoiceError } from "../Errors.ts";
import { VoiceNativeControlGrantRegistry } from "../Services/VoiceNativeControlGrantRegistry.ts";
import {
  VoiceNativeRuntimeGrantRegistry,
  type VoiceNativeRuntimeGrantRegistryShape,
} from "../Services/VoiceNativeRuntimeGrantRegistry.ts";

const TOKEN_KEY_NAME = "voice-native-runtime-grant-token-hmac-v1";

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
};

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;
  const tokenKey = yield* secretStore.getOrCreateRandom(TOKEN_KEY_NAME, 32).pipe(Effect.orDie);
  const repository = yield* VoiceNativeRuntimeGrantRepository;
  const realtimeStarts = yield* VoiceNativeRealtimeStartRepository;
  const childGrants = yield* VoiceNativeControlGrantRegistry;
  const threadTurns = yield* VoiceNativeThreadTurnStore;
  const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

  const issue: VoiceNativeRuntimeGrantRegistryShape["issue"] = (scope) =>
    Effect.gen(function* () {
      const token = NodeCrypto.createHmac("sha256", tokenKey)
        .update(
          canonicalJson({
            authSessionId: scope.authSessionId,
            generation: scope.generation,
            grantedScopes: [...scope.grantedScopes].sort(),
            provisioningOperationId: scope.provisioningOperationId,
            runtimeId: scope.runtimeId,
            target: scope.target,
            version: 1,
          }),
        )
        .digest("base64url");
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
      if (replacement.status === "stale") {
        return yield* new VoiceError({
          reason: "invalid-phase",
          operation: "native-runtime-grant.issue",
          detail: "Native voice readiness generation or immutable scope does not match",
          retryable: false,
        });
      }
      return {
        token,
        replayed: replacement.status === "existing",
        issuedAt: replacement.issuedAt,
        expiresAt: replacement.expiresAt,
      };
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
              provisioningOperationId: record.provisioningOperationId,
              grantedScopes: record.grantedScopes,
              target: record.target,
              expiresAt: record.expiresAt,
            };
      }),
    activateTransition: (token, input) =>
      Effect.gen(function* () {
        if (token.length === 0 || token.length > 128) {
          return yield* new VoiceError({
            reason: "invalid-phase",
            operation: "native-runtime-grant.transition",
            detail: "Realtime handoff credential is invalid",
            retryable: false,
          });
        }
        const result = yield* repository
          .transition({ ...input, tokenHash: hash(token) }, yield* Clock.currentTimeMillis)
          .pipe(
            Effect.mapError(
              (cause) =>
                new VoiceError({
                  reason: "provider-unavailable",
                  operation: "native-runtime-grant.transition",
                  detail: "Native voice authority transition storage is unavailable",
                  retryable: true,
                  cause,
                }),
            ),
          );
        if (result.status === "stale") {
          return yield* new VoiceError({
            reason: "authorization-revoked",
            operation: "native-runtime-grant.transition",
            detail: "Realtime handoff authority is stale or conflicts with the active generation",
            retryable: false,
          });
        }
        return { expiresAt: result.expiresAt, replayed: result.status === "existing" };
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

export const __testing = { canonicalJson, make };

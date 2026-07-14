import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import {
  VoiceRuntimeId,
  VoiceRuntimeCredentialHash,
  VoiceRuntimeTargetDigest,
  type VoiceRuntimeGrantOperation,
  type VoiceRuntimeTarget,
} from "@t3tools/contracts";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { VoiceRuntimeGrantRepository } from "../../persistence/Services/VoiceRuntimeGrants.ts";
import { VoiceRuntimeRealtimeStartRepository } from "../../persistence/Services/VoiceRuntimeRealtimeStarts.ts";
import { VoiceThreadTurnStore } from "../../persistence/Services/VoiceThreadTurns.ts";
import { VoiceError } from "../Errors.ts";
import { VoiceRuntimeControlGrantRegistry } from "../Services/VoiceRuntimeControlGrantRegistry.ts";
import {
  VoiceRuntimeGrantRegistry,
  type VoiceRuntimeGrantRegistryShape,
} from "../Services/VoiceRuntimeGrantRegistry.ts";

const TOKEN_KEY_NAME = "voice-voice-runtime-grant-token-hmac-v1";
const REFRESH_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43,512}$/;

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
  const repository = yield* VoiceRuntimeGrantRepository;
  const realtimeStarts = yield* VoiceRuntimeRealtimeStartRepository;
  const childGrants = yield* VoiceRuntimeControlGrantRegistry;
  const threadTurns = yield* VoiceThreadTurnStore;
  const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
  const targetDigest = (target: VoiceRuntimeTarget) =>
    VoiceRuntimeTargetDigest.make(hash(canonicalJson(target)));
  const operationFor = (target: VoiceRuntimeTarget): VoiceRuntimeGrantOperation =>
    target.mode === "realtime" ? "realtime-start" : "thread-turn-start";

  const issue: VoiceRuntimeGrantRegistryShape["issue"] = (scope) =>
    Effect.gen(function* () {
      if (
        scope.targetDigest !== targetDigest(scope.target) ||
        scope.operation !== operationFor(scope.target) ||
        scope.readinessEnabled !== (scope.refreshCredentialHash !== null)
      )
        return yield* new VoiceError({
          reason: "invalid-context",
          operation: "voice-runtime-grant.issue",
          detail: "Voice runtime target identity or readiness credential is invalid",
          retryable: false,
        });
      const token = NodeCrypto.createHmac("sha256", tokenKey)
        .update(
          canonicalJson({
            authSessionId: scope.authSessionId,
            generation: scope.generation,
            grantedScopes: [...scope.grantedScopes].sort(),
            provisioningOperationId: scope.provisioningOperationId,
            runtimeId: scope.runtimeId,
            target: scope.target,
            targetDigest: scope.targetDigest,
            operation: scope.operation,
            readinessEnabled: scope.readinessEnabled,
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
              operation: "voice-runtime-grant.issue",
              detail: "Voice runtime authority storage is unavailable",
              retryable: true,
              cause,
            }),
        ),
      );
      if (replacement.status === "stale") {
        return yield* new VoiceError({
          reason: "invalid-phase",
          operation: "voice-runtime-grant.issue",
          detail: "Voice runtime readiness generation or immutable scope does not match",
          retryable: false,
        });
      }
      return {
        token,
        replayed: replacement.status === "existing",
        issuedAt: replacement.issuedAt,
        expiresAt: replacement.expiresAt,
        refreshRotationCounter: replacement.refreshRotationCounter,
      };
    });

  const refresh: VoiceRuntimeGrantRegistryShape["refresh"] = (refreshCredential, input) =>
    Effect.gen(function* () {
      if (!REFRESH_CREDENTIAL_PATTERN.test(refreshCredential))
        return yield* new VoiceError({
          reason: "authorization-revoked",
          operation: "voice-runtime-grant.refresh",
          detail: "Voice runtime refresh authority is invalid",
          retryable: false,
        });
      const token = NodeCrypto.createHmac("sha256", tokenKey)
        .update(
          canonicalJson({
            candidateCredentialHash: input.candidateCredentialHash,
            expectedRotationCounter: input.expectedRotationCounter,
            generation: input.generation,
            operation: input.operation,
            provisioningOperationId: input.provisioningOperationId,
            refreshRequestId: input.refreshRequestId,
            runtimeId: input.runtimeId,
            targetDigest: input.targetDigest,
            version: 2,
          }),
        )
        .digest("base64url");
      const result = yield* repository
        .refresh(
          {
            ...input,
            refreshCredentialHash: VoiceRuntimeCredentialHash.make(hash(refreshCredential)),
            runtimeGrantTokenHash: hash(token),
            proposedExpiresAt: input.expiresAt,
          },
          yield* Clock.currentTimeMillis,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new VoiceError({
                reason: "provider-unavailable",
                operation: "voice-runtime-grant.refresh",
                detail: "Voice runtime refresh storage is unavailable",
                retryable: true,
                cause,
              }),
          ),
        );
      if (result.status === "stale")
        return yield* new VoiceError({
          reason: "authorization-revoked",
          operation: "voice-runtime-grant.refresh",
          detail: "Voice runtime refresh authority is stale or conflicts with current scope",
          retryable: false,
        });
      return { ...result.grant, token };
    });

  return VoiceRuntimeGrantRegistry.of({
    issue,
    refresh,
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
              targetDigest: record.targetDigest,
              operation: record.operation,
              readinessEnabled: record.readinessEnabled,
              refreshRotationCounter: record.refreshRotationCounter,
              expiresAt: record.expiresAt,
            };
      }),
    activateTransition: (token, input) =>
      Effect.gen(function* () {
        if (token.length === 0 || token.length > 128) {
          return yield* new VoiceError({
            reason: "invalid-phase",
            operation: "voice-runtime-grant.transition",
            detail: "Realtime handoff credential is invalid",
            retryable: false,
          });
        }
        const result = yield* repository
          .transition(
            {
              ...input,
              runtimeId: VoiceRuntimeId.make(input.runtimeId),
              tokenHash: hash(token),
              targetDigest: targetDigest(input.target),
            },
            yield* Clock.currentTimeMillis,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new VoiceError({
                  reason: "provider-unavailable",
                  operation: "voice-runtime-grant.transition",
                  detail: "Voice runtime authority transition storage is unavailable",
                  retryable: true,
                  cause,
                }),
            ),
          );
        if (result.status === "stale") {
          return yield* new VoiceError({
            reason: "authorization-revoked",
            operation: "voice-runtime-grant.transition",
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
            Effect.logWarning("Could not purge derived voice runtime authority", {
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

export const VoiceRuntimeGrantRegistryLive = Layer.effect(VoiceRuntimeGrantRegistry, make);

export const __testing = { canonicalJson, make };

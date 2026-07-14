import type { AuthSessionId, VoiceRuntimeId, VoiceSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";

import { VoiceRuntimeControlGrantRepository } from "../../persistence/Services/VoiceRuntimeControlGrants.ts";
import { VoiceError } from "../Errors.ts";

export interface VoiceRuntimeControlGrantScope {
  readonly authSessionId: AuthSessionId;
  readonly sessionId: VoiceSessionId;
  readonly leaseGeneration: number;
  readonly expiresAt: number;
  readonly capabilities: ReadonlySet<VoiceRuntimeControlCapability>;
  readonly runtimeId?: VoiceRuntimeId;
  readonly runtimeGeneration?: number;
}

export type VoiceRuntimeControlCapability =
  | "session-control"
  | "handoff-actions"
  | "webrtc-signaling"
  | "session-close";

export interface VoiceRuntimeControlGrantRegistryShape {
  readonly issue: (scope: VoiceRuntimeControlGrantScope) => Effect.Effect<string, VoiceError>;
  readonly authorize: (token: string) => Effect.Effect<VoiceRuntimeControlGrantScope | undefined>;
  readonly revokeSession: (sessionId: VoiceSessionId) => Effect.Effect<void>;
  readonly releaseSessionControl: (sessionId: VoiceSessionId) => Effect.Effect<void>;
  readonly completeHandoff: (sessionId: VoiceSessionId) => Effect.Effect<void>;
  readonly revokeAuthSession: (authSessionId: AuthSessionId) => Effect.Effect<void>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<void>;
}

export class VoiceRuntimeControlGrantRegistry extends Context.Service<
  VoiceRuntimeControlGrantRegistry,
  VoiceRuntimeControlGrantRegistryShape
>()("t3/voice/Services/VoiceRuntimeControlGrantRegistry") {}

const makeWithOptions = Effect.fn("VoiceRuntimeControlGrantRegistry.make")(function* (
  options: {
    readonly now?: () => number;
  } = {},
) {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* VoiceRuntimeControlGrantRepository;
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

  const issue: VoiceRuntimeControlGrantRegistryShape["issue"] = Effect.fn(
    "VoiceRuntimeControlGrantRegistry.issue",
  )(function* (scope) {
    const token = yield* crypto
      .randomBytes(32)
      .pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);
    const now = yield* currentTimeMillis;
    const inserted = yield* repository.insert({ tokenHash: hash(token), ...scope }, now).pipe(
      Effect.mapError(
        (cause) =>
          new VoiceError({
            reason: "provider-unavailable",
            operation: "native-control-grant.issue",
            detail: "Voice runtime authority storage is unavailable",
            retryable: true,
            cause,
          }),
      ),
    );
    if (!inserted) {
      return yield* new VoiceError({
        reason: "invalid-phase",
        operation: "native-control-grant.issue",
        detail: "Voice runtime authority changed before session control was issued",
        retryable: true,
      });
    }
    return token;
  });

  const authorize: VoiceRuntimeControlGrantRegistryShape["authorize"] = Effect.fn(
    "VoiceRuntimeControlGrantRegistry.authorize",
  )(function* (token) {
    if (token.length === 0 || token.length > 128) return undefined;
    const now = yield* currentTimeMillis;
    const record = yield* repository.findActive(hash(token), now).pipe(Effect.orDie);
    if (record === undefined) return undefined;
    return {
      authSessionId: record.authSessionId,
      sessionId: record.sessionId,
      leaseGeneration: record.leaseGeneration,
      expiresAt: record.expiresAt,
      capabilities: record.capabilities,
      ...(record.runtimeId === undefined ? {} : { runtimeId: record.runtimeId }),
      ...(record.runtimeGeneration === undefined
        ? {}
        : { runtimeGeneration: record.runtimeGeneration }),
    };
  });

  return VoiceRuntimeControlGrantRegistry.of({
    issue,
    authorize,
    revokeSession: (sessionId) => repository.revokeSession(sessionId).pipe(Effect.orDie),
    releaseSessionControl: (sessionId) =>
      repository.releaseSessionControl(sessionId).pipe(Effect.orDie),
    completeHandoff: (sessionId) => repository.completeHandoff(sessionId).pipe(Effect.orDie),
    revokeAuthSession: (authSessionId) =>
      repository.revokeAuthSession(authSessionId).pipe(Effect.orDie),
    revokeRuntime: (authSessionId, runtimeId) =>
      repository.revokeRuntime(authSessionId, runtimeId).pipe(Effect.orDie),
  });
});

export const VoiceRuntimeControlGrantRegistryLive = Layer.effect(
  VoiceRuntimeControlGrantRegistry,
  makeWithOptions(),
);

export const __testing = { make: makeWithOptions };

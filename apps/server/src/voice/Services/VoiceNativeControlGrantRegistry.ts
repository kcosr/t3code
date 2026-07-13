import type { AuthSessionId, VoiceSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";

import { VoiceNativeControlGrantRepository } from "../../persistence/Services/VoiceNativeControlGrants.ts";

export interface VoiceNativeControlGrantScope {
  readonly authSessionId: AuthSessionId;
  readonly sessionId: VoiceSessionId;
  readonly leaseGeneration: number;
  readonly expiresAt: number;
  readonly capabilities: ReadonlySet<VoiceNativeControlCapability>;
}

export type VoiceNativeControlCapability = "session-control" | "handoff-actions";

export interface VoiceNativeControlGrantRegistryShape {
  readonly issue: (scope: VoiceNativeControlGrantScope) => Effect.Effect<string>;
  readonly authorize: (token: string) => Effect.Effect<VoiceNativeControlGrantScope | undefined>;
  readonly revokeSession: (sessionId: VoiceSessionId) => Effect.Effect<void>;
  readonly releaseSessionControl: (sessionId: VoiceSessionId) => Effect.Effect<void>;
  readonly revokeAuthSession: (authSessionId: AuthSessionId) => Effect.Effect<void>;
}

export class VoiceNativeControlGrantRegistry extends Context.Service<
  VoiceNativeControlGrantRegistry,
  VoiceNativeControlGrantRegistryShape
>()("t3/voice/Services/VoiceNativeControlGrantRegistry") {}

const makeWithOptions = Effect.fn("VoiceNativeControlGrantRegistry.make")(function* (
  options: {
    readonly now?: () => number;
  } = {},
) {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* VoiceNativeControlGrantRepository;
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

  const issue: VoiceNativeControlGrantRegistryShape["issue"] = Effect.fn(
    "VoiceNativeControlGrantRegistry.issue",
  )(function* (scope) {
    const token = yield* crypto
      .randomBytes(32)
      .pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);
    const now = yield* currentTimeMillis;
    yield* repository.insert({ tokenHash: hash(token), ...scope }, now).pipe(Effect.orDie);
    return token;
  });

  const authorize: VoiceNativeControlGrantRegistryShape["authorize"] = Effect.fn(
    "VoiceNativeControlGrantRegistry.authorize",
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
    };
  });

  return VoiceNativeControlGrantRegistry.of({
    issue,
    authorize,
    revokeSession: (sessionId) => repository.revokeSession(sessionId).pipe(Effect.orDie),
    releaseSessionControl: (sessionId) =>
      repository.releaseSessionControl(sessionId).pipe(Effect.orDie),
    revokeAuthSession: (authSessionId) =>
      repository.revokeAuthSession(authSessionId).pipe(Effect.orDie),
  });
});

export const VoiceNativeControlGrantRegistryLive = Layer.effect(
  VoiceNativeControlGrantRegistry,
  makeWithOptions(),
);

export const __testing = { make: makeWithOptions };

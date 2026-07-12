import type { AuthSessionId, VoiceSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as NodeCrypto from "node:crypto";

export interface VoiceNativeControlGrantScope {
  readonly authSessionId: AuthSessionId;
  readonly sessionId: VoiceSessionId;
  readonly leaseGeneration: number;
  readonly expiresAt: number;
}

export interface VoiceNativeControlGrantRegistryShape {
  readonly issue: (scope: VoiceNativeControlGrantScope) => Effect.Effect<string>;
  readonly authorize: (token: string) => Effect.Effect<VoiceNativeControlGrantScope | undefined>;
  readonly revokeSession: (sessionId: VoiceSessionId) => Effect.Effect<void>;
  readonly revokeAuthSession: (authSessionId: AuthSessionId) => Effect.Effect<void>;
}

export class VoiceNativeControlGrantRegistry extends Context.Service<
  VoiceNativeControlGrantRegistry,
  VoiceNativeControlGrantRegistryShape
>()("t3/voice/Services/VoiceNativeControlGrantRegistry") {}

interface GrantRecord {
  readonly nonce: string;
  readonly tokenHash: string;
  readonly scope: VoiceNativeControlGrantScope;
}

const makeWithOptions = Effect.fn("VoiceNativeControlGrantRegistry.make")(function* (
  options: {
    readonly now?: () => number;
  } = {},
) {
  const crypto = yield* Crypto.Crypto;
  const tokenSecret = yield* crypto.randomBytes(32).pipe(Effect.orDie);
  const state = yield* SynchronizedRef.make<ReadonlyMap<string, GrantRecord>>(new Map());
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
  const sameScope = (left: VoiceNativeControlGrantScope, right: VoiceNativeControlGrantScope) =>
    left.authSessionId === right.authSessionId &&
    left.sessionId === right.sessionId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.expiresAt === right.expiresAt;
  const deriveToken = (scope: VoiceNativeControlGrantScope, nonce: string) =>
    NodeCrypto.createHmac("sha256", tokenSecret)
      .update(
        JSON.stringify([
          scope.authSessionId,
          scope.sessionId,
          scope.leaseGeneration,
          scope.expiresAt,
          nonce,
        ]),
      )
      .digest("base64url");
  const prune = (records: ReadonlyMap<string, GrantRecord>, now: number) =>
    new Map(Array.from(records).filter(([, record]) => now < record.scope.expiresAt));

  const issue: VoiceNativeControlGrantRegistryShape["issue"] = Effect.fn(
    "VoiceNativeControlGrantRegistry.issue",
  )(function* (scope) {
    const nonce = yield* crypto
      .randomBytes(16)
      .pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);
    const now = yield* currentTimeMillis;
    return yield* SynchronizedRef.modify(state, (records) => {
      const next = prune(records, now);
      const existing = Array.from(next.values()).find((record) => sameScope(record.scope, scope));
      if (existing !== undefined) {
        return [deriveToken(existing.scope, existing.nonce), next] as const;
      }
      for (const [recordHash, record] of next) {
        if (record.scope.sessionId === scope.sessionId) next.delete(recordHash);
      }
      const token = deriveToken(scope, nonce);
      const tokenHash = hash(token);
      next.set(tokenHash, { nonce, tokenHash, scope });
      return [token, next] as const;
    });
  });

  const authorize: VoiceNativeControlGrantRegistryShape["authorize"] = Effect.fn(
    "VoiceNativeControlGrantRegistry.authorize",
  )(function* (token) {
    if (token.length === 0 || token.length > 128) return undefined;
    const tokenHash = hash(token);
    const now = yield* currentTimeMillis;
    return yield* SynchronizedRef.modify(state, (records) => {
      const next = prune(records, now);
      return [next.get(tokenHash)?.scope, next] as const;
    });
  });

  const revokeWhere = (predicate: (scope: VoiceNativeControlGrantScope) => boolean) =>
    SynchronizedRef.update(
      state,
      (records) => new Map(Array.from(records).filter(([, record]) => !predicate(record.scope))),
    );

  return VoiceNativeControlGrantRegistry.of({
    issue,
    authorize,
    revokeSession: (sessionId) => revokeWhere((scope) => scope.sessionId === sessionId),
    revokeAuthSession: (authSessionId) =>
      revokeWhere((scope) => scope.authSessionId === authSessionId),
  });
});

export const VoiceNativeControlGrantRegistryLive = Layer.effect(
  VoiceNativeControlGrantRegistry,
  makeWithOptions(),
);

export const __testing = { make: makeWithOptions };

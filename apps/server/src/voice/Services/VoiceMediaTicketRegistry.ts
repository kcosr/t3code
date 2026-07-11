import type {
  AuthSessionId,
  VoiceMediaTicket,
  VoiceMediaTicketOperation,
  VoiceRequestId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface VoiceMediaTicketScope {
  readonly authSessionId: AuthSessionId;
  readonly operation: VoiceMediaTicketOperation;
  readonly requestId?: VoiceRequestId;
  readonly voiceSessionId?: VoiceSessionId;
  readonly expiresAt: number;
}

export interface VoiceMediaTicketIssueInput extends Omit<VoiceMediaTicketScope, "expiresAt"> {}

export interface VoiceMediaTicketRegistryShape {
  readonly issue: (input: VoiceMediaTicketIssueInput) => Effect.Effect<VoiceMediaTicket>;
  readonly consume: (
    token: string,
    operation: VoiceMediaTicketOperation,
  ) => Effect.Effect<VoiceMediaTicketScope | undefined>;
  readonly revokeAuthSession: (authSessionId: AuthSessionId) => Effect.Effect<void>;
  readonly revokeVoiceSession: (voiceSessionId: VoiceSessionId) => Effect.Effect<void>;
}

export class VoiceMediaTicketRegistry extends Context.Service<
  VoiceMediaTicketRegistry,
  VoiceMediaTicketRegistryShape
>()("t3/voice/Services/VoiceMediaTicketRegistry") {}

interface TicketRecord {
  readonly tokenHash: string;
  readonly scope: VoiceMediaTicketScope;
}

export interface VoiceMediaTicketRegistryOptions {
  readonly lifetimeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_LIFETIME_MS = 60_000;
const encoder = new TextEncoder();
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const makeWithOptions = Effect.fn("VoiceMediaTicketRegistry.make")(function* (
  options: VoiceMediaTicketRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<ReadonlyMap<string, TicketRecord>>(new Map());
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
  const hash = (token: string) =>
    crypto.digest("SHA-256", encoder.encode(token)).pipe(Effect.map(bytesToHex), Effect.orDie);

  const prune = (records: ReadonlyMap<string, TicketRecord>, now: number) =>
    new Map(Array.from(records).filter(([, record]) => now <= record.scope.expiresAt));

  const issue: VoiceMediaTicketRegistryShape["issue"] = Effect.fn("VoiceMediaTicketRegistry.issue")(
    function* (input) {
      const now = yield* currentTimeMillis;
      const ticketId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const token = yield* crypto
        .randomBytes(32)
        .pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);
      const tokenHash = yield* hash(token);
      const scope: VoiceMediaTicketScope = {
        ...input,
        expiresAt: now + lifetimeMs,
      };
      yield* SynchronizedRef.update(state, (records) => {
        const next = prune(records, now);
        next.set(tokenHash, { tokenHash, scope });
        return next;
      });
      return {
        ticketId: ticketId as VoiceMediaTicket["ticketId"],
        token,
        operation: input.operation,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(scope.expiresAt)),
      };
    },
  );

  const consume: VoiceMediaTicketRegistryShape["consume"] = Effect.fn(
    "VoiceMediaTicketRegistry.consume",
  )(function* (token, operation) {
    if (token.length === 0) return undefined;
    const now = yield* currentTimeMillis;
    const tokenHash = yield* hash(token);
    return yield* SynchronizedRef.modify(state, (records) => {
      const current = prune(records, now);
      const record = current.get(tokenHash);
      if (record === undefined || record.scope.operation !== operation) {
        return [undefined, current] as const;
      }
      const next = new Map(current);
      next.delete(tokenHash);
      return [record.scope, next] as const;
    });
  });

  const revokeWhere = (predicate: (scope: VoiceMediaTicketScope) => boolean) =>
    SynchronizedRef.update(
      state,
      (records) => new Map(Array.from(records).filter(([, record]) => !predicate(record.scope))),
    );

  return VoiceMediaTicketRegistry.of({
    issue,
    consume,
    revokeAuthSession: (authSessionId) =>
      revokeWhere((scope) => scope.authSessionId === authSessionId),
    revokeVoiceSession: (voiceSessionId) =>
      revokeWhere((scope) => scope.voiceSessionId === voiceSessionId),
  });
});

export const VoiceMediaTicketRegistryLive = Layer.effect(
  VoiceMediaTicketRegistry,
  makeWithOptions(),
);

export const __testing = { make: makeWithOptions };

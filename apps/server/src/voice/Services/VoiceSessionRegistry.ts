import { VoiceSessionId } from "@t3tools/contracts";
import type { AuthSessionId, VoiceConversationId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { VoiceError } from "../Errors.ts";

export interface VoiceSessionLease {
  readonly conversationId: VoiceConversationId;
  readonly sessionId: VoiceSessionId;
  readonly ownerAuthSessionId: AuthSessionId;
  readonly generation: number;
}

export interface VoiceSessionAcquireResult {
  readonly lease: VoiceSessionLease;
  readonly replacedSessionId: Option.Option<VoiceSessionId>;
}

export interface VoiceSessionRegistryShape {
  readonly acquire: (input: {
    readonly conversationId: VoiceConversationId;
    readonly ownerAuthSessionId: AuthSessionId;
    readonly takeover: boolean;
  }) => Effect.Effect<VoiceSessionAcquireResult, VoiceError>;
  readonly get: (sessionId: VoiceSessionId) => Effect.Effect<Option.Option<VoiceSessionLease>>;
  readonly isCurrent: (lease: VoiceSessionLease) => Effect.Effect<boolean>;
  readonly release: (lease: VoiceSessionLease) => Effect.Effect<boolean>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<VoiceSessionId>>;
}

export class VoiceSessionRegistry extends Context.Service<
  VoiceSessionRegistry,
  VoiceSessionRegistryShape
>()("t3/voice/Services/VoiceSessionRegistry") {}

interface RegistryState {
  readonly byConversation: ReadonlyMap<VoiceConversationId, VoiceSessionLease>;
  readonly bySession: ReadonlyMap<VoiceSessionId, VoiceSessionLease>;
  readonly generations: ReadonlyMap<VoiceConversationId, number>;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<RegistryState>({
    byConversation: new Map(),
    bySession: new Map(),
    generations: new Map(),
  });

  const acquire: VoiceSessionRegistryShape["acquire"] = Effect.fn("VoiceSessionRegistry.acquire")(
    function* (input) {
      const sessionId = VoiceSessionId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      return yield* SynchronizedRef.modifyEffect(state, (current) => {
        const active = current.byConversation.get(input.conversationId);
        if (active !== undefined && !input.takeover) {
          return Effect.fail(
            new VoiceError({
              reason: "takeover-required",
              operation: "session.acquire",
              detail: "The conversation already has an active media lease",
              retryable: false,
            }),
          );
        }

        const generation = (current.generations.get(input.conversationId) ?? 0) + 1;
        const lease: VoiceSessionLease = {
          conversationId: input.conversationId,
          sessionId,
          ownerAuthSessionId: input.ownerAuthSessionId,
          generation,
        };
        const byConversation = new Map(current.byConversation);
        const bySession = new Map(current.bySession);
        if (active !== undefined) bySession.delete(active.sessionId);
        byConversation.set(input.conversationId, lease);
        bySession.set(sessionId, lease);
        const generations = new Map(current.generations);
        generations.set(input.conversationId, generation);
        return Effect.succeed([
          {
            lease,
            replacedSessionId: Option.fromUndefinedOr(active?.sessionId),
          },
          { byConversation, bySession, generations },
        ] as const);
      });
    },
  );

  const get: VoiceSessionRegistryShape["get"] = (sessionId) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) => Option.fromUndefinedOr(current.bySession.get(sessionId))),
    );

  const isCurrent: VoiceSessionRegistryShape["isCurrent"] = (lease) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) => {
        const active = current.byConversation.get(lease.conversationId);
        return active?.sessionId === lease.sessionId && active.generation === lease.generation;
      }),
    );

  const release: VoiceSessionRegistryShape["release"] = (lease) =>
    SynchronizedRef.modify(state, (current) => {
      const active = current.byConversation.get(lease.conversationId);
      if (active?.sessionId !== lease.sessionId || active.generation !== lease.generation) {
        return [false, current] as const;
      }
      const byConversation = new Map(current.byConversation);
      const bySession = new Map(current.bySession);
      byConversation.delete(lease.conversationId);
      bySession.delete(lease.sessionId);
      return [true, { ...current, byConversation, bySession }] as const;
    });

  const revokeAuthSession: VoiceSessionRegistryShape["revokeAuthSession"] = (authSessionId) =>
    SynchronizedRef.modify(state, (current) => {
      const revoked = Array.from(current.bySession.values()).filter(
        (lease) => lease.ownerAuthSessionId === authSessionId,
      );
      if (revoked.length === 0) {
        return [[] as ReadonlyArray<VoiceSessionId>, current] as const;
      }
      const byConversation = new Map(current.byConversation);
      const bySession = new Map(current.bySession);
      for (const lease of revoked) {
        byConversation.delete(lease.conversationId);
        bySession.delete(lease.sessionId);
      }
      return [
        revoked.map((lease) => lease.sessionId) as ReadonlyArray<VoiceSessionId>,
        { ...current, byConversation, bySession },
      ] as const;
    });

  return VoiceSessionRegistry.of({ acquire, get, isCurrent, release, revokeAuthSession });
});

export const VoiceSessionRegistryLive = Layer.effect(VoiceSessionRegistry, make);

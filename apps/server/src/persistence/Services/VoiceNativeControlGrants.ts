import type { AuthSessionId, VoiceNativeRuntimeId, VoiceSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeControlGrant {
  readonly tokenHash: string;
  readonly authSessionId: AuthSessionId;
  readonly sessionId: VoiceSessionId;
  readonly leaseGeneration: number;
  readonly expiresAt: number;
  readonly capabilities: ReadonlySet<
    "session-control" | "handoff-actions" | "webrtc-signaling" | "session-close"
  >;
  readonly runtimeId?: VoiceNativeRuntimeId;
  readonly runtimeGeneration?: number;
}

export interface VoiceNativeControlGrantRepositoryShape {
  readonly insert: (
    grant: PersistedVoiceNativeControlGrant,
    now: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly findActive: (
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceNativeControlGrant | undefined, PersistenceSqlError>;
  readonly releaseSessionControl: (
    sessionId: VoiceSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly completeHandoff: (sessionId: VoiceSessionId) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeSession: (sessionId: VoiceSessionId) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceNativeRuntimeId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceNativeControlGrantRepository extends Context.Service<
  VoiceNativeControlGrantRepository,
  VoiceNativeControlGrantRepositoryShape
>()("t3/persistence/Services/VoiceNativeControlGrants/VoiceNativeControlGrantRepository") {}

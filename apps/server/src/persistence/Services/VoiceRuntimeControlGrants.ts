import type { AuthSessionId, VoiceRuntimeId, VoiceSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceRuntimeControlGrant {
  readonly tokenHash: string;
  readonly authSessionId: AuthSessionId;
  readonly sessionId: VoiceSessionId;
  readonly leaseGeneration: number;
  readonly expiresAt: number;
  readonly capabilities: ReadonlySet<
    "session-control" | "handoff-actions" | "webrtc-signaling" | "session-close"
  >;
  readonly runtimeId?: VoiceRuntimeId;
  readonly runtimeGeneration?: number;
}

export interface VoiceRuntimeControlGrantRepositoryShape {
  readonly insert: (
    grant: PersistedVoiceRuntimeControlGrant,
    now: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly findActive: (
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceRuntimeControlGrant | undefined, PersistenceSqlError>;
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
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceRuntimeControlGrantRepository extends Context.Service<
  VoiceRuntimeControlGrantRepository,
  VoiceRuntimeControlGrantRepositoryShape
>()("t3/persistence/Services/VoiceRuntimeControlGrants/VoiceRuntimeControlGrantRepository") {}

import type { AuthSessionId, VoiceSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeControlGrant {
  readonly tokenHash: string;
  readonly authSessionId: AuthSessionId;
  readonly sessionId: VoiceSessionId;
  readonly leaseGeneration: number;
  readonly expiresAt: number;
  readonly capabilities: ReadonlySet<"session-control" | "handoff-actions">;
}

export interface VoiceNativeControlGrantRepositoryShape {
  readonly insert: (
    grant: PersistedVoiceNativeControlGrant,
    now: number,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly findActive: (
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceNativeControlGrant | undefined, PersistenceSqlError>;
  readonly releaseSessionControl: (
    sessionId: VoiceSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeSession: (sessionId: VoiceSessionId) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceNativeControlGrantRepository extends Context.Service<
  VoiceNativeControlGrantRepository,
  VoiceNativeControlGrantRepositoryShape
>()("t3/persistence/Services/VoiceNativeControlGrants/VoiceNativeControlGrantRepository") {}

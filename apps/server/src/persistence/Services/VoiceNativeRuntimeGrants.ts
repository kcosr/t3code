import type {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceNativeRuntimeId,
  VoiceNativeRuntimeTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeRuntimeGrant {
  readonly tokenHash: string;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly generation: number;
  readonly authSessionId: AuthSessionId;
  readonly grantedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly target: VoiceNativeRuntimeTarget;
  readonly expiresAt: number;
}

export interface VoiceNativeRuntimeGrantRepositoryShape {
  readonly replace: (
    grant: PersistedVoiceNativeRuntimeGrant,
    now: number,
  ) => Effect.Effect<"issued" | "refreshed" | "stale", PersistenceSqlError>;
  readonly findActive: (
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceNativeRuntimeGrant | undefined, PersistenceSqlError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceNativeRuntimeId,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceNativeRuntimeGrantRepository extends Context.Service<
  VoiceNativeRuntimeGrantRepository,
  VoiceNativeRuntimeGrantRepositoryShape
>()("t3/persistence/Services/VoiceNativeRuntimeGrants/VoiceNativeRuntimeGrantRepository") {}

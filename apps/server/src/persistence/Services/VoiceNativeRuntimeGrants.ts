import type {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceNativeRuntimeId,
  VoiceNativeRuntimeTarget,
  VoiceRuntimeProvisioningOperationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeRuntimeGrant {
  readonly tokenHash: string;
  readonly provisioningOperationId: VoiceRuntimeProvisioningOperationId;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly generation: number;
  readonly authSessionId: AuthSessionId;
  readonly grantedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly target: VoiceNativeRuntimeTarget;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type PersistedVoiceNativeRuntimeGrantReplacement = Omit<
  PersistedVoiceNativeRuntimeGrant,
  "issuedAt"
>;

export interface VoiceNativeRuntimeGrantReplacementResult {
  readonly status: "issued" | "existing";
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface VoiceNativeRuntimeGrantRepositoryShape {
  readonly replace: (
    grant: PersistedVoiceNativeRuntimeGrantReplacement,
    now: number,
  ) => Effect.Effect<
    VoiceNativeRuntimeGrantReplacementResult | { readonly status: "stale" },
    PersistenceSqlError
  >;
  readonly findActive: (
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceNativeRuntimeGrant | undefined, PersistenceSqlError>;
  readonly transition: (
    input: {
      readonly authSessionId: AuthSessionId;
      readonly runtimeId: VoiceNativeRuntimeId;
      readonly sourceGeneration: number;
      readonly targetGeneration: number;
      readonly tokenHash: string;
      readonly target: VoiceNativeRuntimeTarget;
    },
    now: number,
  ) => Effect.Effect<
    VoiceNativeRuntimeGrantReplacementResult | { readonly status: "stale" },
    PersistenceSqlError
  >;
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

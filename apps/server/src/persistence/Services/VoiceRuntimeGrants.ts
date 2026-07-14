import type {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceRuntimeCredentialHash,
  VoiceRuntimeGrantOperation,
  VoiceRuntimeId,
  VoiceRuntimeProvisioningOperationId,
  VoiceRuntimeTarget,
  VoiceRuntimeTargetDigest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceRuntimeGrant {
  readonly tokenHash: string;
  readonly provisioningOperationId: VoiceRuntimeProvisioningOperationId;
  readonly runtimeId: VoiceRuntimeId;
  readonly generation: number;
  readonly authSessionId: AuthSessionId;
  readonly grantedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly target: VoiceRuntimeTarget;
  readonly targetDigest: VoiceRuntimeTargetDigest;
  readonly operation: VoiceRuntimeGrantOperation;
  readonly readinessEnabled: boolean;
  readonly refreshRotationCounter: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type PersistedVoiceRuntimeGrantReplacement = Omit<
  PersistedVoiceRuntimeGrant,
  "issuedAt" | "refreshRotationCounter"
> & {
  readonly expectedCurrentGeneration: number;
  readonly refreshCredentialHash: VoiceRuntimeCredentialHash | null;
};

export interface VoiceRuntimeGrantReplacementResult {
  readonly status: "issued" | "existing";
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly refreshRotationCounter: number;
}

export interface VoiceRuntimeGrantRepositoryShape {
  readonly replace: (
    grant: PersistedVoiceRuntimeGrantReplacement,
    now: number,
  ) => Effect.Effect<
    VoiceRuntimeGrantReplacementResult | { readonly status: "stale" },
    PersistenceSqlError
  >;
  readonly findActive: (
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceRuntimeGrant | undefined, PersistenceSqlError>;
  readonly transition: (
    input: {
      readonly authSessionId: AuthSessionId;
      readonly runtimeId: VoiceRuntimeId;
      readonly sourceGeneration: number;
      readonly targetGeneration: number;
      readonly tokenHash: string;
      readonly target: VoiceRuntimeTarget;
      readonly targetDigest: VoiceRuntimeTargetDigest;
      readonly authorityExpiresAt: number;
    },
    now: number,
  ) => Effect.Effect<
    VoiceRuntimeGrantReplacementResult | { readonly status: "stale" },
    PersistenceSqlError
  >;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly refresh: (
    input: {
      readonly refreshCredentialHash: VoiceRuntimeCredentialHash;
      readonly runtimeGrantTokenHash: string;
      readonly runtimeId: VoiceRuntimeId;
      readonly refreshRequestId: string;
      readonly provisioningOperationId: VoiceRuntimeProvisioningOperationId;
      readonly generation: number;
      readonly operation: VoiceRuntimeGrantOperation;
      readonly targetDigest: VoiceRuntimeTargetDigest;
      readonly expectedRotationCounter: number;
      readonly candidateCredentialHash: VoiceRuntimeCredentialHash;
      readonly proposedExpiresAt: number;
    },
    now: number,
  ) => Effect.Effect<
    | {
        readonly status: "issued" | "existing";
        readonly grant: PersistedVoiceRuntimeGrant;
      }
    | { readonly status: "stale" },
    PersistenceSqlError
  >;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceRuntimeGrantRepository extends Context.Service<
  VoiceRuntimeGrantRepository,
  VoiceRuntimeGrantRepositoryShape
>()("t3/persistence/Services/VoiceRuntimeGrants/VoiceRuntimeGrantRepository") {}

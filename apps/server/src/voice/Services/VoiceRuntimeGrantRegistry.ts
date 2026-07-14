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

import type { VoiceError } from "../Errors.ts";

export interface VoiceRuntimeGrantScope {
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceRuntimeId;
  readonly generation: number;
  readonly provisioningOperationId: VoiceRuntimeProvisioningOperationId;
  readonly grantedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly target: VoiceRuntimeTarget;
  readonly targetDigest: VoiceRuntimeTargetDigest;
  readonly operation: VoiceRuntimeGrantOperation;
  readonly readinessEnabled: boolean;
  readonly refreshRotationCounter: number;
  readonly expiresAt: number;
}

export interface VoiceRuntimeGrantRegistryShape {
  readonly issue: (
    scope: Omit<VoiceRuntimeGrantScope, "refreshRotationCounter"> & {
      readonly expectedCurrentGeneration: number;
      readonly refreshCredentialHash: VoiceRuntimeCredentialHash | null;
    },
  ) => Effect.Effect<
    {
      readonly token: string;
      readonly replayed: boolean;
      readonly issuedAt: number;
      readonly expiresAt: number;
      readonly refreshRotationCounter: number;
    },
    VoiceError
  >;
  readonly authorize: (token: string) => Effect.Effect<VoiceRuntimeGrantScope | undefined>;
  readonly refresh: (
    refreshCredential: string,
    input: {
      readonly authSessionId?: never;
      readonly runtimeId: VoiceRuntimeId;
      readonly refreshRequestId: string;
      readonly provisioningOperationId: VoiceRuntimeProvisioningOperationId;
      readonly generation: number;
      readonly operation: VoiceRuntimeGrantOperation;
      readonly targetDigest: VoiceRuntimeTargetDigest;
      readonly expectedRotationCounter: number;
      readonly candidateCredentialHash: VoiceRuntimeCredentialHash;
      readonly expiresAt: number;
    },
  ) => Effect.Effect<
    VoiceRuntimeGrantScope & {
      readonly token: string;
      readonly issuedAt: number;
    },
    VoiceError
  >;
  readonly activateTransition: (
    token: string,
    input: {
      readonly authSessionId: AuthSessionId;
      readonly runtimeId: VoiceRuntimeId;
      readonly sourceGeneration: number;
      readonly targetGeneration: number;
      readonly target: VoiceRuntimeTarget;
      readonly authorityExpiresAt: number;
    },
  ) => Effect.Effect<{ readonly expiresAt: number; readonly replayed: boolean }, VoiceError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<boolean>;
  readonly revokeAuthSession: (authSessionId: AuthSessionId) => Effect.Effect<void>;
}

export class VoiceRuntimeGrantRegistry extends Context.Service<
  VoiceRuntimeGrantRegistry,
  VoiceRuntimeGrantRegistryShape
>()("t3/voice/Services/VoiceRuntimeGrantRegistry") {}

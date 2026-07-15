import type {
  AuthSessionId,
  VoiceClientActionId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
  VoiceRuntimeTarget,
  VoiceThreadRuntimeTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceRuntimeAuthority {
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceRuntimeId;
  readonly generation: number;
  readonly target: VoiceRuntimeTarget;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VoiceRuntimeAuthorityRepositoryShape {
  readonly configure: (
    input: {
      readonly authSessionId: AuthSessionId;
      readonly runtimeId: VoiceRuntimeId;
      readonly expectedCurrentGeneration: number;
      readonly generation: number;
      readonly target: VoiceRuntimeTarget;
    },
    now: number,
  ) => Effect.Effect<
    | {
        readonly status: "configured" | "existing";
        readonly authority: PersistedVoiceRuntimeAuthority;
      }
    | { readonly status: "stale" },
    PersistenceSqlError
  >;
  readonly find: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<PersistedVoiceRuntimeAuthority | undefined, PersistenceSqlError>;
  readonly consumeHandoff: (
    input: {
      readonly authSessionId: AuthSessionId;
      readonly runtimeId: VoiceRuntimeId;
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
      readonly sourceSessionId: VoiceSessionId;
      readonly sourceLeaseGeneration: number;
      readonly actionId: VoiceClientActionId;
      readonly actionSequence: number;
      readonly sourceGeneration: number;
      readonly nextGeneration: number;
      readonly modeSessionId: VoiceModeSessionId;
    },
    now: number,
  ) => Effect.Effect<
    | { readonly status: "consumed" | "existing"; readonly target: VoiceThreadRuntimeTarget }
    | { readonly status: "stale" },
    PersistenceSqlError
  >;
  readonly clearRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly clearAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceRuntimeAuthorityRepository extends Context.Service<
  VoiceRuntimeAuthorityRepository,
  VoiceRuntimeAuthorityRepositoryShape
>()("t3/persistence/Services/VoiceRuntimeAuthorities/VoiceRuntimeAuthorityRepository") {}

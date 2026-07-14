import type {
  AuthSessionId,
  VoiceClientActionId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
  VoiceThreadRuntimeTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceRealtimeTransitionGrant {
  readonly operationKey: string;
  readonly tokenHash: string;
  readonly sourceControlTokenHash: string;
  readonly authSessionId: AuthSessionId;
  readonly sourceSessionId: VoiceSessionId;
  readonly sourceLeaseGeneration: number;
  readonly actionId: VoiceClientActionId;
  readonly actionSequence: number;
  readonly runtimeId: VoiceRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly modeSessionId: VoiceModeSessionId;
  readonly target: VoiceThreadRuntimeTarget;
  readonly expiresAt: number;
  readonly authorityExpiresAt: number;
  readonly consumedAt: number | null;
}

export interface VoiceRealtimeTransitionGrantRepositoryShape {
  readonly claim: (
    record: Omit<PersistedVoiceRealtimeTransitionGrant, "consumedAt">,
    now: number,
  ) => Effect.Effect<
    | { readonly status: "claimed" }
    | { readonly status: "existing"; readonly record: PersistedVoiceRealtimeTransitionGrant }
    | { readonly status: "mismatch" },
    PersistenceSqlError
  >;
  readonly findByToken: (
    tokenHash: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceRealtimeTransitionGrant | undefined, PersistenceSqlError>;
  readonly findByOperationKey: (
    operationKey: string,
    now: number,
  ) => Effect.Effect<PersistedVoiceRealtimeTransitionGrant | undefined, PersistenceSqlError>;
  readonly revoke: (operationKey: string) => Effect.Effect<void, PersistenceSqlError>;
  readonly purgeExpired: (now: number) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceRealtimeTransitionGrantRepository extends Context.Service<
  VoiceRealtimeTransitionGrantRepository,
  VoiceRealtimeTransitionGrantRepositoryShape
>()(
  "t3/persistence/Services/VoiceRealtimeTransitionGrants/VoiceRealtimeTransitionGrantRepository",
) {}

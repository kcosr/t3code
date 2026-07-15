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

export interface PersistedVoiceRealtimeTransitionReservation {
  readonly authSessionId: AuthSessionId;
  readonly sourceSessionId: VoiceSessionId;
  readonly sourceLeaseGeneration: number;
  readonly actionId: VoiceClientActionId;
  readonly actionSequence: number;
  readonly runtimeId: VoiceRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly sourceGeneration: number;
  readonly nextGeneration: number;
  readonly modeSessionId: VoiceModeSessionId;
  readonly target: VoiceThreadRuntimeTarget;
  readonly consumedAt: number | null;
}

export interface VoiceRealtimeTransitionReservationRepositoryShape {
  readonly claim: (
    record: Omit<PersistedVoiceRealtimeTransitionReservation, "consumedAt">,
    now: number,
  ) => Effect.Effect<
    | { readonly status: "claimed" }
    | { readonly status: "existing"; readonly record: PersistedVoiceRealtimeTransitionReservation }
    | { readonly status: "mismatch" },
    PersistenceSqlError
  >;
  readonly revoke: (
    sourceSessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    nextGeneration: number,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceRealtimeTransitionReservationRepository extends Context.Service<
  VoiceRealtimeTransitionReservationRepository,
  VoiceRealtimeTransitionReservationRepositoryShape
>()(
  "t3/persistence/Services/VoiceRealtimeTransitionReservations/VoiceRealtimeTransitionReservationRepository",
) {}

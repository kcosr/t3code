import type {
  AuthSessionId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceNativeRuntimeId,
  VoicePublicErrorReason,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeRealtimeStart {
  readonly operationKey: string;
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly runtimeGeneration: number;
  readonly modeSessionId: VoiceModeSessionId;
  readonly clientOperationId: string;
  readonly conversationId: VoiceConversationId;
  readonly sessionId: VoiceSessionId | null;
  readonly leaseGeneration: number | null;
  readonly failure: {
    readonly reason: VoicePublicErrorReason;
    readonly operation: string;
    readonly detail: string;
    readonly retryable: boolean;
  } | null;
  readonly claimExpiresAt: number;
  readonly expiresAt: number;
}

export interface VoiceNativeRealtimeStartRepositoryShape {
  readonly claim: (
    input: Omit<PersistedVoiceNativeRealtimeStart, "sessionId" | "leaseGeneration" | "failure"> & {
      readonly now: number;
    },
  ) => Effect.Effect<
    | { readonly status: "claimed" }
    | { readonly status: "existing"; readonly record: PersistedVoiceNativeRealtimeStart }
    | { readonly status: "mismatch" },
    PersistenceSqlError
  >;
  readonly bindSession: (
    operationKey: string,
    sessionId: VoiceSessionId,
    leaseGeneration: number,
    now: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly findBySession: (
    sessionId: VoiceSessionId,
    now: number,
  ) => Effect.Effect<PersistedVoiceNativeRealtimeStart | undefined, PersistenceSqlError>;
  /** Persist only authoritative no-session outcomes. Retryable failures can be reclaimed by claim. */
  readonly fail: (
    operationKey: string,
    failure: NonNullable<PersistedVoiceNativeRealtimeStart["failure"]>,
    now: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceNativeRuntimeId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly purgeExpired: (now: number) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceNativeRealtimeStartRepository extends Context.Service<
  VoiceNativeRealtimeStartRepository,
  VoiceNativeRealtimeStartRepositoryShape
>()("t3/persistence/Services/VoiceNativeRealtimeStarts/VoiceNativeRealtimeStartRepository") {}

import type {
  AuthSessionId,
  VoiceConversationId,
  VoiceNativeRuntimeId,
  VoicePublicErrorReason,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceNativeRealtimeStart {
  readonly operationKey: string;
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly runtimeGeneration: number;
  readonly clientOperationId: string;
  readonly conversationId: VoiceConversationId;
  readonly sessionId: VoiceSessionId | null;
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
    input: Omit<PersistedVoiceNativeRealtimeStart, "sessionId" | "failure"> & {
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
    now: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
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

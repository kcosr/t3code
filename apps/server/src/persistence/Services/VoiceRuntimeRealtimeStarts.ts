import type {
  AuthSessionId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoicePublicErrorReason,
  VoiceRuntimeInstanceId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface PersistedVoiceRuntimeRealtimeStart {
  readonly operationKey: string;
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly runtimeGeneration: number;
  readonly modeSessionId: VoiceModeSessionId;
  readonly clientOperationId: string;
  readonly conversationId: VoiceConversationId;
  readonly sessionId: VoiceSessionId | null;
  readonly leaseGeneration: number | null;
  readonly closeOnly: boolean;
  readonly failure: {
    readonly reason: VoicePublicErrorReason;
    readonly operation: string;
    readonly detail: string;
    readonly retryable: boolean;
  } | null;
  readonly claimExpiresAt: number;
  readonly expiresAt: number;
}

export interface VoiceRuntimeRealtimeStartRepositoryShape {
  readonly claim: (
    input: Omit<
      PersistedVoiceRuntimeRealtimeStart,
      "sessionId" | "leaseGeneration" | "closeOnly" | "failure"
    > & {
      readonly now: number;
    },
  ) => Effect.Effect<
    | { readonly status: "claimed" }
    | { readonly status: "existing"; readonly record: PersistedVoiceRuntimeRealtimeStart }
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
  ) => Effect.Effect<PersistedVoiceRuntimeRealtimeStart | undefined, PersistenceSqlError>;
  /** Persist only authoritative no-session outcomes. Retryable failures can be reclaimed by claim. */
  readonly fail: (
    operationKey: string,
    failure: NonNullable<PersistedVoiceRuntimeRealtimeStart["failure"]>,
    now: number,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly revokeAuthSession: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly purgeExpired: (now: number) => Effect.Effect<void, PersistenceSqlError>;
}

export class VoiceRuntimeRealtimeStartRepository extends Context.Service<
  VoiceRuntimeRealtimeStartRepository,
  VoiceRuntimeRealtimeStartRepositoryShape
>()("t3/persistence/Services/VoiceRuntimeRealtimeStarts/VoiceRuntimeRealtimeStartRepository") {}

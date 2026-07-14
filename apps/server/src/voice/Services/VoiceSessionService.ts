import type {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceConfirmationId,
  VoiceConfirmationInput,
  VoiceConfirmationResult,
  VoiceClientActionAckInput,
  VoiceClientActionAckResult,
  VoiceClientActionId,
  VoiceRuntimeHandoffAction,
  VoiceRuntimeHandoffActionAckInput,
  VoiceConversationClearContextResult,
  VoiceConversationId,
  VoiceSessionCloseResult,
  VoiceSessionCreateInput,
  VoiceSessionCreateResult,
  VoiceSessionEventsResult,
  VoiceSessionFocusInput,
  VoiceSessionFocusResult,
  VoiceSessionId,
  VoiceSessionState,
  VoiceWebRtcAnswer,
  VoiceWebRtcOffer,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VoiceError } from "../Errors.ts";

export interface VoiceSessionPrincipal {
  readonly sessionId: AuthSessionId;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly runtimeAuthority?: {
    readonly runtimeId: import("@t3tools/contracts").VoiceRuntimeId;
    readonly generation: number;
  };
}

export interface VoiceSessionServiceShape {
  readonly create: (
    principal: VoiceSessionPrincipal,
    input: VoiceSessionCreateInput,
  ) => Effect.Effect<VoiceSessionCreateResult, VoiceError>;
  readonly resumeCreate: (
    principal: VoiceSessionPrincipal,
    input: VoiceSessionCreateInput,
    expectedSessionId: VoiceSessionId,
  ) => Effect.Effect<VoiceSessionCreateResult, VoiceError>;
  readonly get: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
  ) => Effect.Effect<VoiceSessionState, VoiceError>;
  readonly heartbeat: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    leaseGeneration: number,
  ) => Effect.Effect<VoiceSessionState, VoiceError>;
  readonly updateFocus: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    input: VoiceSessionFocusInput,
  ) => Effect.Effect<VoiceSessionFocusResult, VoiceError>;
  readonly close: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    leaseGeneration: number,
  ) => Effect.Effect<VoiceSessionCloseResult, VoiceError>;
  readonly offer: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    offer: VoiceWebRtcOffer,
  ) => Effect.Effect<VoiceWebRtcAnswer, VoiceError>;
  readonly events: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    afterSequence: number,
    waitMilliseconds: number,
  ) => Effect.Effect<VoiceSessionEventsResult, VoiceError>;
  readonly revokeAuthSession: (ownerAuthSessionId: AuthSessionId) => Effect.Effect<void>;
  readonly revokeRuntimeAuthority: (
    ownerAuthSessionId: AuthSessionId,
    runtimeId: import("@t3tools/contracts").VoiceRuntimeId,
  ) => Effect.Effect<void>;
  readonly deleteConversation: (
    conversationId: VoiceConversationId,
  ) => Effect.Effect<boolean, VoiceError>;
  readonly clearConversationContext: (
    conversationId: VoiceConversationId,
    expectedEpoch: number,
    idempotencyKey: string,
  ) => Effect.Effect<VoiceConversationClearContextResult, VoiceError>;
  readonly confirm: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    confirmationId: VoiceConfirmationId,
    input: VoiceConfirmationInput,
  ) => Effect.Effect<VoiceConfirmationResult, VoiceError>;
  readonly acknowledgeClientAction: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    input: VoiceClientActionAckInput,
  ) => Effect.Effect<VoiceClientActionAckResult, VoiceError>;
  readonly listPendingHandoffActions: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    leaseGeneration: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<VoiceRuntimeHandoffAction>, VoiceError>;
  readonly acknowledgeRuntimeHandoffAction: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    leaseGeneration: number,
    actionId: VoiceClientActionId,
    input: VoiceRuntimeHandoffActionAckInput,
  ) => Effect.Effect<VoiceClientActionAckResult, VoiceError>;
  readonly reconcileActivatedRuntimeHandoff: (
    ownerAuthSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    leaseGeneration: number,
    actionId: VoiceClientActionId,
    target: {
      readonly projectId: import("@t3tools/contracts").ProjectId;
      readonly threadId: import("@t3tools/contracts").ThreadId;
    },
  ) => Effect.Effect<VoiceClientActionAckResult, VoiceError>;
}

export class VoiceSessionService extends Context.Service<
  VoiceSessionService,
  VoiceSessionServiceShape
>()("t3/voice/Services/VoiceSessionService") {}

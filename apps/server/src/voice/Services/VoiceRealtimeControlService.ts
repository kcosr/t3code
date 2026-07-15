import type {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceClientActionId,
  VoiceRuntimeRealtimeActionAckInput,
  VoiceRuntimeRealtimeActionAckResult,
  VoiceRuntimeRealtimeActionsQuery,
  VoiceRuntimeRealtimeActionsResult,
  VoiceRuntimeRealtimeCloseInput,
  VoiceRuntimeRealtimeCloseResult,
  VoiceRuntimeRealtimeFocusInput,
  VoiceRuntimeRealtimeFocusResult,
  VoiceRuntimeRealtimeHandoffExchangeInput,
  VoiceRuntimeRealtimeHandoffExchangeResult,
  VoiceRuntimeRealtimeHandoffCommitInput,
  VoiceRuntimeRealtimeHandoffCommitResult,
  VoiceRuntimeRealtimeHeartbeatInput,
  VoiceRuntimeRealtimeHeartbeatResult,
  VoiceRuntimeRealtimeSessionCreateInput,
  VoiceRuntimeRealtimeSessionCreateResult,
  VoiceRuntimeRealtimeWebRtcAnswer,
  VoiceRuntimeRealtimeWebRtcOfferInput,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VoiceError } from "../Errors.ts";

export interface VoiceRealtimeControlServiceShape {
  readonly create: (
    principal: {
      readonly sessionId: AuthSessionId;
      readonly scopes: ReadonlySet<AuthEnvironmentScope>;
    },
    input: VoiceRuntimeRealtimeSessionCreateInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeSessionCreateResult, VoiceError>;
  readonly offer: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeWebRtcOfferInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeWebRtcAnswer, VoiceError>;
  readonly heartbeat: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeHeartbeatInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeHeartbeatResult, VoiceError>;
  readonly actions: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    query: VoiceRuntimeRealtimeActionsQuery,
  ) => Effect.Effect<VoiceRuntimeRealtimeActionsResult, VoiceError>;
  readonly acknowledgeAction: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    input: VoiceRuntimeRealtimeActionAckInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeActionAckResult, VoiceError>;
  readonly updateFocus: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeFocusInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeFocusResult, VoiceError>;
  readonly exchangeHandoff: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    input: VoiceRuntimeRealtimeHandoffExchangeInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeHandoffExchangeResult, VoiceError>;
  readonly commitHandoff: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    input: VoiceRuntimeRealtimeHandoffCommitInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeHandoffCommitResult, VoiceError>;
  readonly close: (
    authSessionId: AuthSessionId,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeCloseInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeCloseResult, VoiceError>;
}

export class VoiceRealtimeControlService extends Context.Service<
  VoiceRealtimeControlService,
  VoiceRealtimeControlServiceShape
>()("t3/voice/Services/VoiceRealtimeControlService") {}

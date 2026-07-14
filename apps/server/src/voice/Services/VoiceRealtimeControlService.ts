import type {
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
    runtimeToken: string,
    input: VoiceRuntimeRealtimeSessionCreateInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeSessionCreateResult, VoiceError>;
  readonly offer: (
    controlToken: string,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeWebRtcOfferInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeWebRtcAnswer, VoiceError>;
  readonly heartbeat: (
    controlToken: string,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeHeartbeatInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeHeartbeatResult, VoiceError>;
  readonly actions: (
    controlToken: string,
    sessionId: VoiceSessionId,
    query: VoiceRuntimeRealtimeActionsQuery,
  ) => Effect.Effect<VoiceRuntimeRealtimeActionsResult, VoiceError>;
  readonly acknowledgeAction: (
    controlToken: string,
    sessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    input: VoiceRuntimeRealtimeActionAckInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeActionAckResult, VoiceError>;
  readonly updateFocus: (
    controlToken: string,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeFocusInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeFocusResult, VoiceError>;
  readonly exchangeHandoff: (
    controlToken: string,
    sessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    input: VoiceRuntimeRealtimeHandoffExchangeInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeHandoffExchangeResult, VoiceError>;
  readonly commitHandoff: (
    transitionToken: string,
    sessionId: VoiceSessionId,
    actionId: VoiceClientActionId,
    input: VoiceRuntimeRealtimeHandoffCommitInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeHandoffCommitResult, VoiceError>;
  readonly close: (
    controlToken: string,
    sessionId: VoiceSessionId,
    input: VoiceRuntimeRealtimeCloseInput,
  ) => Effect.Effect<VoiceRuntimeRealtimeCloseResult, VoiceError>;
}

export class VoiceRealtimeControlService extends Context.Service<
  VoiceRealtimeControlService,
  VoiceRealtimeControlServiceShape
>()("t3/voice/Services/VoiceRealtimeControlService") {}

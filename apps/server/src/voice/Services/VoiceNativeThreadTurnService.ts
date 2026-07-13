import type {
  AuthSessionId,
  VoiceNativeRuntimeId,
  VoiceNativeThreadTurnAudioResult,
  VoiceNativeThreadTurnCancelResult,
  VoiceNativeThreadTurnCreateInput,
  VoiceNativeThreadTurnCreateResult,
  VoiceNativeThreadTurnEventsQuery,
  VoiceNativeThreadTurnEventsResult,
  VoiceNativeThreadTurnOperationId,
  VoiceNativeThreadTurnSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { VoiceError } from "../Errors.ts";

export interface VoiceNativeThreadTurnServiceShape {
  readonly create: (
    runtimeToken: string,
    input: VoiceNativeThreadTurnCreateInput,
  ) => Effect.Effect<VoiceNativeThreadTurnCreateResult, VoiceError>;
  readonly uploadAudio: (
    operationToken: string,
    operationId: VoiceNativeThreadTurnOperationId,
    bytes: Uint8Array,
    language?: string,
  ) => Effect.Effect<VoiceNativeThreadTurnAudioResult, VoiceError>;
  readonly events: (
    operationToken: string,
    operationId: VoiceNativeThreadTurnOperationId,
    query: VoiceNativeThreadTurnEventsQuery,
  ) => Effect.Effect<VoiceNativeThreadTurnEventsResult, VoiceError>;
  readonly acknowledgeEvents: (
    operationToken: string,
    operationId: VoiceNativeThreadTurnOperationId,
    acknowledgedSequence: number,
  ) => Effect.Effect<VoiceNativeThreadTurnSnapshot, VoiceError>;
  readonly speech: (
    operationToken: string,
    operationId: VoiceNativeThreadTurnOperationId,
    segmentIndex: number,
  ) => Effect.Effect<Stream.Stream<Uint8Array, VoiceError>, VoiceError>;
  readonly cancel: (
    operationToken: string,
    operationId: VoiceNativeThreadTurnOperationId,
  ) => Effect.Effect<VoiceNativeThreadTurnCancelResult, VoiceError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceNativeRuntimeId,
  ) => Effect.Effect<void>;
}

export class VoiceNativeThreadTurnService extends Context.Service<
  VoiceNativeThreadTurnService,
  VoiceNativeThreadTurnServiceShape
>()("t3/voice/Services/VoiceNativeThreadTurnService") {}

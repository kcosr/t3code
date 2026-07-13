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
  readonly authorizeCreate: (runtimeToken: string) => Effect.Effect<void, VoiceError>;
  readonly authorizeOperation: (
    operationToken: string,
    operationId: VoiceNativeThreadTurnOperationId,
  ) => Effect.Effect<VoiceNativeThreadTurnSnapshot, VoiceError>;
  readonly beginAudioUpload: (
    operationToken: string,
    operationId: VoiceNativeThreadTurnOperationId,
  ) => Effect.Effect<
    {
      readonly maximumBytes: number;
      readonly bodyTimeoutSeconds: number;
      readonly upload: (
        bytes: Uint8Array,
        language?: string,
      ) => Effect.Effect<VoiceNativeThreadTurnAudioResult, VoiceError>;
      readonly release: Effect.Effect<void>;
    },
    VoiceError
  >;
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

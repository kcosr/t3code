import type {
  AuthSessionId,
  VoiceRuntimeId,
  VoiceRuntimeThreadDraftConsumeResult,
  VoiceRuntimeThreadTurnCancelResult,
  VoiceRuntimeThreadTurnEventsQuery,
  VoiceRuntimeThreadTurnEventsAckInput,
  VoiceRuntimeThreadTurnEventsResult,
  VoiceRuntimeThreadDraft,
  VoiceRuntimeThreadTurnAudioResult,
  VoiceRuntimeThreadTurnCreateInput,
  VoiceRuntimeThreadTurnCreateResult,
  VoiceRuntimeThreadTurnDispositionResult,
  VoiceRuntimeThreadTurnSnapshot,
  VoiceThreadTurnOperationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { VoiceError } from "../Errors.ts";

export interface VoiceThreadTurnServiceShape {
  readonly authorizeCreate: (runtimeToken: string) => Effect.Effect<void, VoiceError>;
  readonly authorizeOperation: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceRuntimeThreadTurnSnapshot, VoiceError>;
  readonly beginAudioUpload: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<
    {
      readonly maximumBytes: number;
      readonly bodyTimeoutSeconds: number;
      readonly upload: (
        bytes: Uint8Array,
        language?: string,
      ) => Effect.Effect<VoiceRuntimeThreadTurnAudioResult, VoiceError>;
      readonly release: Effect.Effect<void>;
    },
    VoiceError
  >;
  readonly create: (
    runtimeToken: string,
    input: VoiceRuntimeThreadTurnCreateInput,
  ) => Effect.Effect<VoiceRuntimeThreadTurnCreateResult, VoiceError>;
  readonly uploadAudio: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
    bytes: Uint8Array,
    language?: string,
  ) => Effect.Effect<VoiceRuntimeThreadTurnAudioResult, VoiceError>;
  readonly setDraftDisposition: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceRuntimeThreadTurnDispositionResult, VoiceError>;
  readonly events: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
    query: VoiceRuntimeThreadTurnEventsQuery,
  ) => Effect.Effect<VoiceRuntimeThreadTurnEventsResult, VoiceError>;
  readonly acknowledgeEvents: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
    input: VoiceRuntimeThreadTurnEventsAckInput,
  ) => Effect.Effect<VoiceRuntimeThreadTurnSnapshot, VoiceError>;
  readonly speech: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
    segmentIndex: number,
  ) => Effect.Effect<Stream.Stream<Uint8Array, VoiceError>, VoiceError>;
  readonly cancel: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceRuntimeThreadTurnCancelResult, VoiceError>;
  readonly readDraft: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceRuntimeThreadDraft, VoiceError>;
  readonly consumeDraft: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceRuntimeThreadDraftConsumeResult, VoiceError>;
  readonly detach: (
    operationToken: string,
    operationId: VoiceThreadTurnOperationId,
  ) => Effect.Effect<VoiceRuntimeThreadTurnSnapshot, VoiceError>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceRuntimeId,
  ) => Effect.Effect<void>;
}

export class VoiceThreadTurnService extends Context.Service<
  VoiceThreadTurnService,
  VoiceThreadTurnServiceShape
>()("t3/voice/Services/VoiceThreadTurnService") {}

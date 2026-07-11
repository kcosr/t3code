import type {
  VoiceCapability,
  VoiceRequestId,
  VoiceSessionId,
  VoiceTranscriptionStreamEvent,
  VoiceWebRtcAnswer,
  VoiceWebRtcOffer,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { VoiceError } from "../Errors.ts";

export interface TranscriptionRequest {
  readonly requestId: VoiceRequestId;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly language?: string;
  readonly vocabulary?: ReadonlyArray<string>;
}

export interface Transcriber {
  readonly transcribe: (
    request: TranscriptionRequest,
  ) => Stream.Stream<VoiceTranscriptionStreamEvent, VoiceError>;
}

export interface SpeechSynthesisRequest {
  readonly requestId: VoiceRequestId;
  readonly playbackId: string;
  readonly segmentIndex: number;
  readonly finalSegment: boolean;
  readonly text: string;
  readonly preset: string;
}

export interface SpeechSynthesizer {
  readonly synthesize: (request: SpeechSynthesisRequest) => Stream.Stream<Uint8Array, VoiceError>;
}

export interface RealtimeNegotiationRequest {
  readonly sessionId: VoiceSessionId;
  readonly leaseGeneration: number;
  readonly offer: VoiceWebRtcOffer;
  readonly instructions: string;
  readonly continuationContext: ReadonlyArray<RealtimeContextItem>;
}

export interface RealtimeContextItem {
  readonly role: "system" | "user" | "assistant";
  readonly text: string;
}

export interface RealtimeToolOutput {
  readonly providerFunctionCallId: string;
  readonly output: string;
}

export type RealtimeProviderEvent =
  | {
      readonly type: "activity";
      readonly activity: "listening" | "thinking" | "speaking" | "idle";
    }
  | {
      readonly type: "transcript";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly final: false;
    }
  | {
      readonly type: "transcript";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly final: true;
      readonly sourceId: string;
    }
  | {
      readonly type: "function-call";
      readonly providerFunctionCallId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: "error";
      readonly detail: string;
      readonly recoverable: boolean;
    }
  | { readonly type: "closed" };

export interface RealtimeProviderSession {
  readonly answer: VoiceWebRtcAnswer;
  readonly events: Stream.Stream<RealtimeProviderEvent, VoiceError>;
  readonly updateContext: (item: RealtimeContextItem) => Effect.Effect<void, VoiceError>;
  readonly submitToolOutput: (output: RealtimeToolOutput) => Effect.Effect<void, VoiceError>;
  readonly terminate: Effect.Effect<void, VoiceError>;
}

export interface RealtimeVoiceProvider {
  readonly negotiate: (
    request: RealtimeNegotiationRequest,
  ) => Effect.Effect<RealtimeProviderSession, VoiceError>;
}

export interface VoiceProviderAdapter {
  readonly id: string;
  readonly capabilities: ReadonlySet<VoiceCapability>;
  readonly transcriber?: Transcriber;
  readonly speechSynthesizer?: SpeechSynthesizer;
  readonly realtime?: RealtimeVoiceProvider;
}

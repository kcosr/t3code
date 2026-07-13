import type {
  VoiceConversationId,
  VoiceRequestId,
  VoiceSessionId,
  VoiceSessionPhase,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type VoiceMediaOperation = "transcription" | "speech";
type VoiceMediaOutcome = "cancelled" | "failure" | "success";

export type VoiceDiagnosticEvent =
  | {
      readonly type: "session-created";
      readonly sessionId: VoiceSessionId;
      readonly conversationId: VoiceConversationId;
      readonly leaseGeneration: number;
      readonly mode: "realtime-transcription" | "realtime-agent";
      readonly conversationType: "new" | "continue";
      readonly hasProjectFocus: boolean;
      readonly hasThreadFocus: boolean;
    }
  | {
      readonly type: "session-phase";
      readonly sessionId: VoiceSessionId;
      readonly leaseGeneration: number;
      readonly fromPhase: VoiceSessionPhase;
      readonly toPhase: VoiceSessionPhase;
    }
  | {
      readonly type: "session-connected";
      readonly sessionId: VoiceSessionId;
      readonly leaseGeneration: number;
      readonly offerDurationMs: number;
      readonly contextPreparationDurationMs: number;
      readonly providerNegotiationDurationMs: number;
      readonly replayItemCount: number;
    }
  | {
      readonly type: "provider-sideband-attached";
      readonly sessionId: VoiceSessionId;
      readonly leaseGeneration: number;
      readonly outcome: "success" | "failure";
      readonly durationMs: number;
    }
  | {
      readonly type: "session-ended";
      readonly sessionId: VoiceSessionId;
      readonly leaseGeneration: number;
      readonly outcome: "ended" | "error";
      readonly reason: VoiceSessionEndReason;
      readonly previousPhase: VoiceSessionPhase;
      readonly sessionDurationMs: number;
      readonly providerAttached: boolean;
      readonly providerActivityObserved: boolean;
    }
  | {
      readonly type: "media-completed";
      readonly operation: VoiceMediaOperation;
      readonly requestId: VoiceRequestId;
      readonly outcome: VoiceMediaOutcome;
      readonly durationMs: number;
      readonly outputBytes: number;
      readonly firstByteMs?: number;
      readonly inputBytes?: number;
      readonly inputDurationMs?: number;
    };

export type VoiceSessionEndReason =
  | "auth-revoked"
  | "authority-issuance-failed"
  | "client-request"
  | "context-persistence-failed"
  | "conversation-cleared"
  | "conversation-deleted"
  | "duration-limit"
  | "event-stream-failed"
  | "heartbeat-timeout"
  | "handed-off-to-thread-voice"
  | "stopped-by-voice-agent"
  | "negotiation-failed"
  | "native-runtime-revoked"
  | "provider-closed"
  | "provider-error"
  | "takeover"
  | "tool-failed";

export interface VoiceDiagnostic {
  readonly level: "info" | "warning";
  readonly message: string;
  readonly annotations: Readonly<Record<string, string | number | boolean>>;
}

const requestCorrelationSecret = NodeCrypto.randomBytes(32);
const requestCorrelationKey = (requestId: VoiceRequestId): string =>
  NodeCrypto.createHmac("sha256", requestCorrelationSecret).update(requestId).digest("base64url");

const expectedSessionEndReasons = new Set<VoiceSessionEndReason>([
  "auth-revoked",
  "client-request",
  "conversation-cleared",
  "conversation-deleted",
  "duration-limit",
  "handed-off-to-thread-voice",
  "stopped-by-voice-agent",
  "native-runtime-revoked",
  "takeover",
]);

export const voiceDiagnostic = (event: VoiceDiagnosticEvent): VoiceDiagnostic => {
  switch (event.type) {
    case "session-created":
      return {
        level: "info",
        message: "voice.session.created",
        annotations: {
          sessionId: event.sessionId,
          conversationId: event.conversationId,
          leaseGeneration: event.leaseGeneration,
          mode: event.mode,
          conversationType: event.conversationType,
          hasProjectFocus: event.hasProjectFocus,
          hasThreadFocus: event.hasThreadFocus,
        },
      };
    case "session-phase":
      return {
        level: "info",
        message: "voice.session.phase",
        annotations: {
          sessionId: event.sessionId,
          leaseGeneration: event.leaseGeneration,
          fromPhase: event.fromPhase,
          toPhase: event.toPhase,
        },
      };
    case "session-connected":
      return {
        level: "info",
        message: "voice.session.connected",
        annotations: {
          sessionId: event.sessionId,
          leaseGeneration: event.leaseGeneration,
          offerDurationMs: event.offerDurationMs,
          contextPreparationDurationMs: event.contextPreparationDurationMs,
          providerNegotiationDurationMs: event.providerNegotiationDurationMs,
          replayItemCount: event.replayItemCount,
        },
      };
    case "provider-sideband-attached":
      return {
        level: event.outcome === "failure" ? "warning" : "info",
        message: "voice.provider.sideband-attach",
        annotations: {
          sessionId: event.sessionId,
          leaseGeneration: event.leaseGeneration,
          outcome: event.outcome,
          durationMs: event.durationMs,
        },
      };
    case "session-ended":
      return {
        level:
          event.outcome === "error" || !expectedSessionEndReasons.has(event.reason)
            ? "warning"
            : "info",
        message: "voice.session.ended",
        annotations: {
          sessionId: event.sessionId,
          leaseGeneration: event.leaseGeneration,
          outcome: event.outcome,
          reason: event.reason,
          previousPhase: event.previousPhase,
          sessionDurationMs: event.sessionDurationMs,
          providerAttached: event.providerAttached,
          providerActivityObserved: event.providerActivityObserved,
        },
      };
    case "media-completed":
      return {
        level: event.outcome === "failure" ? "warning" : "info",
        message: "voice.media.completed",
        annotations: {
          operation: event.operation,
          requestKey: requestCorrelationKey(event.requestId),
          outcome: event.outcome,
          durationMs: event.durationMs,
          outputBytes: event.outputBytes,
          ...(event.firstByteMs === undefined ? {} : { firstByteMs: event.firstByteMs }),
          ...(event.inputBytes === undefined ? {} : { inputBytes: event.inputBytes }),
          ...(event.inputDurationMs === undefined
            ? {}
            : { inputDurationMs: event.inputDurationMs }),
        },
      };
  }
};

export const logVoiceDiagnostic = (event: VoiceDiagnosticEvent): Effect.Effect<void> => {
  const diagnostic = voiceDiagnostic(event);
  return diagnostic.level === "warning"
    ? Effect.logWarning(diagnostic.message, diagnostic.annotations)
    : Effect.logInfo(diagnostic.message, diagnostic.annotations);
};

const mediaOutcome = (exit: Exit.Exit<unknown, unknown>): VoiceMediaOutcome =>
  Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failure";

export const observeVoiceMediaStream = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  input: {
    readonly operation: VoiceMediaOperation;
    readonly requestId: VoiceRequestId;
    readonly inputBytes?: number;
    readonly inputDurationMs?: number;
  },
): Stream.Stream<Uint8Array, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const outputBytes = yield* Ref.make(0);
      const firstByteAt = yield* Ref.make<number | undefined>(undefined);
      const outcome = yield* Ref.make<VoiceMediaOutcome>("cancelled");
      const logCompletion = Effect.gen(function* () {
        const endedAt = yield* Clock.currentTimeMillis;
        const bytes = yield* Ref.get(outputBytes);
        const firstByte = yield* Ref.get(firstByteAt);
        yield* logVoiceDiagnostic({
          type: "media-completed",
          ...input,
          outcome: yield* Ref.get(outcome),
          durationMs: Math.max(0, endedAt - startedAt),
          outputBytes: bytes,
          ...(firstByte === undefined ? {} : { firstByteMs: Math.max(0, firstByte - startedAt) }),
        });
      }).pipe(Effect.uninterruptible);
      return stream.pipe(
        Stream.tap((chunk) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Ref.update(firstByteAt, (current) => current ?? now).pipe(
                Effect.andThen(Ref.update(outputBytes, (current) => current + chunk.byteLength)),
              ),
            ),
          ),
        ),
        Stream.onExit((exit) => Ref.set(outcome, mediaOutcome(exit))),
        Stream.ensuring(logCompletion),
      );
    }),
  );

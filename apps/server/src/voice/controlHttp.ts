import {
  AuthVoiceManageScope,
  AuthVoiceUseScope,
  EnvironmentResourceNotFoundError,
  EnvironmentVoiceOperationError,
  EnvironmentHttpApi,
  type VoiceCapabilityDescriptor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VoiceCredentialStore } from "./Services/VoiceCredentialStore.ts";
import { VoiceConversationService } from "./Services/VoiceConversationService.ts";
import { VoiceMediaTicketRegistry } from "./Services/VoiceMediaTicketRegistry.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";
import type { VoiceError } from "./Errors.ts";

const failVoiceOperation = (error: VoiceError) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentVoiceOperationError({
          code: "voice_operation_failed",
          reason: error.reason,
          message: error.detail,
          retryable: error.retryable,
          traceId,
        }),
      ),
    ),
  );

const failVoiceConversationOperation = (
  error: VoiceError,
): Effect.Effect<never, EnvironmentResourceNotFoundError | EnvironmentVoiceOperationError> =>
  error.reason === "conversation-not-found"
    ? failEnvironmentNotFound("voice_conversation_not_found")
    : failVoiceOperation(error);

const descriptor = (
  capability: VoiceCapabilityDescriptor["capability"],
  state: VoiceCapabilityDescriptor["state"],
  settings: { readonly maxUploadBytes: number },
): VoiceCapabilityDescriptor => {
  switch (capability) {
    case "transcription.request":
      return {
        capability,
        state,
        inputFormats: ["audio/mpeg", "audio/mp4", "audio/m4a", "audio/wav", "audio/webm"],
        outputFormats: [],
        maxInputBytes: settings.maxUploadBytes,
      };
    case "speech.streaming":
      return {
        capability,
        state,
        inputFormats: [],
        outputFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
      };
    case "transcription.realtime":
      return {
        capability,
        state: state === "ready" ? "unavailable" : state,
        inputFormats: [],
        outputFormats: [],
      };
    case "agent.realtime":
      return {
        capability,
        state,
        inputFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
        outputFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
        maxSessionDurationSeconds: 55 * 60,
      };
  }
};

export const voiceControlHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const settingsService = yield* ServerSettingsService;
    const conversations = yield* VoiceConversationService;
    const credentials = yield* VoiceCredentialStore;
    const tickets = yield* VoiceMediaTicketRegistry;
    const sessions = yield* VoiceSessionService;

    return handlers
      .handle(
        "createSession",
        Effect.fn("environment.voice.createSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .create(
              { sessionId: principal.sessionId, scopes: new Set(principal.scopes) },
              args.payload,
            )
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "getSession",
        Effect.fn("environment.voice.getSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .get(principal.sessionId, args.params.sessionId)
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "heartbeatSession",
        Effect.fn("environment.voice.heartbeatSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .heartbeat(principal.sessionId, args.params.sessionId, args.payload.leaseGeneration)
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "updateSessionFocus",
        Effect.fn("environment.voice.updateSessionFocus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .updateFocus(principal.sessionId, args.params.sessionId, args.payload)
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "closeSession",
        Effect.fn("environment.voice.closeSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .close(principal.sessionId, args.params.sessionId, args.payload.leaseGeneration)
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "offerSession",
        Effect.fn("environment.voice.offerSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .offer(principal.sessionId, args.params.sessionId, args.payload)
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "sessionEvents",
        Effect.fn("environment.voice.sessionEvents")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .events(
              principal.sessionId,
              args.params.sessionId,
              args.query.afterSequence ?? 0,
              args.query.waitMilliseconds ?? 0,
            )
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "decideVoiceConfirmation",
        Effect.fn("environment.voice.decideVoiceConfirmation")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .confirm(
              principal.sessionId,
              args.params.sessionId,
              args.params.confirmationId,
              args.payload,
            )
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "createConversation",
        Effect.fn("environment.voice.createConversation")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* conversations
            .create(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "listConversations",
        Effect.fn("environment.voice.listConversations")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* conversations
            .listDurable(args.query)
            .pipe(Effect.catch(failVoiceOperation));
        }),
      )
      .handle(
        "getConversation",
        Effect.fn("environment.voice.getConversation")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          const conversation = yield* conversations
            .get(args.params.conversationId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          if (Option.isNone(conversation)) {
            return yield* failEnvironmentNotFound("voice_conversation_not_found");
          }
          return conversation.value;
        }),
      )
      .handle(
        "updateConversation",
        Effect.fn("environment.voice.updateConversation")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* conversations
            .updateTitle(args.params.conversationId, args.payload)
            .pipe(Effect.catch(failVoiceConversationOperation));
        }),
      )
      .handle(
        "getConversationTranscript",
        Effect.fn("environment.voice.getConversationTranscript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* conversations
            .listTranscript(args.params.conversationId, args.query)
            .pipe(Effect.catch(failVoiceConversationOperation));
        }),
      )
      .handle(
        "deleteConversation",
        Effect.fn("environment.voice.deleteConversation")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          const deleted = yield* sessions
            .deleteConversation(args.params.conversationId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return { deleted };
        }),
      )
      .handle(
        "clearConversationContext",
        Effect.fn("environment.voice.clearConversationContext")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .clearConversationContext(
              args.params.conversationId,
              args.payload.expectedEpoch,
              args.payload.idempotencyKey,
            )
            .pipe(Effect.catch(failVoiceConversationOperation));
        }),
      )
      .handle(
        "capabilities",
        Effect.fn("environment.voice.capabilities")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          const settings = (yield* settingsService.getSettings.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          )).voice;
          const credential = yield* credentials.status.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          const state = !settings.enabled
            ? "disabled"
            : credential.configured
              ? "ready"
              : "not-configured";
          return {
            version: 1 as const,
            capabilities: [
              descriptor("transcription.request", state, settings),
              descriptor("speech.streaming", state, settings),
              descriptor("transcription.realtime", state, settings),
              descriptor("agent.realtime", state, settings),
            ],
            conversationRetention: ["ephemeral", "durable"] as const,
          };
        }),
      )
      .handle(
        "mediaTicket",
        Effect.fn("environment.voice.mediaTicket")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          const input = args.payload;
          const validBinding =
            (input.operation === "voice-heartbeat" && input.sessionId !== undefined) ||
            (input.operation !== "voice-heartbeat" && input.requestId !== undefined);
          if (!validBinding) {
            return yield* failEnvironmentInvalidRequest("invalid_voice_media_binding");
          }
          return yield* tickets.issue({
            authSessionId: principal.sessionId,
            operation: input.operation,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
            ...(input.sessionId === undefined ? {} : { voiceSessionId: input.sessionId }),
          });
        }),
      )
      .handle(
        "credentialStatus",
        Effect.fn("environment.voice.credentialStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          return yield* credentials.status.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "setCredential",
        Effect.fn("environment.voice.setCredential")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          return yield* credentials
            .setOpenAiApiKey(args.payload.apiKey)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "clearCredential",
        Effect.fn("environment.voice.clearCredential")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          yield* credentials.clearOpenAiApiKey.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          return { configured: false, updatedAt: null };
        }),
      );
  }),
);

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthVoiceManageScope,
  AuthVoiceUseScope,
  EnvironmentResourceNotFoundError,
  EnvironmentVoiceOperationError,
  EnvironmentHttpApi,
  type VoiceCapabilityDescriptor,
  type VoiceCapabilityState,
  type VoiceNonRealtimeProviderId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  appendCredentialResponseHeaders,
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  failEnvironmentOperationForbidden,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { isSessionCredentialInternalError } from "../auth/SessionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { checkOpenAiSpeechServerHealth } from "./Providers/OpenAiSpeechServer/OpenAiSpeechServerVoiceProvider.ts";
import { VoiceCredentialStore } from "./Services/VoiceCredentialStore.ts";
import { VoiceConversationService } from "./Services/VoiceConversationService.ts";
import { VoiceMediaTicketRegistry } from "./Services/VoiceMediaTicketRegistry.ts";
import { NativeVoiceSessionIssuer } from "./Services/NativeVoiceSessionIssuer.ts";
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
  settings: {
    readonly maxUploadBytes: number;
    readonly maxInputDurationSeconds: number;
    readonly maxSpeechTextBytes: number;
  },
): VoiceCapabilityDescriptor => {
  switch (capability) {
    case "transcription.request":
      return {
        capability,
        state,
        inputFormats: ["audio/mp4"],
        outputFormats: [],
        maxInputBytes: settings.maxUploadBytes,
        maxInputDurationSeconds: settings.maxInputDurationSeconds,
      };
    case "speech.streaming":
      return {
        capability,
        state,
        inputFormats: [],
        outputFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
        maxInputBytes: settings.maxSpeechTextBytes,
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

export const __testing = { descriptor };

export const voiceControlHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const settingsService = yield* ServerSettingsService;
    const conversations = yield* VoiceConversationService;
    const credentials = yield* VoiceCredentialStore;
    const tickets = yield* VoiceMediaTicketRegistry;
    const nativeSessions = yield* NativeVoiceSessionIssuer;
    const sessions = yield* VoiceSessionService;

    return handlers
      .handle(
        "createNativeSession",
        Effect.fn("environment.voice.createNativeSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceUseScope);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* appendCredentialResponseHeaders;
          return yield* nativeSessions.issue(principal).pipe(
            Effect.catchIf(isSessionCredentialInternalError, (cause) =>
              failEnvironmentInternal("native_voice_session_issuance_failed", cause),
            ),
            Effect.catchTags({
              NativeVoiceParentSessionInactiveError: () =>
                failEnvironmentOperationForbidden("native_voice_parent_session_inactive"),
              NativeVoiceSessionReissuanceNotAllowedError: () =>
                failEnvironmentOperationForbidden("native_voice_session_reissuance_not_allowed"),
              NativeVoiceSessionScopeRequiredError: (error) =>
                failEnvironmentScopeRequired(error.requiredScope),
            }),
          );
        }),
      )
      .handle(
        "createSession",
        Effect.fn("environment.voice.createSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .create(
              {
                sessionId: principal.sessionId,
                scopes: new Set(principal.scopes),
              },
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
        "acknowledgeVoiceClientAction",
        Effect.fn("environment.voice.acknowledgeVoiceClientAction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          return yield* sessions
            .acknowledgeClientAction(
              principal.sessionId,
              args.params.sessionId,
              args.params.actionId,
              args.payload,
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
          if (!settings.enabled) {
            const disabled = "disabled" as const;
            return {
              version: 1 as const,
              capabilities: [
                descriptor("transcription.request", disabled, settings),
                descriptor("speech.streaming", disabled, settings),
                descriptor("transcription.realtime", disabled, settings),
                descriptor("agent.realtime", disabled, settings),
              ],
              conversationRetention: ["ephemeral", "durable"] as const,
            };
          }

          const openAiCredential = yield* credentials
            .status("openai")
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          const openAiState: VoiceCapabilityState = openAiCredential.configured
            ? "ready"
            : "not-configured";

          const resolveNonRealtimeState = (
            selected: VoiceNonRealtimeProviderId,
            speechServerState: VoiceCapabilityState,
          ): VoiceCapabilityState => (selected === "openai" ? openAiState : speechServerState);

          const speechServerSelected =
            settings.providers.transcription === "openai-speech-server" ||
            settings.providers.speech === "openai-speech-server";
          const speechServerState: VoiceCapabilityState = speechServerSelected
            ? yield* checkOpenAiSpeechServerHealth
            : "not-configured";

          return {
            version: 1 as const,
            capabilities: [
              descriptor(
                "transcription.request",
                resolveNonRealtimeState(settings.providers.transcription, speechServerState),
                settings,
              ),
              descriptor(
                "speech.streaming",
                resolveNonRealtimeState(settings.providers.speech, speechServerState),
                settings,
              ),
              descriptor("transcription.realtime", openAiState, settings),
              descriptor("agent.realtime", openAiState, settings),
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
          switch (input.operation) {
            case "transcription-upload":
            case "speech-stream":
              return yield* tickets
                .issue({
                  authSessionId: principal.sessionId,
                  operation: input.operation,
                  requestId: input.requestId,
                })
                .pipe(
                  Effect.catchTag("VoiceMediaTicketLimitError", () =>
                    failEnvironmentInvalidRequest("voice_media_ticket_limit"),
                  ),
                );
          }
        }),
      )
      .handle(
        "credentialStatus",
        Effect.fn("environment.voice.credentialStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          return yield* credentials.listStatus.pipe(
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
            .set(args.payload.providerId, args.payload.token)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "clearCredential",
        Effect.fn("environment.voice.clearCredential")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthVoiceManageScope);
          return yield* credentials
            .clear(args.params.providerId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      );
  }),
);

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthVoiceManageScope,
  AuthVoiceUseScope,
  EnvironmentResourceNotFoundError,
  EnvironmentVoiceRuntimeProtocolIncompatibleError,
  EnvironmentVoiceOperationError,
  EnvironmentHttpApi,
  type VoiceCapabilityDescriptor,
  VoiceRuntimeId,
  VOICE_RUNTIME_PROTOCOL_MAJOR,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
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
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { VoiceCredentialStore } from "./Services/VoiceCredentialStore.ts";
import { VoiceConversationService } from "./Services/VoiceConversationService.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";
import { VoiceRuntimeAuthorityRepository } from "../persistence/Services/VoiceRuntimeAuthorities.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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

const requireVoiceRuntimeProtocol = (value: string | undefined) =>
  value === String(VOICE_RUNTIME_PROTOCOL_MAJOR)
    ? Effect.void
    : currentEnvironmentTraceId.pipe(
        Effect.flatMap((traceId) =>
          Effect.fail(
            new EnvironmentVoiceRuntimeProtocolIncompatibleError({
              code: "voice_runtime_protocol_incompatible",
              requiredMajor: VOICE_RUNTIME_PROTOCOL_MAJOR,
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
    const sessions = yield* VoiceSessionService;
    const runtimeAuthorities = yield* VoiceRuntimeAuthorityRepository;
    const projectionQuery = yield* ProjectionSnapshotQuery;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;

    return handlers
      .handle(
        "configureVoiceRuntimeAuthority",
        Effect.fn("environment.voice.configureRuntimeAuthority")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireVoiceRuntimeProtocol(args.headers["x-t3-voice-runtime-protocol-major"]);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const target = args.payload.target;
          if (target.environmentId !== environmentId) {
            return yield* failEnvironmentInvalidRequest("native_voice_target_invalid");
          }
          if (target.mode === "realtime") {
            const conversation = yield* conversations
              .get(target.conversationId)
              .pipe(Effect.catch(failVoiceOperation));
            if (Option.isNone(conversation) || conversation.value.retention !== "durable") {
              return yield* failEnvironmentInvalidRequest("native_voice_target_invalid");
            }
          }
          if (target.mode === "thread") {
            const thread = yield* projectionQuery
              .getThreadShellById(target.threadId)
              .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
            if (Option.isNone(thread) || thread.value.projectId !== target.projectId) {
              return yield* failEnvironmentInvalidRequest("native_voice_target_invalid");
            }
          }
          const configured = yield* runtimeAuthorities
            .configure(
              {
                authSessionId: principal.sessionId,
                runtimeId: VoiceRuntimeId.make(args.params.runtimeId),
                generation: args.payload.generation,
                expectedCurrentGeneration: args.payload.expectedCurrentGeneration,
                target,
              },
              yield* Clock.currentTimeMillis,
            )
            .pipe(
              Effect.tap((result) =>
                result.status === "configured"
                  ? sessions.revokeRuntimeAuthority(
                      principal.sessionId,
                      VoiceRuntimeId.make(args.params.runtimeId),
                    )
                  : Effect.void,
              ),
              Effect.uninterruptible,
              Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
            );
          if (configured.status === "stale") {
            return yield* failVoiceOperation({
              reason: "authorization-revoked",
              detail: "Voice runtime authority generation is stale",
              retryable: false,
            } as VoiceError);
          }
          return {
            runtimeId: configured.authority.runtimeId,
            generation: configured.authority.generation,
            target: configured.authority.target,
          };
        }),
      )
      .handle(
        "clearVoiceRuntimeAuthority",
        Effect.fn("environment.voice.clearRuntimeAuthority")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireVoiceRuntimeProtocol(args.headers["x-t3-voice-runtime-protocol-major"]);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          const runtimeId = VoiceRuntimeId.make(args.params.runtimeId);
          const cleared = yield* Effect.gen(function* () {
            const result = yield* runtimeAuthorities.clearRuntime(principal.sessionId, runtimeId);
            yield* sessions.revokeRuntimeAuthority(principal.sessionId, runtimeId);
            return result;
          }).pipe(
            Effect.uninterruptible,
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
          return { runtimeId, cleared };
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

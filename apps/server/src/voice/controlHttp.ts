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
  type VoiceRuntimeGrant,
  type VoiceRuntimeGrantOperation,
  VoiceRuntimeId,
  type VoiceRuntimeTarget,
  VOICE_RUNTIME_PROTOCOL_MAJOR,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
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
import { VoiceMediaTicketRegistry } from "./Services/VoiceMediaTicketRegistry.ts";
import { VoiceSessionService } from "./Services/VoiceSessionService.ts";
import { VoiceRuntimeGrantRegistry } from "./Services/VoiceRuntimeGrantRegistry.ts";
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

const runtimeAuthorityExpiresAt = (
  now: DateTime.DateTime,
  principalExpiresAt?: DateTime.DateTime,
) =>
  DateTime.makeUnsafe(
    Math.min(
      DateTime.toEpochMillis(DateTime.addDuration(now, "30 days")),
      principalExpiresAt?.epochMilliseconds ?? Number.POSITIVE_INFINITY,
    ),
  );

const runtimeGrantResponse = (input: {
  readonly token: string;
  readonly runtimeId: VoiceRuntimeId;
  readonly generation: number;
  readonly provisioningOperationId: VoiceRuntimeGrant["provisioningOperationId"];
  readonly target: VoiceRuntimeTarget;
  readonly targetDigest: VoiceRuntimeGrant["targetDigest"];
  readonly operation: VoiceRuntimeGrantOperation;
  readonly readinessEnabled: boolean;
  readonly refreshRotationCounter: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}): VoiceRuntimeGrant | undefined => {
  const base = {
    token: input.token,
    runtimeId: input.runtimeId,
    generation: input.generation,
    provisioningOperationId: input.provisioningOperationId,
    targetDigest: input.targetDigest,
    readinessEnabled: input.readinessEnabled,
    refreshRotationCounter: input.refreshRotationCounter,
    issuedAt: DateTime.formatIso(DateTime.makeUnsafe(input.issuedAt)),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(input.expiresAt)),
  };
  if (input.target.mode === "realtime" && input.operation === "realtime-start") {
    return { ...base, target: input.target, operation: input.operation };
  }
  if (input.target.mode === "thread" && input.operation === "thread-turn-start") {
    return { ...base, target: input.target, operation: input.operation };
  }
  return undefined;
};

export const __testing = { descriptor, runtimeAuthorityExpiresAt };

export const voiceControlHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const settingsService = yield* ServerSettingsService;
    const conversations = yield* VoiceConversationService;
    const credentials = yield* VoiceCredentialStore;
    const tickets = yield* VoiceMediaTicketRegistry;
    const sessions = yield* VoiceSessionService;
    const runtimeAuthorityGrants = yield* VoiceRuntimeGrantRegistry;
    const projectionQuery = yield* ProjectionSnapshotQuery;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;

    return handlers
      .handle(
        "provisionVoiceRuntimeGrant",
        Effect.fn("environment.voice.provisionRuntimeGrant")(function* (args) {
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
          const now = yield* DateTime.now;
          const expiresAt = runtimeAuthorityExpiresAt(now, principal.expiresAt);
          const grant = yield* Effect.gen(function* () {
            const issued = yield* runtimeAuthorityGrants.issue({
              authSessionId: principal.sessionId,
              runtimeId: VoiceRuntimeId.make(args.params.runtimeId),
              generation: args.payload.generation,
              expectedCurrentGeneration: args.payload.expectedCurrentGeneration,
              provisioningOperationId: args.payload.provisioningOperationId,
              grantedScopes: new Set(principal.scopes),
              target,
              targetDigest: args.payload.targetDigest,
              operation: args.payload.operation,
              readinessEnabled: args.payload.readinessEnabled,
              refreshCredentialHash: args.payload.refreshCredentialHash,
              expiresAt: DateTime.toEpochMillis(expiresAt),
            });
            if (!issued.replayed) {
              yield* sessions.revokeRuntimeAuthority(
                principal.sessionId,
                VoiceRuntimeId.make(args.params.runtimeId),
              );
            }
            return issued;
          }).pipe(Effect.uninterruptible, Effect.catch(failVoiceOperation));
          const response = runtimeGrantResponse({
            token: grant.token,
            runtimeId: VoiceRuntimeId.make(args.params.runtimeId),
            generation: args.payload.generation,
            provisioningOperationId: args.payload.provisioningOperationId,
            target: args.payload.target,
            targetDigest: args.payload.targetDigest,
            operation: args.payload.operation,
            readinessEnabled: args.payload.readinessEnabled,
            refreshRotationCounter: grant.refreshRotationCounter,
            issuedAt: grant.issuedAt,
            expiresAt: grant.expiresAt,
          });
          return response ?? (yield* failEnvironmentInvalidRequest("native_voice_target_invalid"));
        }),
      )
      .handle(
        "revokeVoiceRuntimeGrant",
        Effect.fn("environment.voice.revokeRuntimeGrant")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireVoiceRuntimeProtocol(args.headers["x-t3-voice-runtime-protocol-major"]);
          const principal = yield* requireEnvironmentScope(AuthVoiceUseScope);
          const revoked = yield* Effect.gen(function* () {
            const result = yield* runtimeAuthorityGrants.revokeRuntime(
              principal.sessionId,
              VoiceRuntimeId.make(args.params.runtimeId),
            );
            yield* sessions.revokeRuntimeAuthority(
              principal.sessionId,
              VoiceRuntimeId.make(args.params.runtimeId),
            );
            return result;
          }).pipe(Effect.uninterruptible);
          return { runtimeId: args.params.runtimeId, revoked };
        }),
      )
      .handle(
        "refreshVoiceRuntimeGrant",
        Effect.fn("environment.voice.refreshRuntimeGrant")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireVoiceRuntimeProtocol(args.headers["x-t3-voice-runtime-protocol-major"]);
          const now = yield* DateTime.now;
          const refreshed = yield* runtimeAuthorityGrants
            .refresh(args.headers["x-t3-voice-refresh"], {
              runtimeId: VoiceRuntimeId.make(args.params.runtimeId),
              ...args.payload,
              expiresAt: DateTime.toEpochMillis(DateTime.addDuration(now, "30 days")),
            })
            .pipe(Effect.catch(failVoiceOperation));
          const response = runtimeGrantResponse({
            token: refreshed.token,
            runtimeId: VoiceRuntimeId.make(args.params.runtimeId),
            generation: refreshed.generation,
            provisioningOperationId: refreshed.provisioningOperationId,
            target: refreshed.target,
            targetDigest: refreshed.targetDigest,
            operation: refreshed.operation,
            readinessEnabled: refreshed.readinessEnabled,
            refreshRotationCounter: refreshed.refreshRotationCounter,
            issuedAt: refreshed.issuedAt,
            expiresAt: refreshed.expiresAt,
          });
          return response ?? (yield* failEnvironmentInvalidRequest("native_voice_target_invalid"));
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

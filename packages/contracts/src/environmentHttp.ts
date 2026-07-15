import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import {
  AuthSessionId,
  TrimmedNonEmptyString,
  ThreadId,
  VoiceConversationId,
  VoiceConfirmationId,
  VoiceClientActionId,
  VoiceRuntimeId,
  VoiceSessionId,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
} from "./orchestration.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";
import {
  VoiceCapabilities,
  VoiceConfirmationInput,
  VoiceConfirmationResult,
  VoiceClientActionAckInput,
  VoiceClientActionAckResult,
  VoiceCredentialSetInput,
  VoiceCredentialStatus,
  VoiceConversationClearContextResult,
  VoiceConversationClearContextInput,
  VoiceConversationCreateInput,
  VoiceConversationDeleteResult,
  VoiceConversationListPage,
  VoiceConversationListQuery,
  VoiceConversationSummary,
  VoiceConversationTranscriptPage,
  VoiceConversationTranscriptQuery,
  VoiceConversationUpdateInput,
  VoicePublicErrorReason,
  VoiceSessionCloseResult,
  VoiceSessionCreateInput,
  VoiceSessionFocusInput,
  VoiceSessionFocusResult,
  VoiceSessionCreateResult,
  VoiceSessionEventsQuery,
  VoiceSessionEventsResult,
  VoiceSessionLeaseInput,
  VoiceSessionState,
  VoiceWebRtcAnswer,
  VoiceWebRtcOffer,
} from "./voice.ts";
import {
  VOICE_RUNTIME_PROTOCOL_MAJOR,
  VoiceRuntimeAuthority,
  VoiceRuntimeAuthorityClearResult,
  VoiceRuntimeAuthorityConfigureInput,
} from "./voiceRuntime.ts";
import {
  HistoryReadInput,
  HistoryReadResult,
  HistoryRequestInvalidReason,
  HistorySearchInput,
  HistorySearchPage,
} from "./history.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const VoiceRuntimeAuthenticatedHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
  "x-t3-voice-runtime-protocol-major": Schema.optionalKey(Schema.String),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
  "native_voice_target_invalid",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_dispatch_failed",
  "history_search_failed",
  "history_read_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedErrorClass<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, {
      status: 400,
    });
  }
}

export class EnvironmentVoiceOperationError extends Schema.TaggedErrorClass<EnvironmentVoiceOperationError>()(
  "EnvironmentVoiceOperationError",
  {
    code: Schema.Literal("voice_operation_failed"),
    reason: VoicePublicErrorReason,
    message: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentVoiceOperationError)(this, {
      status: 409,
    });
  }
}

export class EnvironmentVoiceRuntimeProtocolIncompatibleError extends Schema.TaggedErrorClass<EnvironmentVoiceRuntimeProtocolIncompatibleError>()(
  "EnvironmentVoiceRuntimeProtocolIncompatibleError",
  {
    code: Schema.Literal("voice_runtime_protocol_incompatible"),
    requiredMajor: Schema.Literal(VOICE_RUNTIME_PROTOCOL_MAJOR),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 426 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentVoiceRuntimeProtocolIncompatibleError)(this, {
      status: 426,
    });
  }
}

export class EnvironmentHistoryRequestError extends Schema.TaggedErrorClass<EnvironmentHistoryRequestError>()(
  "EnvironmentHistoryRequestError",
  {
    code: Schema.Literal("history_request_invalid"),
    reason: HistoryRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHistoryRequestError)(this, {
      status: 400,
    });
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedErrorClass<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, {
      status: 401,
    });
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedErrorClass<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, {
      status: 403,
    });
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedErrorClass<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentInternalError extends Schema.TaggedErrorClass<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, {
      status: 500,
    });
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals([
  "thread_not_found",
  "voice_conversation_not_found",
  "history_item_not_found",
]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedErrorClass<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentHistoryRequestError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedErrorClass<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, {
      status: 400,
    });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedErrorClass<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedErrorClass<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, {
      status: 403,
    });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedErrorClass<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedErrorClass<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, {
      status: 409,
    });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedErrorClass<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationDispatchErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

export class EnvironmentHistoryPrivacyBoundary extends HttpApiMiddleware.Service<EnvironmentHistoryPrivacyBoundary>()(
  "EnvironmentHistoryPrivacyBoundary",
  {
    error: EnvironmentHistoryRequestError,
  },
) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  // A managed Cloudflare tunnel is provisioned for this link. False for a
  // publish-only link (activity publishing without a relay-managed tunnel), so
  // clients can present the two capabilities as independent settings.
  // Optional so newer clients tolerate older environment servers.
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

export class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

export class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalBearerHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OptionalBearerHeaders,
      success: OrchestrationShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OptionalBearerHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalBearerHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentOrchestrationDispatchErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentHistoryOperationErrors = [
  EnvironmentHistoryRequestError,
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHistoryHttpApi extends HttpApiGroup.make("history")
  .add(
    HttpApiEndpoint.post("search", "/api/history/search", {
      headers: OptionalBearerHeaders,
      payload: HistorySearchInput,
      success: HistorySearchPage,
      error: EnvironmentHistoryOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("readHistory", "/api/history/read", {
      headers: OptionalBearerHeaders,
      payload: HistoryReadInput,
      success: HistoryReadResult,
      error: EnvironmentHistoryOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .middleware(EnvironmentHistoryPrivacyBoundary) {}

export class EnvironmentVoiceHttpApi extends HttpApiGroup.make("voice")
  .add(
    HttpApiEndpoint.put(
      "configureVoiceRuntimeAuthority",
      "/api/voice/runtime/runtimes/:runtimeId/authority",
      {
        headers: VoiceRuntimeAuthenticatedHeaders,
        params: Schema.Struct({ runtimeId: VoiceRuntimeId }),
        payload: VoiceRuntimeAuthorityConfigureInput,
        success: VoiceRuntimeAuthority,
        error: [
          EnvironmentVoiceRuntimeProtocolIncompatibleError,
          EnvironmentRequestInvalidError,
          ...EnvironmentScopedOperationErrors,
          EnvironmentVoiceOperationError,
        ],
      },
    ).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.delete(
      "clearVoiceRuntimeAuthority",
      "/api/voice/runtime/runtimes/:runtimeId/authority",
      {
        headers: VoiceRuntimeAuthenticatedHeaders,
        params: Schema.Struct({ runtimeId: VoiceRuntimeId }),
        success: VoiceRuntimeAuthorityClearResult,
        error: [
          EnvironmentVoiceRuntimeProtocolIncompatibleError,
          ...EnvironmentScopedOperationErrors,
        ],
      },
    ).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createSession", "/api/voice/sessions", {
      headers: OptionalBearerHeaders,
      payload: VoiceSessionCreateInput,
      success: VoiceSessionCreateResult,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("getSession", "/api/voice/sessions/:sessionId", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: VoiceSessionId }),
      success: VoiceSessionState,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("heartbeatSession", "/api/voice/sessions/:sessionId/heartbeat", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: VoiceSessionId }),
      payload: VoiceSessionLeaseInput,
      success: VoiceSessionState,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("updateSessionFocus", "/api/voice/sessions/:sessionId/focus", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: VoiceSessionId }),
      payload: VoiceSessionFocusInput,
      success: VoiceSessionFocusResult,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.delete("closeSession", "/api/voice/sessions/:sessionId", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: VoiceSessionId }),
      payload: VoiceSessionLeaseInput,
      success: VoiceSessionCloseResult,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("offerSession", "/api/voice/sessions/:sessionId/webrtc-offer", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: VoiceSessionId }),
      payload: VoiceWebRtcOffer,
      success: VoiceWebRtcAnswer,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("sessionEvents", "/api/voice/sessions/:sessionId/events", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: VoiceSessionId }),
      query: VoiceSessionEventsQuery,
      success: VoiceSessionEventsResult,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post(
      "acknowledgeVoiceClientAction",
      "/api/voice/sessions/:sessionId/client-actions/:actionId/ack",
      {
        headers: OptionalBearerHeaders,
        params: Schema.Struct({
          sessionId: VoiceSessionId,
          actionId: VoiceClientActionId,
        }),
        payload: VoiceClientActionAckInput,
        success: VoiceClientActionAckResult,
        error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
      },
    ).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post(
      "decideVoiceConfirmation",
      "/api/voice/sessions/:sessionId/confirmations/:confirmationId",
      {
        headers: OptionalBearerHeaders,
        params: Schema.Struct({
          sessionId: VoiceSessionId,
          confirmationId: VoiceConfirmationId,
        }),
        payload: VoiceConfirmationInput,
        success: VoiceConfirmationResult,
        error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
      },
    ).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createConversation", "/api/voice/conversations", {
      headers: OptionalBearerHeaders,
      payload: VoiceConversationCreateInput,
      success: VoiceConversationSummary,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("listConversations", "/api/voice/conversations", {
      headers: OptionalBearerHeaders,
      query: VoiceConversationListQuery,
      success: VoiceConversationListPage,
      error: [...EnvironmentScopedOperationErrors, EnvironmentVoiceOperationError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("getConversation", "/api/voice/conversations/:conversationId", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ conversationId: VoiceConversationId }),
      success: VoiceConversationSummary,
      error: [
        EnvironmentScopeRequiredError,
        EnvironmentResourceNotFoundError,
        EnvironmentInternalError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.patch("updateConversation", "/api/voice/conversations/:conversationId", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ conversationId: VoiceConversationId }),
      payload: VoiceConversationUpdateInput,
      success: VoiceConversationSummary,
      error: [
        EnvironmentScopeRequiredError,
        EnvironmentResourceNotFoundError,
        EnvironmentVoiceOperationError,
        EnvironmentInternalError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get(
      "getConversationTranscript",
      "/api/voice/conversations/:conversationId/transcript",
      {
        headers: OptionalBearerHeaders,
        params: Schema.Struct({ conversationId: VoiceConversationId }),
        query: VoiceConversationTranscriptQuery,
        success: VoiceConversationTranscriptPage,
        error: [
          ...EnvironmentScopedOperationErrors,
          EnvironmentResourceNotFoundError,
          EnvironmentVoiceOperationError,
        ],
      },
    ).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.delete("deleteConversation", "/api/voice/conversations/:conversationId", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ conversationId: VoiceConversationId }),
      success: VoiceConversationDeleteResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post(
      "clearConversationContext",
      "/api/voice/conversations/:conversationId/clear-context",
      {
        headers: OptionalBearerHeaders,
        params: Schema.Struct({ conversationId: VoiceConversationId }),
        payload: VoiceConversationClearContextInput,
        success: VoiceConversationClearContextResult,
        error: [
          EnvironmentScopeRequiredError,
          EnvironmentResourceNotFoundError,
          EnvironmentVoiceOperationError,
          EnvironmentInternalError,
        ],
      },
    ).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("capabilities", "/api/voice/capabilities", {
      headers: OptionalBearerHeaders,
      success: VoiceCapabilities,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("credentialStatus", "/api/voice/credentials", {
      headers: OptionalBearerHeaders,
      success: VoiceCredentialStatus,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.put("setCredential", "/api/voice/credentials", {
      headers: OptionalBearerHeaders,
      payload: VoiceCredentialSetInput,
      success: VoiceCredentialStatus,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.delete("clearCredential", "/api/voice/credentials", {
      headers: OptionalBearerHeaders,
      success: VoiceCredentialStatus,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/t3-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintCredential", "/api/connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("t3MintCredential", "/api/t3-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentHistoryHttpApi)
  .add(EnvironmentVoiceHttpApi)
  .add(EnvironmentConnectHttpApi) {}

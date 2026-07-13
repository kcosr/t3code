import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  VoiceConfirmationId,
  VoiceClientActionId,
  VoiceConversationEntryId,
  VoiceConversationId,
  VoiceMediaTicketId,
  VoicePlaybackId,
  VoiceRequestId,
  VoiceSessionId,
  VoiceToolCallId,
} from "./baseSchemas.ts";

export const VoiceCapability = Schema.Literals([
  "transcription.request",
  "transcription.realtime",
  "speech.streaming",
  "agent.realtime",
]);
export type VoiceCapability = typeof VoiceCapability.Type;

export const VoiceCapabilityState = Schema.Literals([
  "ready",
  "disabled",
  "not-configured",
  "unavailable",
]);
export type VoiceCapabilityState = typeof VoiceCapabilityState.Type;

export const VoiceAudioFormat = Schema.Literals([
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/pcm;rate=24000;encoding=s16le;channels=1",
]);
export type VoiceAudioFormat = typeof VoiceAudioFormat.Type;

export const VoiceTranscriptionUploadFormat = Schema.Literal("audio/mp4");
export type VoiceTranscriptionUploadFormat = typeof VoiceTranscriptionUploadFormat.Type;

export const VoiceCapabilityDescriptor = Schema.Struct({
  capability: VoiceCapability,
  state: VoiceCapabilityState,
  inputFormats: Schema.Array(VoiceAudioFormat),
  outputFormats: Schema.Array(VoiceAudioFormat),
  maxInputBytes: Schema.optionalKey(PositiveInt),
  maxInputDurationSeconds: Schema.optionalKey(PositiveInt),
  maxSessionDurationSeconds: Schema.optionalKey(PositiveInt),
});
export type VoiceCapabilityDescriptor = typeof VoiceCapabilityDescriptor.Type;

export const VoiceCapabilities = Schema.Struct({
  version: Schema.Literal(1),
  capabilities: Schema.Array(VoiceCapabilityDescriptor),
  conversationRetention: Schema.Array(Schema.Literals(["ephemeral", "durable"])),
});
export type VoiceCapabilities = typeof VoiceCapabilities.Type;

export const VoiceCredentialStatus = Schema.Struct({
  configured: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type VoiceCredentialStatus = typeof VoiceCredentialStatus.Type;

export const VoiceCredentialSetInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString,
});
export type VoiceCredentialSetInput = typeof VoiceCredentialSetInput.Type;

export const VoiceConversationRetention = Schema.Literals(["ephemeral", "durable"]);
export type VoiceConversationRetention = typeof VoiceConversationRetention.Type;

export const VOICE_CONVERSATION_TITLE_MAX_CHARS = 256;
export const VOICE_CONVERSATION_LIST_CURSOR_MAX_CHARS = 2_048;
export const VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES = 50;
export const VOICE_CONVERSATION_TRANSCRIPT_CURSOR_MAX_CHARS = 2_048;
export const VOICE_CONVERSATION_TRANSCRIPT_ENTRY_MAX_CHARS = 16_000;
export const VOICE_CONVERSATION_TRANSCRIPT_PAGE_MAX_ENTRIES = 50;

const VoiceConversationTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(VOICE_CONVERSATION_TITLE_MAX_CHARS),
);

export const VoiceConversationSummary = Schema.Struct({
  conversationId: VoiceConversationId,
  retention: VoiceConversationRetention,
  title: Schema.NullOr(VoiceConversationTitle),
  activeEpoch: PositiveInt,
  lastCallAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VoiceConversationSummary = typeof VoiceConversationSummary.Type;

export const VoiceConversationListQuery = Schema.Struct({
  cursor: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_CONVERSATION_LIST_CURSOR_MAX_CHARS)),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1,
        maximum: VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES,
      }),
    ),
  ),
});
export type VoiceConversationListQuery = typeof VoiceConversationListQuery.Type;

export const VoiceConversationListPage = Schema.Struct({
  conversations: Schema.Array(VoiceConversationSummary).check(
    Schema.isMaxLength(VOICE_CONVERSATION_LIST_PAGE_MAX_ENTRIES),
  ),
  nextCursor: Schema.NullOr(
    TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_CONVERSATION_LIST_CURSOR_MAX_CHARS)),
  ),
});
export type VoiceConversationListPage = typeof VoiceConversationListPage.Type;

export const VoiceConversationCreateInput = Schema.Struct({
  retention: VoiceConversationRetention,
  title: Schema.optionalKey(VoiceConversationTitle),
});
export type VoiceConversationCreateInput = typeof VoiceConversationCreateInput.Type;

export const VoiceConversationUpdateInput = Schema.Struct({
  title: Schema.NullOr(VoiceConversationTitle),
});
export type VoiceConversationUpdateInput = typeof VoiceConversationUpdateInput.Type;

export const VoiceConversationTranscriptQuery = Schema.Struct({
  cursor: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_CONVERSATION_TRANSCRIPT_CURSOR_MAX_CHARS)),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1,
        maximum: VOICE_CONVERSATION_TRANSCRIPT_PAGE_MAX_ENTRIES,
      }),
    ),
  ),
});
export type VoiceConversationTranscriptQuery = typeof VoiceConversationTranscriptQuery.Type;

export const VoiceConversationTranscriptEntry = Schema.Struct({
  entryId: VoiceConversationEntryId,
  contextEpoch: PositiveInt,
  sequence: PositiveInt,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(VOICE_CONVERSATION_TRANSCRIPT_ENTRY_MAX_CHARS)),
  truncated: Schema.Boolean,
  occurredAt: IsoDateTime,
});
export type VoiceConversationTranscriptEntry = typeof VoiceConversationTranscriptEntry.Type;

export const VoiceConversationTranscriptPage = Schema.Struct({
  conversationId: VoiceConversationId,
  activeContextEpoch: PositiveInt,
  entries: Schema.Array(VoiceConversationTranscriptEntry).check(
    Schema.isMaxLength(VOICE_CONVERSATION_TRANSCRIPT_PAGE_MAX_ENTRIES),
  ),
  nextCursor: Schema.NullOr(
    TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_CONVERSATION_TRANSCRIPT_CURSOR_MAX_CHARS)),
  ),
});
export type VoiceConversationTranscriptPage = typeof VoiceConversationTranscriptPage.Type;

export const VoiceConversationClearContextInput = Schema.Struct({
  expectedEpoch: PositiveInt,
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type VoiceConversationClearContextInput = typeof VoiceConversationClearContextInput.Type;

export const VoiceConversationClearContextResult = Schema.Struct({
  conversationId: VoiceConversationId,
  activeEpoch: PositiveInt,
  clearedAt: IsoDateTime,
});
export type VoiceConversationClearContextResult = typeof VoiceConversationClearContextResult.Type;

export const VoiceConversationDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type VoiceConversationDeleteResult = typeof VoiceConversationDeleteResult.Type;

export const VoiceSessionMode = Schema.Literals(["realtime-transcription", "realtime-agent"]);
export type VoiceSessionMode = typeof VoiceSessionMode.Type;

const VoiceSdp = Schema.String.check(Schema.isPattern(/\S/));

export const VoiceSessionPhase = Schema.Literals([
  "creating",
  "signaling",
  "connecting",
  "idle",
  "listening",
  "thinking",
  "speaking",
  "confirming",
  "reconnecting",
  "ending",
  "ended",
  "error",
]);
export type VoiceSessionPhase = typeof VoiceSessionPhase.Type;

export const VoiceConversationSelection = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("new"),
    retention: VoiceConversationRetention,
    title: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("continue"),
    conversationId: VoiceConversationId,
    takeover: Schema.Boolean,
  }),
]);
export type VoiceConversationSelection = typeof VoiceConversationSelection.Type;

export const VoiceClientMediaCapabilities = Schema.Struct({
  transports: Schema.Array(Schema.Literal("webrtc-sdp-v1")),
  audioFormats: Schema.Array(VoiceAudioFormat),
  supportsInputRouteSelection: Schema.Boolean,
  supportsOutputRouteSelection: Schema.Boolean,
});
export type VoiceClientMediaCapabilities = typeof VoiceClientMediaCapabilities.Type;

export const VoiceSessionCreateInput = Schema.Struct({
  mode: VoiceSessionMode,
  conversation: VoiceConversationSelection,
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
  media: VoiceClientMediaCapabilities,
  idempotencyKey: TrimmedNonEmptyString,
});
export type VoiceSessionCreateInput = typeof VoiceSessionCreateInput.Type;

export const VoiceMediaTransport = Schema.Struct({
  kind: Schema.Literal("webrtc-sdp-v1"),
  signalingPath: TrimmedNonEmptyString,
});
export type VoiceMediaTransport = typeof VoiceMediaTransport.Type;

export const VoiceSessionState = Schema.Struct({
  sessionId: VoiceSessionId,
  conversationId: VoiceConversationId,
  mode: VoiceSessionMode,
  phase: VoiceSessionPhase,
  leaseGeneration: PositiveInt,
  sequence: NonNegativeInt,
});
export type VoiceSessionState = typeof VoiceSessionState.Type;

export const VoiceNativeControlGrant = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sessionId: VoiceSessionId,
  leaseGeneration: PositiveInt,
  expiresAt: IsoDateTime,
  heartbeatIntervalSeconds: PositiveInt,
  failureGraceSeconds: PositiveInt,
});
export type VoiceNativeControlGrant = typeof VoiceNativeControlGrant.Type;

export const VoiceSessionCreateResult = Schema.Struct({
  state: VoiceSessionState,
  transport: VoiceMediaTransport,
  expiresAt: IsoDateTime,
  heartbeatIntervalSeconds: PositiveInt,
  nativeControlGrant: VoiceNativeControlGrant,
});
export type VoiceSessionCreateResult = typeof VoiceSessionCreateResult.Type;

export const VoiceNativeHeartbeatInput = Schema.Struct({
  leaseGeneration: PositiveInt,
});
export type VoiceNativeHeartbeatInput = typeof VoiceNativeHeartbeatInput.Type;

export const VoiceNativeHeartbeatResult = Schema.Struct({
  sessionId: VoiceSessionId,
  leaseGeneration: PositiveInt,
  phase: VoiceSessionPhase,
  disposition: Schema.Literals(["live", "terminal"]),
  expiresAt: IsoDateTime,
});
export type VoiceNativeHeartbeatResult = typeof VoiceNativeHeartbeatResult.Type;

export const VoiceSessionLeaseInput = Schema.Struct({
  leaseGeneration: PositiveInt,
});
export type VoiceSessionLeaseInput = typeof VoiceSessionLeaseInput.Type;

export const VoiceSessionFocusInput = Schema.Union([
  Schema.Struct({
    leaseGeneration: PositiveInt,
    projectId: ProjectId,
    threadId: Schema.optionalKey(ThreadId),
  }),
  Schema.Struct({
    leaseGeneration: PositiveInt,
    projectId: Schema.optionalKey(Schema.Never),
    threadId: Schema.optionalKey(Schema.Never),
  }),
]);
export type VoiceSessionFocusInput = typeof VoiceSessionFocusInput.Type;

export const VoiceSessionFocusResult = Schema.Union([
  Schema.Struct({
    state: VoiceSessionState,
    projectId: ProjectId,
    threadId: Schema.optionalKey(ThreadId),
  }),
  Schema.Struct({
    state: VoiceSessionState,
    projectId: Schema.optionalKey(Schema.Never),
    threadId: Schema.optionalKey(Schema.Never),
  }),
]);
export type VoiceSessionFocusResult = typeof VoiceSessionFocusResult.Type;

export const VoiceSessionCloseResult = Schema.Struct({
  state: VoiceSessionState,
  closed: Schema.Boolean,
});
export type VoiceSessionCloseResult = typeof VoiceSessionCloseResult.Type;

export const VoiceSessionEventsQuery = Schema.Struct({
  afterSequence: Schema.optionalKey(NonNegativeInt),
  waitMilliseconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25_000 })),
  ),
});
export type VoiceSessionEventsQuery = typeof VoiceSessionEventsQuery.Type;

export const VoiceWebRtcOffer = Schema.Struct({
  sessionId: VoiceSessionId,
  leaseGeneration: PositiveInt,
  sdp: VoiceSdp,
});
export type VoiceWebRtcOffer = typeof VoiceWebRtcOffer.Type;

export const VoiceWebRtcAnswer = Schema.Struct({
  sessionId: VoiceSessionId,
  leaseGeneration: PositiveInt,
  sdp: VoiceSdp,
});
export type VoiceWebRtcAnswer = typeof VoiceWebRtcAnswer.Type;

export const VoiceTranscriptRole = Schema.Literals(["user", "assistant"]);
export type VoiceTranscriptRole = typeof VoiceTranscriptRole.Type;

export const VoiceToolName = Schema.Literals([
  "list_projects",
  "list_threads",
  "get_thread_status",
  "get_thread_messages",
  "wait_for_thread_turn",
  "search_history",
  "read_history",
  "activate_thread",
  "handoff_to_thread_voice",
  "create_thread",
  "send_thread_message",
  "interrupt_thread",
  "archive_thread",
]);
export type VoiceToolName = typeof VoiceToolName.Type;

export const VoiceToolOutcome = Schema.Literals([
  "pending-confirmation",
  "approved",
  "rejected",
  "expired",
  "succeeded",
  "failed",
]);
export type VoiceToolOutcome = typeof VoiceToolOutcome.Type;

const VoiceEventBase = {
  sessionId: VoiceSessionId,
  leaseGeneration: PositiveInt,
  sequence: NonNegativeInt,
  occurredAt: IsoDateTime,
};

export const VoiceSessionEvent = Schema.Union([
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("state"),
    phase: VoiceSessionPhase,
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("transcript"),
    role: VoiceTranscriptRole,
    text: Schema.String.check(Schema.isNonEmpty()),
    final: Schema.Literal(false),
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("transcript"),
    role: VoiceTranscriptRole,
    text: TrimmedNonEmptyString,
    final: Schema.Literal(true),
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("tool"),
    toolCallId: VoiceToolCallId,
    tool: VoiceToolName,
    outcome: VoiceToolOutcome,
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("confirmation-required"),
    confirmationId: VoiceConfirmationId,
    toolCallId: VoiceToolCallId,
    tool: VoiceToolName,
    summary: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("client-action"),
    action: Schema.Literal("handoff-to-thread-voice"),
    actionId: VoiceClientActionId,
    projectId: ProjectId,
    threadId: ThreadId,
    autoRearm: Schema.Boolean,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("client-action"),
    action: Schema.Literal("activate-thread"),
    actionId: VoiceClientActionId,
    projectId: ProjectId,
    threadId: ThreadId,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("lease-fenced"),
    replacementGeneration: PositiveInt,
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("rotation-required"),
    reason: Schema.Literals(["duration-limit", "context-limit", "configuration-changed"]),
  }),
  Schema.Struct({
    ...VoiceEventBase,
    type: Schema.Literal("error"),
    reason: TrimmedNonEmptyString,
    recoverable: Schema.Boolean,
  }),
]);
export type VoiceSessionEvent = typeof VoiceSessionEvent.Type;

export const VoiceSessionEventsResult = Schema.Struct({
  state: VoiceSessionState,
  events: Schema.Array(VoiceSessionEvent),
});
export type VoiceSessionEventsResult = typeof VoiceSessionEventsResult.Type;

export const VoiceClientActionOutcome = Schema.Literals(["succeeded", "failed"]);
export type VoiceClientActionOutcome = typeof VoiceClientActionOutcome.Type;

export const VoiceHandoffFailureStage = Schema.Literals([
  "target-resolution",
  "realtime-release",
  "audio-focus",
  "recognition-start",
]);
export type VoiceHandoffFailureStage = typeof VoiceHandoffFailureStage.Type;

export const VoiceHandoffFailureReason = Schema.Literals([
  "target-unavailable",
  "realtime-release-failed",
  "audio-focus-unavailable",
  "microphone-unavailable",
  "permission-denied",
  "runtime-unavailable",
  "operation-timeout",
]);
export type VoiceHandoffFailureReason = typeof VoiceHandoffFailureReason.Type;

export const VoiceClientActionAckInput = Schema.Union([
  Schema.Struct({
    leaseGeneration: PositiveInt,
    action: Schema.Literal("activate-thread"),
    outcome: VoiceClientActionOutcome,
    message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  }),
  Schema.Struct({
    leaseGeneration: PositiveInt,
    action: Schema.Literal("handoff-to-thread-voice"),
    outcome: Schema.Literal("succeeded"),
    state: Schema.Literal("listening"),
  }),
  Schema.Struct({
    leaseGeneration: PositiveInt,
    action: Schema.Literal("handoff-to-thread-voice"),
    outcome: Schema.Literal("failed"),
    stage: VoiceHandoffFailureStage,
    reason: VoiceHandoffFailureReason,
  }),
]);
export type VoiceClientActionAckInput = typeof VoiceClientActionAckInput.Type;

export const VoiceClientActionAckResult = Schema.Struct({
  actionId: VoiceClientActionId,
  action: Schema.Literals(["activate-thread", "handoff-to-thread-voice"]),
  outcome: VoiceClientActionOutcome,
});
export type VoiceClientActionAckResult = typeof VoiceClientActionAckResult.Type;

export const VoiceNativeHandoffAction = Schema.Struct({
  actionId: VoiceClientActionId,
  sessionId: VoiceSessionId,
  leaseGeneration: PositiveInt,
  projectId: ProjectId,
  threadId: ThreadId,
  autoRearm: Schema.Boolean,
  expiresAt: IsoDateTime,
});
export type VoiceNativeHandoffAction = typeof VoiceNativeHandoffAction.Type;

export const VoiceNativeHandoffActionListResult = Schema.Struct({
  actions: Schema.Array(VoiceNativeHandoffAction),
});
export type VoiceNativeHandoffActionListResult = typeof VoiceNativeHandoffActionListResult.Type;

export const VoiceNativeHandoffActionAckInput = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("succeeded"),
    state: Schema.Literal("listening"),
  }),
  Schema.Struct({
    outcome: Schema.Literal("failed"),
    stage: VoiceHandoffFailureStage,
    reason: VoiceHandoffFailureReason,
  }),
]);
export type VoiceNativeHandoffActionAckInput = typeof VoiceNativeHandoffActionAckInput.Type;

export const VoiceConfirmationDecision = Schema.Literals(["approve", "reject"]);
export type VoiceConfirmationDecision = typeof VoiceConfirmationDecision.Type;

export const VoiceConfirmationInput = Schema.Struct({
  decision: VoiceConfirmationDecision,
});
export type VoiceConfirmationInput = typeof VoiceConfirmationInput.Type;

export const VoiceConfirmationResult = Schema.Struct({
  confirmationId: VoiceConfirmationId,
  toolCallId: VoiceToolCallId,
  outcome: Schema.Literals(["approved", "rejected"]),
});
export type VoiceConfirmationResult = typeof VoiceConfirmationResult.Type;

export const VOICE_TRANSCRIPTION_LANGUAGE_MAX_CHARS = 35;
export const VOICE_TRANSCRIPTION_VOCABULARY_MAX_ITEMS = 64;
export const VOICE_TRANSCRIPTION_VOCABULARY_ITEM_MAX_CHARS = 128;
export const VOICE_SPEECH_TEXT_MAX_BYTES = 8 * 1024;

const VoiceTranscriptionLanguage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(VOICE_TRANSCRIPTION_LANGUAGE_MAX_CHARS),
  Schema.isPattern(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
);
const VoiceTranscriptionVocabularyItem = TrimmedNonEmptyString.check(
  Schema.isMaxLength(VOICE_TRANSCRIPTION_VOCABULARY_ITEM_MAX_CHARS),
);
const VoiceSpeechText = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (text) =>
      new TextEncoder().encode(text).byteLength <= VOICE_SPEECH_TEXT_MAX_BYTES ||
      `Speech text must not exceed ${VOICE_SPEECH_TEXT_MAX_BYTES} UTF-8 bytes`,
  ),
);

export const VoiceTranscriptionMetadata = Schema.Struct({
  requestId: VoiceRequestId,
  format: VoiceTranscriptionUploadFormat,
  language: Schema.optionalKey(VoiceTranscriptionLanguage),
  vocabulary: Schema.optionalKey(
    Schema.Array(VoiceTranscriptionVocabularyItem).check(
      Schema.isMaxLength(VOICE_TRANSCRIPTION_VOCABULARY_MAX_ITEMS),
    ),
  ),
});
export type VoiceTranscriptionMetadata = typeof VoiceTranscriptionMetadata.Type;

export const VoiceTranscriptionResult = Schema.Struct({
  requestId: VoiceRequestId,
  text: TrimmedNonEmptyString,
  language: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;

export const VoiceTranscriptionStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("delta"),
    requestId: VoiceRequestId,
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("final"),
    result: VoiceTranscriptionResult,
  }),
]);
export type VoiceTranscriptionStreamEvent = typeof VoiceTranscriptionStreamEvent.Type;

export const VoiceSpeechPreset = Schema.Literals(["default", "warm"]);
export type VoiceSpeechPreset = typeof VoiceSpeechPreset.Type;

export const VoiceSpeechRequest = Schema.Struct({
  requestId: VoiceRequestId,
  playbackId: VoicePlaybackId,
  segmentIndex: NonNegativeInt,
  finalSegment: Schema.Boolean,
  text: VoiceSpeechText,
  preset: VoiceSpeechPreset,
});
export type VoiceSpeechRequest = typeof VoiceSpeechRequest.Type;

export const VoiceMediaTicketOperation = Schema.Literals(["transcription-upload", "speech-stream"]);
export type VoiceMediaTicketOperation = typeof VoiceMediaTicketOperation.Type;

export const VoiceMediaTicketRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("transcription-upload"),
    requestId: VoiceRequestId,
  }),
  Schema.Struct({
    operation: Schema.Literal("speech-stream"),
    requestId: VoiceRequestId,
  }),
]);
export type VoiceMediaTicketRequest = typeof VoiceMediaTicketRequest.Type;

export const VoiceMediaTicket = Schema.Struct({
  ticketId: VoiceMediaTicketId,
  token: TrimmedNonEmptyString,
  operation: VoiceMediaTicketOperation,
  expiresAt: IsoDateTime,
});
export type VoiceMediaTicket = typeof VoiceMediaTicket.Type;

export const VoicePublicErrorReason = Schema.Literals([
  "disabled",
  "not-configured",
  "unsupported-media",
  "payload-too-large",
  "duration-limit",
  "quota-exceeded",
  "conversation-not-found",
  "session-not-found",
  "takeover-required",
  "lease-conflict",
  "invalid-context",
  "invalid-phase",
  "provider-unavailable",
  "confirmation-expired",
  "authorization-revoked",
]);
export type VoicePublicErrorReason = typeof VoicePublicErrorReason.Type;

export const VoicePublicError = Schema.Struct({
  reason: VoicePublicErrorReason,
  message: TrimmedNonEmptyString,
  requestId: Schema.optionalKey(VoiceRequestId),
  sessionId: Schema.optionalKey(VoiceSessionId),
  retryable: Schema.Boolean,
});
export type VoicePublicError = typeof VoicePublicError.Type;

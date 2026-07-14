import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  VoiceClientActionId,
  VoiceConfirmationId,
  VoiceConversationId,
  VoiceDraftArtifactId,
  VoiceModeSessionId,
  VoiceRuntimeCommandId,
  VoiceRuntimeConsumerLeaseId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceSessionId,
  VoiceSpeechPlanId,
  VoiceThreadTurnOperationId,
  VoiceToolCallId,
  VoiceTurnClientOperationId,
} from "./baseSchemas.ts";
import {
  VoiceRuntimeControlGrant,
  VoiceSessionState,
  VoiceSpeechPreset,
  VoiceToolName,
  VoiceTranscriptionUploadFormat,
} from "./voice.ts";

const RuntimeIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(192));
export const VoiceRuntimeTargetDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type VoiceRuntimeTargetDigest = typeof VoiceRuntimeTargetDigest.Type;
export const VoiceRuntimeCredentialHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type VoiceRuntimeCredentialHash = typeof VoiceRuntimeCredentialHash.Type;
const RuntimeToken = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const RuntimeFailureCode = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const RuntimeFailureMessage = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const VoiceRuntimeExecutionModel = Schema.Literals(["autonomous", "ui-attached"]);
export type VoiceRuntimeExecutionModel = typeof VoiceRuntimeExecutionModel.Type;

export const VOICE_RUNTIME_PROTOCOL_MAJOR = 1 as const;
export const VOICE_RUNTIME_PROTOCOL_HEADER = "x-t3-voice-runtime-protocol-major" as const;
export const VoiceRuntimeProtocolMajor = PositiveInt;
export type VoiceRuntimeProtocolMajor = typeof VoiceRuntimeProtocolMajor.Type;

export const VoiceRuntimePcmFormat = Schema.Struct({
  encoding: Schema.Literal("pcm-s16le"),
  sampleRates: Schema.Array(PositiveInt).check(Schema.isMaxLength(16)),
  channelCounts: Schema.Array(Schema.Literals([1, 2])).check(Schema.isMaxLength(2)),
});
export type VoiceRuntimePcmFormat = typeof VoiceRuntimePcmFormat.Type;

export const VoiceRuntimeDescriptor = Schema.Struct({
  protocolMajor: PositiveInt,
  executionModel: VoiceRuntimeExecutionModel,
  capabilities: Schema.Struct({
    automaticEndpointing: Schema.Boolean,
    recordingFormats: Schema.Array(VoiceTranscriptionUploadFormat).check(Schema.isMaxLength(16)),
    playbackFormats: Schema.Array(VoiceRuntimePcmFormat).check(Schema.isMaxLength(8)),
    realtimeWebRtc: Schema.Boolean,
    persistentReadiness: Schema.Boolean,
    notificationControl: Schema.Boolean,
    headsetControl: Schema.Boolean,
    inputRouteSelection: Schema.Boolean,
    outputRouteSelection: Schema.Boolean,
  }),
});
export type VoiceRuntimeDescriptor = typeof VoiceRuntimeDescriptor.Type;

export const VoiceRuntimeEndpointPolicy = Schema.Struct({
  endSilenceMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 30_000 })),
  noSpeechTimeoutMs: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 30 * 60_000 })),
  ),
  maximumUtteranceMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60_000 })),
});
export type VoiceRuntimeEndpointPolicy = typeof VoiceRuntimeEndpointPolicy.Type;

export const VoiceRealtimeRuntimeTarget = Schema.Struct({
  mode: Schema.Literal("realtime"),
  environmentId: EnvironmentId,
  conversationId: VoiceConversationId,
});
export type VoiceRealtimeRuntimeTarget = typeof VoiceRealtimeRuntimeTarget.Type;

export const VoiceThreadRuntimeTarget = Schema.Struct({
  mode: Schema.Literal("thread"),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  speechPreset: VoiceSpeechPreset,
  autoRearm: Schema.Boolean,
  endpointPolicy: VoiceRuntimeEndpointPolicy,
  speechEnabled: Schema.Boolean,
  rearmGuardMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })),
});
export type VoiceThreadRuntimeTarget = typeof VoiceThreadRuntimeTarget.Type;

export const VoiceRuntimeTarget = Schema.Union([
  VoiceRealtimeRuntimeTarget,
  VoiceThreadRuntimeTarget,
]);
export type VoiceRuntimeTarget = typeof VoiceRuntimeTarget.Type;

export const VoiceRuntimeCursor = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  generation: NonNegativeInt,
  sequence: NonNegativeInt,
});
export type VoiceRuntimeCursor = typeof VoiceRuntimeCursor.Type;

export const VoiceRuntimePresentationState = Schema.Literals([
  "foreground-active",
  "visible-inactive",
  "background",
]);
export type VoiceRuntimePresentationState = typeof VoiceRuntimePresentationState.Type;

export const VoiceRuntimeAttachRequest = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  generation: NonNegativeInt,
  presentation: VoiceRuntimePresentationState,
});
export type VoiceRuntimeAttachRequest = typeof VoiceRuntimeAttachRequest.Type;

export const VoiceRuntimeConsumerLease = Schema.Struct({
  leaseId: VoiceRuntimeConsumerLeaseId,
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  generation: NonNegativeInt,
  leaseGeneration: PositiveInt,
  attachOrdinal: PositiveInt,
  presentation: VoiceRuntimePresentationState,
  election: Schema.Literals(["elected", "standby"]),
  expiresAt: IsoDateTime,
});
export type VoiceRuntimeConsumerLease = typeof VoiceRuntimeConsumerLease.Type;

export const VoiceRuntimeAttachmentUpdate = Schema.Struct({
  lease: VoiceRuntimeConsumerLease,
  presentation: VoiceRuntimePresentationState,
});
export type VoiceRuntimeAttachmentUpdate = typeof VoiceRuntimeAttachmentUpdate.Type;

export const VoiceRuntimePresentationElection = Schema.Struct({
  electedLeaseId: Schema.NullOr(VoiceRuntimeConsumerLeaseId),
  electedAttachOrdinal: Schema.NullOr(PositiveInt),
  eligibleConsumerCount: NonNegativeInt,
  changedAt: IsoDateTime,
});
export type VoiceRuntimePresentationElection = typeof VoiceRuntimePresentationElection.Type;

export const VoiceRuntimeAvailability = Schema.Literals(["unavailable", "locked", "ready"]);
export type VoiceRuntimeAvailability = typeof VoiceRuntimeAvailability.Type;

export const VoiceRuntimeReadiness = Schema.Union([
  Schema.Struct({ state: Schema.Literal("disabled") }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    mode: Schema.Literals(["realtime", "thread"]),
  }),
  Schema.Struct({
    state: Schema.Literal("active"),
    mode: Schema.Literals(["realtime", "thread"]),
  }),
]);
export type VoiceRuntimeReadiness = typeof VoiceRuntimeReadiness.Type;

export const VoiceRealtimeOperationPhase = Schema.Literals([
  "preparing",
  "negotiating",
  "cueing",
  "connected",
  "draining",
  "stopping",
  "retrying",
  "recovering",
  "completed",
  "failed",
  "cancelled",
]);
export type VoiceRealtimeOperationPhase = typeof VoiceRealtimeOperationPhase.Type;

const VoiceThreadOrdinaryPhase = Schema.Literals([
  "arming",
  "recording",
  "finalizing",
  "uploading",
  "transcribing",
  "dispatching",
  "waiting",
  "playing",
  "playback-drained",
  "guarding",
  "rearming",
  "draft-ready",
  "retrying",
  "recovering",
  "completed",
  "failed",
  "cancelled",
]);
export const VoiceThreadOperationPhase = Schema.Union([
  Schema.Struct({ phase: VoiceThreadOrdinaryPhase }),
  Schema.Struct({
    phase: Schema.Literal("paused"),
    reason: Schema.Literals(["user", "authority", "network"]),
  }),
  Schema.Struct({
    phase: Schema.Literal("attention-required"),
    reason: Schema.Literals(["approval", "user-input", "inaccessible-target", "draft-review"]),
  }),
]);
export type VoiceThreadOperationPhase = typeof VoiceThreadOperationPhase.Type;

export const VoiceRuntimeOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("realtime"),
    modeSessionId: VoiceModeSessionId,
    phase: VoiceRealtimeOperationPhase,
    conversationId: VoiceConversationId,
    sessionId: Schema.NullOr(VoiceSessionId),
    muted: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-turn"),
    modeSessionId: VoiceModeSessionId,
    phase: VoiceThreadOperationPhase,
    turnClientOperationId: Schema.NullOr(VoiceTurnClientOperationId),
    turnOperationId: Schema.NullOr(VoiceThreadTurnOperationId),
  }),
]);
export type VoiceRuntimeOperation = typeof VoiceRuntimeOperation.Type;

export const VoiceRuntimeRootOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("mode"),
    modeSessionId: VoiceModeSessionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn"),
    modeSessionId: VoiceModeSessionId,
    turnClientOperationId: VoiceTurnClientOperationId,
    turnOperationId: Schema.NullOr(VoiceThreadTurnOperationId),
  }),
]);
export type VoiceRuntimeRootOperation = typeof VoiceRuntimeRootOperation.Type;

export const VoiceRuntimeMediaOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("recorder"),
    owner: Schema.Literals(["thread-mode", "realtime-handoff"]),
    root: VoiceRuntimeRootOperation,
  }),
  Schema.Struct({
    kind: Schema.Literal("player"),
    owner: Schema.Literal("thread-mode"),
    root: VoiceRuntimeRootOperation,
  }),
  Schema.Struct({
    kind: Schema.Literal("realtime-peer"),
    modeSessionId: VoiceModeSessionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("cue-player"),
    root: VoiceRuntimeRootOperation,
  }),
]);
export type VoiceRuntimeMediaOwner = typeof VoiceRuntimeMediaOwner.Type;

export const VoiceRuntimeFailure = Schema.Struct({
  code: RuntimeFailureCode,
  message: RuntimeFailureMessage,
  retryable: Schema.Boolean,
  occurredAt: IsoDateTime,
});
export type VoiceRuntimeFailure = typeof VoiceRuntimeFailure.Type;

export const VoiceRuntimeSnapshot = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  generation: NonNegativeInt,
  sequence: NonNegativeInt,
  availability: VoiceRuntimeAvailability,
  target: Schema.NullOr(VoiceRuntimeTarget),
  operation: VoiceRuntimeOperation,
  mediaOwner: VoiceRuntimeMediaOwner,
  readiness: VoiceRuntimeReadiness,
  route: Schema.Struct({
    inputRouteId: Schema.NullOr(RuntimeIdentifier),
    outputRouteId: Schema.NullOr(RuntimeIdentifier),
  }),
  failure: Schema.NullOr(VoiceRuntimeFailure),
});
export type VoiceRuntimeSnapshot = typeof VoiceRuntimeSnapshot.Type;

const VoiceRuntimeAuthorityReservationBase = {
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  provisioningOperationId: VoiceRuntimeProvisioningOperationId,
  expectedCurrentGeneration: NonNegativeInt,
  generation: PositiveInt,
  targetDigest: VoiceRuntimeTargetDigest,
  environmentOrigin: Schema.String,
  readinessEnabled: Schema.Boolean,
  refreshRotationCounter: NonNegativeInt,
  token: RuntimeToken,
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime,
};

export const VoiceRuntimeAuthorityReservation = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeAuthorityReservationBase,
    target: VoiceRealtimeRuntimeTarget,
    operation: Schema.Literal("realtime-start"),
  }),
  Schema.Struct({
    ...VoiceRuntimeAuthorityReservationBase,
    target: VoiceThreadRuntimeTarget,
    operation: Schema.Literal("thread-turn-start"),
  }),
]);
export type VoiceRuntimeAuthorityReservation = typeof VoiceRuntimeAuthorityReservation.Type;

export const VoiceRuntimeGrantOperation = Schema.Literals(["realtime-start", "thread-turn-start"]);
export type VoiceRuntimeGrantOperation = typeof VoiceRuntimeGrantOperation.Type;

const VoiceRuntimeGrantProvisionBase = {
  expectedCurrentGeneration: NonNegativeInt,
  generation: PositiveInt,
  provisioningOperationId: VoiceRuntimeProvisioningOperationId,
  targetDigest: VoiceRuntimeTargetDigest,
};

export const VoiceRuntimeGrantProvisionInput = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeGrantProvisionBase,
    operation: Schema.Literal("realtime-start"),
    target: VoiceRealtimeRuntimeTarget,
    readinessEnabled: Schema.Literal(true),
    refreshCredentialHash: VoiceRuntimeCredentialHash,
  }),
  Schema.Struct({
    ...VoiceRuntimeGrantProvisionBase,
    operation: Schema.Literal("realtime-start"),
    target: VoiceRealtimeRuntimeTarget,
    readinessEnabled: Schema.Literal(false),
    refreshCredentialHash: Schema.Null,
  }),
  Schema.Struct({
    ...VoiceRuntimeGrantProvisionBase,
    operation: Schema.Literal("thread-turn-start"),
    target: VoiceThreadRuntimeTarget,
    readinessEnabled: Schema.Literal(true),
    refreshCredentialHash: VoiceRuntimeCredentialHash,
  }),
  Schema.Struct({
    ...VoiceRuntimeGrantProvisionBase,
    operation: Schema.Literal("thread-turn-start"),
    target: VoiceThreadRuntimeTarget,
    readinessEnabled: Schema.Literal(false),
    refreshCredentialHash: Schema.Null,
  }),
]);
export type VoiceRuntimeGrantProvisionInput = typeof VoiceRuntimeGrantProvisionInput.Type;

const VoiceRuntimeGrantBase = {
  token: RuntimeToken,
  runtimeId: VoiceRuntimeId,
  generation: PositiveInt,
  provisioningOperationId: VoiceRuntimeProvisioningOperationId,
  targetDigest: VoiceRuntimeTargetDigest,
  readinessEnabled: Schema.Boolean,
  refreshRotationCounter: NonNegativeInt,
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime,
};

export const VoiceRuntimeGrant = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeGrantBase,
    target: VoiceRealtimeRuntimeTarget,
    operation: Schema.Literal("realtime-start"),
  }),
  Schema.Struct({
    ...VoiceRuntimeGrantBase,
    target: VoiceThreadRuntimeTarget,
    operation: Schema.Literal("thread-turn-start"),
  }),
]);
export type VoiceRuntimeGrant = typeof VoiceRuntimeGrant.Type;

export const VoiceRuntimeGrantRevocationResult = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  revoked: Schema.Boolean,
});
export type VoiceRuntimeGrantRevocationResult = typeof VoiceRuntimeGrantRevocationResult.Type;

export const VoiceRuntimeGrantRefreshInput = Schema.Struct({
  refreshRequestId: RuntimeIdentifier,
  provisioningOperationId: VoiceRuntimeProvisioningOperationId,
  generation: PositiveInt,
  operation: VoiceRuntimeGrantOperation,
  targetDigest: VoiceRuntimeTargetDigest,
  expectedRotationCounter: NonNegativeInt,
  candidateCredentialHash: VoiceRuntimeCredentialHash,
});
export type VoiceRuntimeGrantRefreshInput = typeof VoiceRuntimeGrantRefreshInput.Type;

export const VoiceRuntimeGrantRefreshResult = VoiceRuntimeGrant;
export type VoiceRuntimeGrantRefreshResult = typeof VoiceRuntimeGrantRefreshResult.Type;

export const VoiceRuntimeAuthorityClearCommand = Schema.Struct({
  commandId: VoiceRuntimeCommandId,
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  authorityGeneration: PositiveInt,
});
export type VoiceRuntimeAuthorityClearCommand = typeof VoiceRuntimeAuthorityClearCommand.Type;

export const VoiceSpeechSegmentDisposition = Schema.Struct({
  segmentIndex: NonNegativeInt,
  disposition: Schema.Literals(["drained", "interrupted", "skipped", "failed"]),
});
export type VoiceSpeechSegmentDisposition = typeof VoiceSpeechSegmentDisposition.Type;

export const VoiceThreadTurnReceipt = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  runtimeGeneration: PositiveInt,
  modeSessionId: VoiceModeSessionId,
  turnClientOperationId: VoiceTurnClientOperationId,
  turnOperationId: Schema.NullOr(VoiceThreadTurnOperationId),
  target: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
  }),
  userMessageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  assistantMessageIds: Schema.Array(MessageId).check(Schema.isMaxLength(256)),
  speechPlanId: Schema.NullOr(VoiceSpeechPlanId),
  highestAdvertisedSegment: Schema.NullOr(NonNegativeInt),
  highestStartedSegment: Schema.NullOr(NonNegativeInt),
  highestDrainedSegment: Schema.NullOr(NonNegativeInt),
  segmentDispositions: Schema.Array(VoiceSpeechSegmentDisposition).check(Schema.isMaxLength(512)),
  speechTerminal: Schema.NullOr(Schema.Literals(["completed", "no-speech", "failed"])),
  terminalOutcome: Schema.NullOr(Schema.Literals(["completed", "failed", "cancelled", "detached"])),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type VoiceThreadTurnReceipt = typeof VoiceThreadTurnReceipt.Type;

export const VoiceRealtimeTerminalSummary = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  runtimeGeneration: PositiveInt,
  modeSessionId: VoiceModeSessionId,
  conversationId: VoiceConversationId,
  sessionId: Schema.NullOr(VoiceSessionId),
  outcome: Schema.Literals(["completed", "stopped", "interrupted", "failed"]),
  reason: RuntimeFailureCode,
  lastConnectedAt: Schema.NullOr(IsoDateTime),
  terminalAt: IsoDateTime,
  serverCleanupPending: Schema.Boolean,
  expiresAt: IsoDateTime,
});
export type VoiceRealtimeTerminalSummary = typeof VoiceRealtimeTerminalSummary.Type;

export const VoiceRuntimeRetainedRecordAcknowledgement = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  authorityGeneration: PositiveInt,
  record: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("thread-receipt"),
      sourceRuntimeId: VoiceRuntimeId,
      sourceRuntimeInstanceId: VoiceRuntimeInstanceId,
      sourceRuntimeGeneration: PositiveInt,
      modeSessionId: VoiceModeSessionId,
      turnClientOperationId: VoiceTurnClientOperationId,
    }),
    Schema.Struct({
      kind: Schema.Literal("realtime-terminal"),
      sourceRuntimeId: VoiceRuntimeId,
      sourceRuntimeInstanceId: VoiceRuntimeInstanceId,
      sourceRuntimeGeneration: PositiveInt,
      modeSessionId: VoiceModeSessionId,
    }),
  ]),
});
export type VoiceRuntimeRetainedRecordAcknowledgement =
  typeof VoiceRuntimeRetainedRecordAcknowledgement.Type;

export const VoiceDraftArtifactHandle = Schema.Struct({
  artifactId: VoiceDraftArtifactId,
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  runtimeGeneration: PositiveInt,
  modeSessionId: VoiceModeSessionId,
  turnClientOperationId: VoiceTurnClientOperationId,
  target: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
  }),
  composerRevision: RuntimeIdentifier,
  expiresAt: IsoDateTime,
});
export type VoiceDraftArtifactHandle = typeof VoiceDraftArtifactHandle.Type;

export const VoiceDraftArtifactRead = Schema.Struct({
  lease: VoiceRuntimeConsumerLease,
  artifactId: VoiceDraftArtifactId,
});
export type VoiceDraftArtifactRead = typeof VoiceDraftArtifactRead.Type;

export const VoiceDraftArtifact = Schema.Struct({
  handle: VoiceDraftArtifactHandle,
  transcript: Schema.String.check(Schema.isMaxLength(128 * 1024)),
});
export type VoiceDraftArtifact = typeof VoiceDraftArtifact.Type;

export const VoiceDraftArtifactAcknowledgement = Schema.Struct({
  lease: VoiceRuntimeConsumerLease,
  artifactId: VoiceDraftArtifactId,
  outcome: Schema.Literals(["appended", "discarded"]),
});
export type VoiceDraftArtifactAcknowledgement = typeof VoiceDraftArtifactAcknowledgement.Type;

export const VoiceRuntimePresentationAction = Schema.Union([
  Schema.Struct({
    actionId: VoiceClientActionId,
    action: Schema.Literal("navigate-thread"),
    projectId: ProjectId,
    threadId: ThreadId,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    actionId: VoiceClientActionId,
    action: Schema.Literal("review-draft"),
    artifact: VoiceDraftArtifactHandle,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    actionId: VoiceClientActionId,
    action: Schema.Literal("realtime-confirmation-required"),
    confirmationId: VoiceConfirmationId,
    toolCallId: VoiceToolCallId,
    tool: VoiceToolName,
    summary: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
    expiresAt: IsoDateTime,
  }),
]);
export type VoiceRuntimePresentationAction = typeof VoiceRuntimePresentationAction.Type;

export const VoiceRuntimePresentationActionClaim = Schema.Struct({
  lease: VoiceRuntimeConsumerLease,
  actionId: VoiceClientActionId,
});
export type VoiceRuntimePresentationActionClaim = typeof VoiceRuntimePresentationActionClaim.Type;

export const VoiceRuntimePresentationActionAcknowledgement = Schema.Struct({
  lease: VoiceRuntimeConsumerLease,
  actionId: VoiceClientActionId,
  outcome: Schema.Literals(["succeeded", "failed"]),
  message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type VoiceRuntimePresentationActionAcknowledgement =
  typeof VoiceRuntimePresentationActionAcknowledgement.Type;

export const VoiceRuntimeRebaseReason = Schema.Literals([
  "cursor-too-old",
  "runtime-replaced",
  "generation-changed",
]);
export type VoiceRuntimeRebaseReason = typeof VoiceRuntimeRebaseReason.Type;

export const VoiceRuntimeRebase = Schema.Struct({
  type: Schema.Literal("rebase"),
  reason: VoiceRuntimeRebaseReason,
  cursor: VoiceRuntimeCursor,
  snapshot: VoiceRuntimeSnapshot,
  threadReceipts: Schema.Array(VoiceThreadTurnReceipt).check(Schema.isMaxLength(256)),
  realtimeTerminalSummaries: Schema.Array(VoiceRealtimeTerminalSummary).check(
    Schema.isMaxLength(256),
  ),
  draftArtifacts: Schema.Array(VoiceDraftArtifactHandle).check(Schema.isMaxLength(32)),
  presentationActions: Schema.Array(VoiceRuntimePresentationAction).check(Schema.isMaxLength(64)),
});
export type VoiceRuntimeRebase = typeof VoiceRuntimeRebase.Type;

const VoiceRuntimeCommandFence = {
  commandId: VoiceRuntimeCommandId,
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  authorityGeneration: PositiveInt,
};

export const VoiceRuntimeInterruptionPolicy = Schema.Literals([
  "reject",
  "stop-conflicting",
  "drain-conflicting",
]);
export type VoiceRuntimeInterruptionPolicy = typeof VoiceRuntimeInterruptionPolicy.Type;

export const VoiceRuntimeDraftContext = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  composerRevision: RuntimeIdentifier,
});
export type VoiceRuntimeDraftContext = typeof VoiceRuntimeDraftContext.Type;

export const VoiceRuntimeCommand = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("start-realtime"),
    modeSessionId: VoiceModeSessionId,
    interruptionPolicy: VoiceRuntimeInterruptionPolicy,
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("start-thread-mode"),
    modeSessionId: VoiceModeSessionId,
    turnClientOperationId: VoiceTurnClientOperationId,
    submissionPolicy: Schema.Literals(["auto-submit", "draft"]),
    draftContext: Schema.NullOr(VoiceRuntimeDraftContext),
    interruptionPolicy: VoiceRuntimeInterruptionPolicy,
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("resume-thread-mode"),
    modeSessionId: VoiceModeSessionId,
    turnClientOperationId: VoiceTurnClientOperationId,
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("finish-thread-turn"),
    modeSessionId: VoiceModeSessionId,
    turnClientOperationId: VoiceTurnClientOperationId,
    outcome: Schema.Literals(["finish-and-submit", "finish-to-draft"]),
    draftContext: Schema.NullOr(VoiceRuntimeDraftContext),
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("cancel-thread-turn"),
    modeSessionId: VoiceModeSessionId,
    turnClientOperationId: VoiceTurnClientOperationId,
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("stop-mode"),
    modeSessionId: VoiceModeSessionId,
    policy: Schema.Literals(["immediate", "drain", "pause-after-turn"]),
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("set-realtime-muted"),
    modeSessionId: VoiceModeSessionId,
    muted: Schema.Boolean,
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("set-audio-route"),
    modeSessionId: VoiceModeSessionId,
    inputRouteId: Schema.NullOr(RuntimeIdentifier),
    outputRouteId: Schema.NullOr(RuntimeIdentifier),
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("update-realtime-focus"),
    modeSessionId: VoiceModeSessionId,
    focus: Schema.NullOr(
      Schema.Struct({
        projectId: ProjectId,
        threadId: Schema.NullOr(ThreadId),
      }),
    ),
  }),
  Schema.Struct({
    ...VoiceRuntimeCommandFence,
    kind: Schema.Literal("decide-realtime-confirmation"),
    modeSessionId: VoiceModeSessionId,
    lease: VoiceRuntimeConsumerLease,
    actionId: VoiceClientActionId,
    confirmationId: VoiceConfirmationId,
    decision: Schema.Literals(["approve", "reject"]),
  }),
]);
export type VoiceRuntimeCommand = typeof VoiceRuntimeCommand.Type;

export const VoiceRuntimeCommandRejectionReason = Schema.Literals([
  "unsupported-capability",
  "stale-runtime",
  "stale-runtime-instance",
  "stale-authority-generation",
  "authority-unavailable",
  "authority-replacement-required",
  "permission-denied",
  "owner-conflict",
  "invalid-phase",
  "idempotency-conflict",
]);
export type VoiceRuntimeCommandRejectionReason = typeof VoiceRuntimeCommandRejectionReason.Type;

export const VoiceRuntimeCommandOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("accepted") }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    reason: VoiceRuntimeCommandRejectionReason,
  }),
  Schema.Struct({
    type: Schema.Literal("rebase-required"),
    rebase: VoiceRuntimeRebase,
  }),
]);
export type VoiceRuntimeCommandOutcome = typeof VoiceRuntimeCommandOutcome.Type;

export const VoiceCommandReceipt = Schema.Struct({
  commandId: VoiceRuntimeCommandId,
  root: VoiceRuntimeRootOperation,
  replayed: Schema.Boolean,
  outcome: VoiceRuntimeCommandOutcome,
  cursor: VoiceRuntimeCursor,
});
export type VoiceCommandReceipt = typeof VoiceCommandReceipt.Type;

const VoiceRuntimeEventBase = {
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  authorityGeneration: NonNegativeInt,
  sequence: PositiveInt,
  occurredAt: IsoDateTime,
  root: VoiceRuntimeRootOperation,
  causedByCommandId: Schema.optionalKey(VoiceRuntimeCommandId),
};

export const VoiceRuntimeEvent = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("state-changed"),
    snapshot: VoiceRuntimeSnapshot,
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("command-outcome"),
    receipt: VoiceCommandReceipt,
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("thread-receipt"),
    receipt: VoiceThreadTurnReceipt,
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("realtime-terminal"),
    summary: VoiceRealtimeTerminalSummary,
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("draft-artifact-ready"),
    artifact: VoiceDraftArtifactHandle,
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("presentation-election"),
    election: VoiceRuntimePresentationElection,
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("presentation-action"),
    action: VoiceRuntimePresentationAction,
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("operation-terminal"),
    outcome: Schema.Literals(["completed", "stopped", "interrupted", "failed", "cancelled"]),
  }),
  Schema.Struct({
    ...VoiceRuntimeEventBase,
    kind: Schema.Literal("failure"),
    failure: VoiceRuntimeFailure,
  }),
]);
export type VoiceRuntimeEvent = typeof VoiceRuntimeEvent.Type;

const VoiceRuntimeRealtimeFence = {
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  generation: PositiveInt,
  modeSessionId: VoiceModeSessionId,
};

const VoiceRuntimeRealtimeLeaseFence = {
  ...VoiceRuntimeRealtimeFence,
  leaseGeneration: PositiveInt,
};

export const VoiceRuntimeRealtimeSessionCreateInput = Schema.Struct({
  ...VoiceRuntimeRealtimeFence,
  clientOperationId: RuntimeIdentifier,
});
export type VoiceRuntimeRealtimeSessionCreateInput =
  typeof VoiceRuntimeRealtimeSessionCreateInput.Type;

export const VoiceRuntimeRealtimeSessionCreateResult = Schema.Struct({
  state: VoiceSessionState,
  transport: Schema.Struct({
    kind: Schema.Literal("webrtc-sdp-v1"),
    signalingPath: TrimmedNonEmptyString,
  }),
  expiresAt: IsoDateTime,
  heartbeatIntervalSeconds: PositiveInt,
  controlGrant: VoiceRuntimeControlGrant,
});
export type VoiceRuntimeRealtimeSessionCreateResult =
  typeof VoiceRuntimeRealtimeSessionCreateResult.Type;

export const VoiceRuntimeRealtimeWebRtcOfferInput = Schema.Struct({
  ...VoiceRuntimeRealtimeLeaseFence,
  clientOperationId: RuntimeIdentifier,
  sdp: Schema.String.check(Schema.isPattern(/\S/)),
});
export type VoiceRuntimeRealtimeWebRtcOfferInput = typeof VoiceRuntimeRealtimeWebRtcOfferInput.Type;

export const VoiceRuntimeRealtimeWebRtcAnswer = Schema.Struct({
  sessionId: VoiceSessionId,
  leaseGeneration: PositiveInt,
  sdp: Schema.String.check(Schema.isPattern(/\S/)),
  replayed: Schema.Boolean,
});
export type VoiceRuntimeRealtimeWebRtcAnswer = typeof VoiceRuntimeRealtimeWebRtcAnswer.Type;

export const VoiceRuntimeRealtimeHeartbeatInput = Schema.Struct({
  ...VoiceRuntimeRealtimeLeaseFence,
});
export type VoiceRuntimeRealtimeHeartbeatInput = typeof VoiceRuntimeRealtimeHeartbeatInput.Type;

export const VoiceRuntimeRealtimeHeartbeatResult = Schema.Struct({
  state: VoiceSessionState,
  disposition: Schema.Literals(["live", "terminal"]),
  handoffPending: Schema.Boolean,
  expiresAt: IsoDateTime,
});
export type VoiceRuntimeRealtimeHeartbeatResult = typeof VoiceRuntimeRealtimeHeartbeatResult.Type;

export const VoiceRuntimeRealtimeActionsQuery = Schema.Struct({
  ...VoiceRuntimeRealtimeLeaseFence,
  afterSequence: NonNegativeInt,
  waitMilliseconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25_000 })),
});
export type VoiceRuntimeRealtimeActionsQuery = typeof VoiceRuntimeRealtimeActionsQuery.Type;

const VoiceRuntimeRealtimeActionBase = {
  sequence: PositiveInt,
  occurredAt: IsoDateTime,
};

export const VoiceRuntimeRealtimeAction = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeRealtimeActionBase,
    type: Schema.Literal("navigate-thread"),
    actionId: VoiceClientActionId,
    projectId: ProjectId,
    threadId: ThreadId,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    ...VoiceRuntimeRealtimeActionBase,
    type: Schema.Literal("handoff-to-thread-voice"),
    actionId: VoiceClientActionId,
    projectId: ProjectId,
    threadId: ThreadId,
    autoRearm: Schema.Boolean,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    ...VoiceRuntimeRealtimeActionBase,
    type: Schema.Literal("stop-realtime-voice"),
  }),
  Schema.Struct({
    ...VoiceRuntimeRealtimeActionBase,
    type: Schema.Literal("confirmation-required"),
    actionId: VoiceClientActionId,
    confirmationId: VoiceConfirmationId,
    toolCallId: VoiceToolCallId,
    tool: VoiceToolName,
    summary: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
    expiresAt: IsoDateTime,
  }),
]);
export type VoiceRuntimeRealtimeAction = typeof VoiceRuntimeRealtimeAction.Type;

export const VoiceRuntimeRealtimeActionsResult = Schema.Struct({
  state: VoiceSessionState,
  actions: Schema.Array(VoiceRuntimeRealtimeAction).check(Schema.isMaxLength(100)),
});
export type VoiceRuntimeRealtimeActionsResult = typeof VoiceRuntimeRealtimeActionsResult.Type;

export const VoiceRuntimeRealtimeActionAckInput = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeRealtimeLeaseFence,
    clientOperationId: RuntimeIdentifier,
    actionSequence: PositiveInt,
    action: Schema.Literal("navigate-thread"),
    outcome: Schema.Literals(["succeeded", "failed"]),
    message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  }),
  Schema.Struct({
    ...VoiceRuntimeRealtimeLeaseFence,
    clientOperationId: RuntimeIdentifier,
    actionSequence: PositiveInt,
    action: Schema.Literal("confirmation-required"),
    confirmationId: VoiceConfirmationId,
    decision: Schema.Literals(["approve", "reject"]),
  }),
]);
export type VoiceRuntimeRealtimeActionAckInput = typeof VoiceRuntimeRealtimeActionAckInput.Type;

export const VoiceRuntimeRealtimeActionAckResult = Schema.Struct({
  actionId: VoiceClientActionId,
  actionSequence: PositiveInt,
  outcome: Schema.Literals(["succeeded", "failed"]),
  replayed: Schema.Boolean,
});
export type VoiceRuntimeRealtimeActionAckResult = typeof VoiceRuntimeRealtimeActionAckResult.Type;

export const VoiceRuntimeRealtimeFocusInput = Schema.Struct({
  ...VoiceRuntimeRealtimeLeaseFence,
  clientOperationId: RuntimeIdentifier,
  focus: Schema.NullOr(
    Schema.Struct({
      projectId: ProjectId,
      threadId: Schema.NullOr(ThreadId),
    }),
  ),
});
export type VoiceRuntimeRealtimeFocusInput = typeof VoiceRuntimeRealtimeFocusInput.Type;

export const VoiceRuntimeRealtimeFocusResult = Schema.Struct({
  state: VoiceSessionState,
  focus: Schema.NullOr(
    Schema.Struct({
      projectId: ProjectId,
      threadId: Schema.NullOr(ThreadId),
    }),
  ),
  replayed: Schema.Boolean,
});
export type VoiceRuntimeRealtimeFocusResult = typeof VoiceRuntimeRealtimeFocusResult.Type;

export const VoiceRuntimeRealtimeHandoffExchangeInput = Schema.Struct({
  ...VoiceRuntimeRealtimeLeaseFence,
  clientOperationId: RuntimeIdentifier,
  actionSequence: PositiveInt,
  nextGeneration: PositiveInt,
  threadModeSessionId: VoiceModeSessionId,
  environmentId: EnvironmentId,
  speechPreset: VoiceSpeechPreset,
  endpointPolicy: VoiceRuntimeEndpointPolicy,
  speechEnabled: Schema.Boolean,
  rearmGuardMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })),
});
export type VoiceRuntimeRealtimeHandoffExchangeInput =
  typeof VoiceRuntimeRealtimeHandoffExchangeInput.Type;

export const VoiceRuntimeRealtimeHandoffExchangeResult = Schema.Struct({
  actionId: VoiceClientActionId,
  actionSequence: PositiveInt,
  projectId: ProjectId,
  threadId: ThreadId,
  autoRearm: Schema.Boolean,
  transitionGrant: Schema.Struct({
    token: RuntimeToken,
    expiresAt: IsoDateTime,
    generation: PositiveInt,
    modeSessionId: VoiceModeSessionId,
    target: VoiceThreadRuntimeTarget,
  }),
  replayed: Schema.Boolean,
});
export type VoiceRuntimeRealtimeHandoffExchangeResult =
  typeof VoiceRuntimeRealtimeHandoffExchangeResult.Type;

export const VoiceRuntimeRealtimeHandoffCommitInput = Schema.Struct({
  ...VoiceRuntimeRealtimeLeaseFence,
  actionSequence: PositiveInt,
  nextGeneration: PositiveInt,
  threadModeSessionId: VoiceModeSessionId,
});
export type VoiceRuntimeRealtimeHandoffCommitInput =
  typeof VoiceRuntimeRealtimeHandoffCommitInput.Type;

export const VoiceRuntimeRealtimeHandoffCommitResult = Schema.Struct({
  actionId: VoiceClientActionId,
  actionSequence: PositiveInt,
  committed: Schema.Literal(true),
  replayed: Schema.Boolean,
});
export type VoiceRuntimeRealtimeHandoffCommitResult =
  typeof VoiceRuntimeRealtimeHandoffCommitResult.Type;

export const VoiceRuntimeRealtimeCloseInput = Schema.Struct({
  ...VoiceRuntimeRealtimeLeaseFence,
  clientOperationId: RuntimeIdentifier,
});
export type VoiceRuntimeRealtimeCloseInput = typeof VoiceRuntimeRealtimeCloseInput.Type;

export const VoiceRuntimeRealtimeCloseResult = Schema.Struct({
  state: VoiceSessionState,
  closed: Schema.Boolean,
  replayed: Schema.Boolean,
});
export type VoiceRuntimeRealtimeCloseResult = typeof VoiceRuntimeRealtimeCloseResult.Type;

export const VoiceRuntimeThreadTurnCreateInput = Schema.Struct({
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  generation: PositiveInt,
  modeSessionId: VoiceModeSessionId,
  turnClientOperationId: VoiceTurnClientOperationId,
  submissionPolicy: Schema.Literals(["auto-submit", "draft"]),
  speechPlanId: VoiceSpeechPlanId,
});
export type VoiceRuntimeThreadTurnCreateInput = typeof VoiceRuntimeThreadTurnCreateInput.Type;

export const VoiceRuntimeThreadTurnPhase = Schema.Literals([
  "created",
  "transcribing",
  "dispatching",
  "waiting",
  "speaking",
  "attention-required",
  "draft-ready",
  "completed",
  "failed",
  "cancelled",
]);
export type VoiceRuntimeThreadTurnPhase = typeof VoiceRuntimeThreadTurnPhase.Type;

export const VoiceRuntimeThreadTurnSnapshot = Schema.Struct({
  operationId: VoiceThreadTurnOperationId,
  runtimeId: VoiceRuntimeId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  generation: PositiveInt,
  modeSessionId: VoiceModeSessionId,
  turnClientOperationId: VoiceTurnClientOperationId,
  submissionPolicy: Schema.Literals(["auto-submit", "draft"]),
  speechPlanId: VoiceSpeechPlanId,
  projectId: ProjectId,
  threadId: ThreadId,
  speechPreset: VoiceSpeechPreset,
  autoRearm: Schema.Boolean,
  phase: VoiceRuntimeThreadTurnPhase,
  userMessageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  assistantMessageIds: Schema.Array(MessageId).check(Schema.isMaxLength(256)),
  highestAdvertisedSegment: Schema.NullOr(NonNegativeInt),
  highestStartedSegment: Schema.NullOr(NonNegativeInt),
  highestDrainedSegment: Schema.NullOr(NonNegativeInt),
  segmentDispositions: Schema.Array(VoiceSpeechSegmentDisposition).check(Schema.isMaxLength(512)),
  lastSequence: NonNegativeInt,
  acknowledgedSequence: NonNegativeInt,
  speechTerminal: Schema.NullOr(Schema.Literals(["completed", "no-speech", "failed"])),
  dispatchAccepted: Schema.Boolean,
  detachedAt: Schema.NullOr(IsoDateTime),
  operationTokenExpiresAt: IsoDateTime,
  retentionExpiresAt: IsoDateTime,
});
export type VoiceRuntimeThreadTurnSnapshot = typeof VoiceRuntimeThreadTurnSnapshot.Type;

export const VoiceRuntimeThreadTurnCreateResult = Schema.Struct({
  snapshot: VoiceRuntimeThreadTurnSnapshot,
  operationGrant: Schema.Struct({
    token: RuntimeToken,
    expiresAt: IsoDateTime,
  }),
});
export type VoiceRuntimeThreadTurnCreateResult = typeof VoiceRuntimeThreadTurnCreateResult.Type;

export const VoiceRuntimeThreadTurnAudioResult = Schema.Union([
  Schema.Struct({
    snapshot: VoiceRuntimeThreadTurnSnapshot,
    disposition: Schema.Literals(["processing", "already-dispatched", "terminal"]),
  }),
  Schema.Struct({
    snapshot: VoiceRuntimeThreadTurnSnapshot,
    disposition: Schema.Literal("draft-ready"),
  }),
]);
export type VoiceRuntimeThreadTurnAudioResult = typeof VoiceRuntimeThreadTurnAudioResult.Type;

export const VoiceRuntimeThreadTurnDispositionInput = Schema.Struct({
  submissionPolicy: Schema.Literal("draft"),
});
export type VoiceRuntimeThreadTurnDispositionInput =
  typeof VoiceRuntimeThreadTurnDispositionInput.Type;

export const VoiceRuntimeThreadTurnDispositionResult = Schema.Struct({
  snapshot: VoiceRuntimeThreadTurnSnapshot,
});
export type VoiceRuntimeThreadTurnDispositionResult =
  typeof VoiceRuntimeThreadTurnDispositionResult.Type;

const VoiceRuntimeThreadTurnEventBase = {
  sequence: PositiveInt,
  occurredAt: IsoDateTime,
};
export const VoiceRuntimeThreadTurnEvent = Schema.Union([
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("phase"),
    phase: VoiceRuntimeThreadTurnPhase,
  }),
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("dispatch-correlation"),
    commandId: TrimmedNonEmptyString.check(Schema.isMaxLength(192)),
    messageId: MessageId,
    turnId: Schema.NullOr(TurnId),
  }),
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("assistant-message-correlated"),
    messageId: MessageId,
  }),
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("speech-ready"),
    segmentIndex: NonNegativeInt,
    finalSegment: Schema.Boolean,
  }),
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("speech-terminal"),
    outcome: Schema.Literals(["completed", "no-speech", "failed"]),
  }),
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("attention-required"),
    attention: Schema.Literals(["approval", "user-input"]),
  }),
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("failure"),
    code: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    retryable: Schema.Boolean,
  }),
  Schema.Struct({
    ...VoiceRuntimeThreadTurnEventBase,
    type: Schema.Literal("terminal"),
    outcome: Schema.Literals(["completed", "failed", "cancelled"]),
  }),
]);
export type VoiceRuntimeThreadTurnEvent = typeof VoiceRuntimeThreadTurnEvent.Type;

export const VoiceRuntimeThreadTurnEventsQuery = Schema.Struct({
  afterSequence: NonNegativeInt,
  waitMilliseconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 })),
});
export type VoiceRuntimeThreadTurnEventsQuery = typeof VoiceRuntimeThreadTurnEventsQuery.Type;

export const VoiceRuntimeThreadTurnEventsResult = Schema.Struct({
  snapshot: VoiceRuntimeThreadTurnSnapshot,
  events: Schema.Array(VoiceRuntimeThreadTurnEvent).check(Schema.isMaxLength(100)),
});
export type VoiceRuntimeThreadTurnEventsResult = typeof VoiceRuntimeThreadTurnEventsResult.Type;

export const VoiceRuntimeThreadTurnEventsAckInput = Schema.Struct({
  acknowledgedSequence: NonNegativeInt,
  speechPlanId: VoiceSpeechPlanId,
  highestStartedSegment: Schema.NullOr(NonNegativeInt),
  highestDrainedSegment: Schema.NullOr(NonNegativeInt),
  segmentDispositions: Schema.Array(VoiceSpeechSegmentDisposition).check(Schema.isMaxLength(512)),
});
export type VoiceRuntimeThreadTurnEventsAckInput = typeof VoiceRuntimeThreadTurnEventsAckInput.Type;

export const VoiceRuntimeThreadTurnCancelInput = Schema.Struct({
  reason: Schema.Literal("user-request"),
});
export type VoiceRuntimeThreadTurnCancelInput = typeof VoiceRuntimeThreadTurnCancelInput.Type;

export const VoiceRuntimeThreadTurnCancelResult = Schema.Struct({
  snapshot: VoiceRuntimeThreadTurnSnapshot,
  cancelled: Schema.Boolean,
});
export type VoiceRuntimeThreadTurnCancelResult = typeof VoiceRuntimeThreadTurnCancelResult.Type;

export const VoiceRuntimeThreadDraft = Schema.Struct({
  operationId: VoiceThreadTurnOperationId,
  transcript: Schema.String.check(Schema.isMaxLength(128 * 1024)),
  expiresAt: IsoDateTime,
});
export type VoiceRuntimeThreadDraft = typeof VoiceRuntimeThreadDraft.Type;

export const VoiceRuntimeThreadDraftConsumeResult = Schema.Struct({
  snapshot: VoiceRuntimeThreadTurnSnapshot,
  consumed: Schema.Boolean,
});
export type VoiceRuntimeThreadDraftConsumeResult = typeof VoiceRuntimeThreadDraftConsumeResult.Type;

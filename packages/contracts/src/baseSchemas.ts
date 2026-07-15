import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.pipe(Schema.brand(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;
export const VoiceConversationId = makeEntityId("VoiceConversationId");
export type VoiceConversationId = typeof VoiceConversationId.Type;
export const VoiceConversationEntryId = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)).pipe(
  Schema.brand("VoiceConversationEntryId"),
);
export type VoiceConversationEntryId = typeof VoiceConversationEntryId.Type;

export const VoiceRuntimeId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VoiceRuntimeId"),
);
export type VoiceRuntimeId = typeof VoiceRuntimeId.Type;
export const VoiceRuntimeInstanceId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VoiceRuntimeInstanceId"),
);
export type VoiceRuntimeInstanceId = typeof VoiceRuntimeInstanceId.Type;
export const VoiceRuntimeCommandId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VoiceRuntimeCommandId"),
);
export type VoiceRuntimeCommandId = typeof VoiceRuntimeCommandId.Type;
export const VoiceModeSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VoiceModeSessionId"),
);
export type VoiceModeSessionId = typeof VoiceModeSessionId.Type;
export const VoiceTurnClientOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(192)).pipe(
  Schema.brand("VoiceTurnClientOperationId"),
);
export type VoiceTurnClientOperationId = typeof VoiceTurnClientOperationId.Type;
export const VoiceThreadTurnOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(192)).pipe(
  Schema.brand("VoiceThreadTurnOperationId"),
);
export type VoiceThreadTurnOperationId = typeof VoiceThreadTurnOperationId.Type;
export const VoiceRuntimeConsumerLeaseId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
).pipe(Schema.brand("VoiceRuntimeConsumerLeaseId"));
export type VoiceRuntimeConsumerLeaseId = typeof VoiceRuntimeConsumerLeaseId.Type;
export const VoiceComposerCaptureOperationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
).pipe(Schema.brand("VoiceComposerCaptureOperationId"));
export type VoiceComposerCaptureOperationId = typeof VoiceComposerCaptureOperationId.Type;
export const VoiceManualPlaybackOperationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
).pipe(Schema.brand("VoiceManualPlaybackOperationId"));
export type VoiceManualPlaybackOperationId = typeof VoiceManualPlaybackOperationId.Type;
export const VoiceDraftArtifactId = TrimmedNonEmptyString.check(Schema.isMaxLength(192)).pipe(
  Schema.brand("VoiceDraftArtifactId"),
);
export type VoiceDraftArtifactId = typeof VoiceDraftArtifactId.Type;
export const VoiceSpeechPlanId = TrimmedNonEmptyString.check(Schema.isMaxLength(192)).pipe(
  Schema.brand("VoiceSpeechPlanId"),
);
export type VoiceSpeechPlanId = typeof VoiceSpeechPlanId.Type;
export const VoiceSessionId = makeEntityId("VoiceSessionId");
export type VoiceSessionId = typeof VoiceSessionId.Type;
export const VoiceRequestId = makeEntityId("VoiceRequestId");
export type VoiceRequestId = typeof VoiceRequestId.Type;
export const VoicePlaybackId = makeEntityId("VoicePlaybackId");
export type VoicePlaybackId = typeof VoicePlaybackId.Type;
export const VoiceToolCallId = makeEntityId("VoiceToolCallId");
export type VoiceToolCallId = typeof VoiceToolCallId.Type;
export const VoiceConfirmationId = makeEntityId("VoiceConfirmationId");
export type VoiceConfirmationId = typeof VoiceConfirmationId.Type;
export const VoiceClientActionId = makeEntityId("VoiceClientActionId");
export type VoiceClientActionId = typeof VoiceClientActionId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;

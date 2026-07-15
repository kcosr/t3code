import type {
  VoiceCommandReceipt,
  VoiceDraftArtifact,
  VoiceDraftArtifactAcknowledgement,
  VoiceDraftArtifactRead,
  VoiceRuntimeAttachRequest,
  VoiceRuntimeAttachmentUpdate,
  VoiceRuntimeAuthorityClearCommand,
  VoiceRuntimeAuthorityReservation,
  VoiceRuntimeConsumerLease,
  VoiceRuntimeCursor,
  VoiceRuntimeDescriptor,
  VoiceRuntimeEvent,
  VoiceRuntimePresentationAction,
  VoiceRuntimePresentationActionAcknowledgement,
  VoiceRuntimePresentationActionClaim,
  VoiceRuntimeRebase,
  VoiceRuntimeSnapshot,
  VoiceRuntimeCommand,
} from "@t3tools/contracts";

export interface VoiceRuntimeSubscriptionInput {
  readonly lease: VoiceRuntimeConsumerLease;
  readonly after: VoiceRuntimeCursor | null;
}

export type VoiceRuntimeDelivery = VoiceRuntimeEvent | VoiceRuntimeRebase;

export interface VoiceRuntime {
  readonly describe: () => Promise<VoiceRuntimeDescriptor>;
  readonly getSnapshot: () => Promise<VoiceRuntimeSnapshot>;
  readonly attach: (input: VoiceRuntimeAttachRequest) => Promise<VoiceRuntimeConsumerLease>;
  readonly updateAttachment: (
    input: VoiceRuntimeAttachmentUpdate,
  ) => Promise<VoiceRuntimeConsumerLease>;
  readonly detach: (lease: VoiceRuntimeConsumerLease) => Promise<void>;
  readonly subscribe: (
    input: VoiceRuntimeSubscriptionInput,
    listener: (delivery: VoiceRuntimeDelivery) => void,
  ) => () => void;
  readonly acknowledge: (input: {
    readonly lease: VoiceRuntimeConsumerLease;
    readonly through: VoiceRuntimeCursor;
  }) => Promise<void>;
  readonly configureAuthority: (
    input: VoiceRuntimeAuthorityReservation,
  ) => Promise<VoiceRuntimeSnapshot>;
  readonly clearAuthority: (
    input: VoiceRuntimeAuthorityClearCommand,
  ) => Promise<VoiceRuntimeSnapshot>;
  readonly dispatch: (command: VoiceRuntimeCommand) => Promise<VoiceCommandReceipt>;
  readonly readDraftArtifact: (input: VoiceDraftArtifactRead) => Promise<VoiceDraftArtifact>;
  readonly acknowledgeDraftArtifact: (input: VoiceDraftArtifactAcknowledgement) => Promise<void>;
  readonly claimPresentationAction: (
    input: VoiceRuntimePresentationActionClaim,
  ) => Promise<VoiceRuntimePresentationAction>;
  readonly acknowledgePresentationAction: (
    input: VoiceRuntimePresentationActionAcknowledgement,
  ) => Promise<void>;
}

export interface VoiceRuntimeFactory {
  readonly create: () => Promise<VoiceRuntime> | VoiceRuntime;
}

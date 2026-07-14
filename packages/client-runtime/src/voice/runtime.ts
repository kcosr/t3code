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
  VoiceRuntimeTarget,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export async function computeVoiceRuntimeTargetDigest(target: VoiceRuntimeTarget): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(target)));
  return [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

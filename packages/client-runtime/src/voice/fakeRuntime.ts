import {
  VoiceRuntimeConsumerLeaseId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  type VoiceCommandReceipt,
  type VoiceDraftArtifact,
  type VoiceDraftArtifactAcknowledgement,
  type VoiceDraftArtifactHandle,
  type VoiceDraftArtifactRead,
  type VoiceRealtimeTerminalSummary,
  type VoiceRuntimeAttachRequest,
  type VoiceRuntimeAttachmentUpdate,
  type VoiceRuntimeAuthorityClearCommand,
  type VoiceRuntimeAuthorityReservation,
  type VoiceRuntimeCommand,
  type VoiceRuntimeCommandId,
  type VoiceRuntimeCommandRejectionReason,
  type VoiceRuntimeConsumerLease,
  type VoiceRuntimeCursor,
  type VoiceRuntimeDescriptor,
  type VoiceRuntimeEvent,
  type VoiceRuntimePresentationElection,
  type VoiceRuntimePresentationAction,
  type VoiceRuntimePresentationActionAcknowledgement,
  type VoiceRuntimePresentationActionClaim,
  type VoiceRuntimeRebase,
  type VoiceRuntimeRootOperation,
  type VoiceRuntimeSnapshot,
  type VoiceThreadTurnReceipt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type {
  VoiceRuntime,
  VoiceRuntimeDelivery,
  VoiceRuntimeSubscriptionInput,
} from "./runtime.ts";
import { computeVoiceRuntimeTargetDigest } from "./runtime.ts";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_JOURNAL_CAPACITY = 128;
const DEFAULT_IDEMPOTENCY_CAPACITY = 512;

export class FakeVoiceRuntimeLeaseError extends Error {}
export class FakeVoiceRuntimeAuthorityError extends Error {}
export class FakeVoiceRuntimeDraftArtifactError extends Error {}
export class FakeVoiceRuntimePresentationActionError extends Error {}

export interface FakeVoiceRuntimeOptions {
  readonly runtimeId?: VoiceRuntimeId;
  readonly runtimeInstanceId?: VoiceRuntimeInstanceId;
  readonly descriptor?: VoiceRuntimeDescriptor;
  readonly now?: () => number;
  readonly journalCapacity?: number;
  readonly leaseDurationMs?: number;
}

interface StoredCommand {
  readonly fingerprint: string;
  readonly receipt: VoiceCommandReceipt;
}

interface StoredOperationStart {
  readonly fingerprint: string;
  readonly receipt: VoiceCommandReceipt;
}

interface StoredSnapshotOutcome {
  readonly fingerprint: string;
  readonly snapshot: VoiceRuntimeSnapshot;
}

interface StoredDraftArtifact {
  readonly artifact: VoiceDraftArtifact;
  consumed: boolean;
}

interface StoredPresentationAction {
  readonly action: VoiceRuntimePresentationAction;
  claimedBy: { readonly leaseId: string; readonly leaseGeneration: number } | null;
  acknowledged: boolean;
}

interface Subscriber {
  readonly leaseId: string;
  readonly listener: (delivery: VoiceRuntimeDelivery) => void;
}

const defaultDescriptor = (): VoiceRuntimeDescriptor => ({
  protocolMajor: 1,
  executionModel: "autonomous",
  capabilities: {
    automaticEndpointing: true,
    recordingFormats: ["audio/mp4"],
    playbackFormats: [{ encoding: "pcm-s16le", sampleRates: [24_000], channelCounts: [1] }],
    realtimeWebRtc: true,
    persistentReadiness: true,
    notificationControl: true,
    headsetControl: true,
    inputRouteSelection: true,
    outputRouteSelection: true,
  },
});

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

const fingerprint = (command: VoiceRuntimeCommand): string => {
  const { commandId: _commandId, ...request } = command;
  return JSON.stringify(canonicalValue(request));
};

const provisioningFingerprint = (reservation: VoiceRuntimeAuthorityReservation): string => {
  const { provisioningOperationId: _provisioningOperationId, ...request } = reservation;
  return JSON.stringify(canonicalValue(request));
};

const clearFingerprint = (command: VoiceRuntimeAuthorityClearCommand): string => {
  const { commandId: _commandId, ...request } = command;
  return JSON.stringify(canonicalValue(request));
};

function rootForCommand(command: VoiceRuntimeCommand): VoiceRuntimeRootOperation {
  switch (command.kind) {
    case "start-realtime":
    case "start-thread-mode":
    case "resume-thread-mode":
    case "stop-mode":
    case "set-realtime-muted":
    case "set-audio-route":
    case "update-realtime-focus":
    case "decide-realtime-confirmation":
      return { kind: "mode", modeSessionId: command.modeSessionId };
    case "finish-thread-turn":
    case "cancel-thread-turn":
      return {
        kind: "turn",
        modeSessionId: command.modeSessionId,
        turnClientOperationId: command.turnClientOperationId,
        turnOperationId: null,
      };
  }
}

function startIdentity(command: VoiceRuntimeCommand): string | null {
  switch (command.kind) {
    case "start-realtime":
    case "start-thread-mode":
      return `mode:${command.modeSessionId}`;
    default:
      return null;
  }
}

export class FakeVoiceRuntime implements VoiceRuntime {
  private readonly descriptor: VoiceRuntimeDescriptor;
  private readonly now: () => number;
  private readonly journalCapacity: number;
  private readonly leaseDurationMs: number;
  private snapshot: VoiceRuntimeSnapshot;
  private readonly consumers = new Map<string, VoiceRuntimeConsumerLease>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly acknowledgements = new Map<string, number>();
  private readonly journal: Array<VoiceRuntimeEvent> = [];
  private readonly commands = new Map<string, StoredCommand>();
  private readonly operationStarts = new Map<string, StoredOperationStart>();
  private readonly provisioningOperations = new Map<string, StoredSnapshotOutcome>();
  private readonly authorityClears = new Map<string, StoredSnapshotOutcome>();
  private readonly threadReceipts: Array<VoiceThreadTurnReceipt> = [];
  private readonly realtimeSummaries: Array<VoiceRealtimeTerminalSummary> = [];
  private readonly draftArtifacts = new Map<string, StoredDraftArtifact>();
  private readonly presentationActions = new Map<string, StoredPresentationAction>();
  private attachOrdinal = 0;
  private nextLeaseId = 0;
  private authority: VoiceRuntimeAuthorityReservation | null = null;

  constructor(options: FakeVoiceRuntimeOptions = {}) {
    this.descriptor = options.descriptor ?? defaultDescriptor();
    this.now = options.now ?? Date.now;
    this.journalCapacity = options.journalCapacity ?? DEFAULT_JOURNAL_CAPACITY;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    const runtimeId = options.runtimeId ?? VoiceRuntimeId.make("fake-voice-runtime");
    const runtimeInstanceId =
      options.runtimeInstanceId ?? VoiceRuntimeInstanceId.make("fake-voice-runtime-instance");
    this.snapshot = {
      runtimeId,
      runtimeInstanceId,
      generation: 0,
      sequence: 0,
      availability: "locked",
      target: null,
      operation: { kind: "none" },
      mediaOwner: { kind: "none" },
      readiness: { state: "disabled" },
      route: { inputRouteId: null, outputRouteId: null },
      failure: null,
    };
  }

  async describe(): Promise<VoiceRuntimeDescriptor> {
    return this.descriptor;
  }

  async getSnapshot(): Promise<VoiceRuntimeSnapshot> {
    return this.snapshot;
  }

  async attach(input: VoiceRuntimeAttachRequest): Promise<VoiceRuntimeConsumerLease> {
    this.requireRuntimeFence(input.runtimeId, input.runtimeInstanceId, input.generation);
    this.expireConsumers();
    this.attachOrdinal += 1;
    this.nextLeaseId += 1;
    const lease: VoiceRuntimeConsumerLease = {
      leaseId: VoiceRuntimeConsumerLeaseId.make(`fake-consumer-${this.nextLeaseId}`),
      runtimeId: this.snapshot.runtimeId,
      runtimeInstanceId: this.snapshot.runtimeInstanceId,
      generation: this.snapshot.generation,
      leaseGeneration: 1,
      attachOrdinal: this.attachOrdinal,
      presentation: input.presentation,
      election: "standby",
      expiresAt: this.isoNow(this.leaseDurationMs),
    };
    this.consumers.set(lease.leaseId, lease);
    this.recomputeElection();
    return this.requireStoredLease(lease);
  }

  async updateAttachment(input: VoiceRuntimeAttachmentUpdate): Promise<VoiceRuntimeConsumerLease> {
    const current = this.requireStoredLease(input.lease);
    this.releasePresentationClaims(current.leaseId);
    const next: VoiceRuntimeConsumerLease = {
      ...current,
      leaseGeneration: current.leaseGeneration + 1,
      presentation: input.presentation,
      expiresAt: this.isoNow(this.leaseDurationMs),
    };
    this.consumers.set(next.leaseId, next);
    this.recomputeElection();
    return this.requireStoredLease(next);
  }

  async detach(lease: VoiceRuntimeConsumerLease): Promise<void> {
    this.requireStoredLease(lease);
    this.consumers.delete(lease.leaseId);
    for (const subscriber of this.subscribers) {
      if (subscriber.leaseId === lease.leaseId) this.subscribers.delete(subscriber);
    }
    this.acknowledgements.delete(lease.leaseId);
    this.releasePresentationClaims(lease.leaseId);
    this.recomputeElection();
  }

  subscribe(
    input: VoiceRuntimeSubscriptionInput,
    listener: (delivery: VoiceRuntimeDelivery) => void,
  ): () => void {
    const lease = this.requireStoredLease(input.lease);
    const subscriber: Subscriber = { leaseId: lease.leaseId, listener };
    this.subscribers.add(subscriber);

    const after = input.after;
    if (after === null) {
      listener(this.rebase("cursor-too-old"));
    } else if (
      after.runtimeId !== this.snapshot.runtimeId ||
      after.runtimeInstanceId !== this.snapshot.runtimeInstanceId
    ) {
      listener(this.rebase("runtime-replaced"));
    } else if (after.generation !== this.snapshot.generation) {
      listener(this.rebase("generation-changed"));
    } else {
      const oldestSequence = this.journal[0]?.sequence ?? this.snapshot.sequence + 1;
      if (after.sequence > this.snapshot.sequence || after.sequence < oldestSequence - 1) {
        listener(this.rebase("cursor-too-old"));
      } else {
        for (const event of this.journal) {
          if (event.sequence > after.sequence) listener(event);
        }
      }
    }

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  async acknowledge(input: {
    readonly lease: VoiceRuntimeConsumerLease;
    readonly through: VoiceRuntimeCursor;
  }): Promise<void> {
    const lease = this.requireStoredLease(input.lease);
    const cursor = input.through;
    this.requireRuntimeFence(cursor.runtimeId, cursor.runtimeInstanceId, cursor.generation);
    if (cursor.sequence > this.snapshot.sequence) {
      throw new FakeVoiceRuntimeLeaseError(
        "Cannot acknowledge an event that has not been published",
      );
    }
    const previous = this.acknowledgements.get(lease.leaseId) ?? 0;
    this.acknowledgements.set(lease.leaseId, Math.max(previous, cursor.sequence));
  }

  async configureAuthority(input: VoiceRuntimeAuthorityReservation): Promise<VoiceRuntimeSnapshot> {
    const requestFingerprint = provisioningFingerprint(input);
    const previous = this.provisioningOperations.get(input.provisioningOperationId);
    if (previous !== undefined) {
      if (previous.fingerprint !== requestFingerprint) {
        throw new FakeVoiceRuntimeAuthorityError("Provisioning operation payload changed");
      }
      return previous.snapshot;
    }
    this.requireRuntimeFence(
      input.runtimeId,
      input.runtimeInstanceId,
      input.expectedCurrentGeneration,
    );
    if (input.generation !== input.expectedCurrentGeneration + 1) {
      throw new FakeVoiceRuntimeAuthorityError("Authority generations must advance exactly once");
    }
    const issuedAt = Date.parse(input.issuedAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > this.now() ||
      expiresAt <= this.now() ||
      expiresAt <= issuedAt
    ) {
      throw new FakeVoiceRuntimeAuthorityError("Authority reservation is not currently valid");
    }
    if ((await computeVoiceRuntimeTargetDigest(input.target)) !== input.targetDigest) {
      throw new FakeVoiceRuntimeAuthorityError("Authority target digest does not match its target");
    }
    if (this.snapshot.operation.kind !== "none") {
      throw new FakeVoiceRuntimeAuthorityError(
        "An active voice operation must stop or drain before authority replacement",
      );
    }
    this.invalidateConsumers();
    this.authority = input;
    this.snapshot = {
      ...this.snapshot,
      generation: input.generation,
      availability: "ready",
      target: input.target,
      readiness: input.readinessEnabled
        ? { state: "ready", mode: input.target.mode }
        : { state: "disabled" },
      failure: null,
    };
    this.publishState();
    this.retainBounded(this.provisioningOperations, input.provisioningOperationId, {
      fingerprint: requestFingerprint,
      snapshot: this.snapshot,
    });
    return this.snapshot;
  }

  async clearAuthority(input: VoiceRuntimeAuthorityClearCommand): Promise<VoiceRuntimeSnapshot> {
    const requestFingerprint = clearFingerprint(input);
    const previous = this.authorityClears.get(input.commandId);
    if (previous !== undefined) {
      if (previous.fingerprint !== requestFingerprint) {
        throw new FakeVoiceRuntimeAuthorityError("Authority clear command payload changed");
      }
      return previous.snapshot;
    }
    this.requireRuntimeFence(input.runtimeId, input.runtimeInstanceId, input.authorityGeneration);
    this.authority = null;
    this.snapshot = {
      ...this.snapshot,
      availability: "locked",
      target: this.snapshot.operation.kind === "none" ? null : this.snapshot.target,
      readiness: { state: "disabled" },
      failure: null,
    };
    this.publishState(input.commandId);
    this.retainBounded(this.authorityClears, input.commandId, {
      fingerprint: requestFingerprint,
      snapshot: this.snapshot,
    });
    return this.snapshot;
  }

  async dispatch(command: VoiceRuntimeCommand): Promise<VoiceCommandReceipt> {
    const requestFingerprint = fingerprint(command);
    const existingCommand = this.commands.get(command.commandId);
    if (existingCommand !== undefined) {
      if (existingCommand.fingerprint !== requestFingerprint) {
        return this.rejectedReceipt(command, "idempotency-conflict");
      }
      return { ...existingCommand.receipt, replayed: true };
    }

    this.expireAuthority();

    const fenceRebase = this.commandFenceRebase(command);
    if (fenceRebase !== null) {
      return {
        commandId: command.commandId,
        root: rootForCommand(command),
        replayed: false,
        outcome: { type: "rebase-required", rebase: fenceRebase },
        cursor: fenceRebase.cursor,
      };
    }

    const identity = startIdentity(command);
    if (identity !== null) {
      const existingStart = this.operationStarts.get(identity);
      if (existingStart !== undefined) {
        if (existingStart.fingerprint !== requestFingerprint) {
          return this.rejectedReceipt(command, "idempotency-conflict");
        }
        const replayed = {
          ...existingStart.receipt,
          commandId: command.commandId,
          replayed: true,
        } satisfies VoiceCommandReceipt;
        this.retainBounded(this.commands, command.commandId, {
          fingerprint: requestFingerprint,
          receipt: replayed,
        });
        return replayed;
      }
    }

    const rejection = this.applyCommand(command);
    if (rejection !== null) {
      const receipt = this.rejectedReceipt(command, rejection);
      this.retainBounded(this.commands, command.commandId, {
        fingerprint: requestFingerprint,
        receipt,
      });
      return receipt;
    }

    const receipt = this.publishCommandReceipt(command);
    const stored = { fingerprint: requestFingerprint, receipt };
    this.retainBounded(this.commands, command.commandId, stored);
    if (identity !== null) this.retainBounded(this.operationStarts, identity, stored);
    return receipt;
  }

  async readDraftArtifact(input: VoiceDraftArtifactRead): Promise<VoiceDraftArtifact> {
    const lease = this.requireElectedLease(input.lease);
    const stored = this.draftArtifacts.get(input.artifactId);
    if (
      stored === undefined ||
      stored.consumed ||
      Date.parse(stored.artifact.handle.expiresAt) <= this.now()
    ) {
      throw new FakeVoiceRuntimeDraftArtifactError("Draft artifact is not available");
    }
    if (
      stored.artifact.handle.runtimeId !== lease.runtimeId ||
      stored.artifact.handle.runtimeInstanceId !== lease.runtimeInstanceId ||
      stored.artifact.handle.runtimeGeneration !== lease.generation
    ) {
      throw new FakeVoiceRuntimeDraftArtifactError("Draft artifact belongs to another runtime");
    }
    return stored.artifact;
  }

  async acknowledgeDraftArtifact(input: VoiceDraftArtifactAcknowledgement): Promise<void> {
    const lease = this.requireElectedLease(input.lease);
    const stored = this.draftArtifacts.get(input.artifactId);
    if (
      stored === undefined ||
      stored.consumed ||
      Date.parse(stored.artifact.handle.expiresAt) <= this.now()
    ) {
      throw new FakeVoiceRuntimeDraftArtifactError("Draft artifact is not available");
    }
    if (
      stored.artifact.handle.runtimeId !== lease.runtimeId ||
      stored.artifact.handle.runtimeInstanceId !== lease.runtimeInstanceId ||
      stored.artifact.handle.runtimeGeneration !== lease.generation
    ) {
      throw new FakeVoiceRuntimeDraftArtifactError("Draft artifact belongs to another runtime");
    }
    stored.consumed = true;
  }

  async claimPresentationAction(
    input: VoiceRuntimePresentationActionClaim,
  ): Promise<VoiceRuntimePresentationAction> {
    const lease = this.requireElectedLease(input.lease);
    const stored = this.presentationActions.get(input.actionId);
    if (
      stored === undefined ||
      stored.acknowledged ||
      Date.parse(stored.action.expiresAt) <= this.now()
    ) {
      throw new FakeVoiceRuntimePresentationActionError("Presentation action is not available");
    }
    if (
      stored.claimedBy !== null &&
      (stored.claimedBy.leaseId !== lease.leaseId ||
        stored.claimedBy.leaseGeneration !== lease.leaseGeneration)
    ) {
      throw new FakeVoiceRuntimePresentationActionError("Presentation action is already claimed");
    }
    stored.claimedBy = {
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
    };
    return stored.action;
  }

  async acknowledgePresentationAction(
    input: VoiceRuntimePresentationActionAcknowledgement,
  ): Promise<void> {
    const lease = this.requireElectedLease(input.lease);
    const stored = this.requireClaimedPresentationAction(input.actionId, lease);
    if (stored.action.action === "realtime-confirmation-required") {
      throw new FakeVoiceRuntimePresentationActionError(
        "Realtime confirmations must be completed with a decision command",
      );
    }
    stored.acknowledged = true;
  }

  seedThreadReceipt(receipt: VoiceThreadTurnReceipt): void {
    this.threadReceipts.push(receipt);
  }

  seedRealtimeSummary(summary: VoiceRealtimeTerminalSummary): void {
    this.realtimeSummaries.push(summary);
  }

  seedDraftArtifact(handle: VoiceDraftArtifactHandle, transcript: string): void {
    this.draftArtifacts.set(handle.artifactId, {
      artifact: { handle, transcript },
      consumed: false,
    });
  }

  seedPresentationAction(action: VoiceRuntimePresentationAction): void {
    this.presentationActions.set(action.actionId, {
      action,
      claimedBy: null,
      acknowledged: false,
    });
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    this.appendEvent({
      runtimeId: this.snapshot.runtimeId,
      runtimeInstanceId: this.snapshot.runtimeInstanceId,
      authorityGeneration: this.snapshot.generation,
      sequence,
      occurredAt: this.isoNow(),
      root:
        this.snapshot.operation.kind === "realtime" ||
        this.snapshot.operation.kind === "thread-turn"
          ? { kind: "mode", modeSessionId: this.snapshot.operation.modeSessionId }
          : { kind: "none" },
      kind: "presentation-action",
      action,
    });
  }

  private applyCommand(command: VoiceRuntimeCommand): VoiceRuntimeCommandRejectionReason | null {
    const target = this.snapshot.target;
    switch (command.kind) {
      case "start-realtime": {
        if (!this.descriptor.capabilities.realtimeWebRtc) return "unsupported-capability";
        if (!this.hasUsableAuthority("realtime") || target?.mode !== "realtime")
          return "authority-unavailable";
        const replacement = this.prepareReplacement(command, command.interruptionPolicy);
        if (replacement !== null) return replacement;
        this.snapshot = {
          ...this.snapshot,
          operation: {
            kind: "realtime",
            modeSessionId: command.modeSessionId,
            phase: "preparing",
            conversationId: target.conversationId,
            sessionId: null,
            muted: false,
          },
          mediaOwner: { kind: "realtime-peer", modeSessionId: command.modeSessionId },
          readiness: { state: "active", mode: "realtime" },
        };
        return null;
      }
      case "start-thread-mode": {
        if (!this.descriptor.capabilities.automaticEndpointing) return "unsupported-capability";
        if (!this.hasUsableAuthority("thread") || target?.mode !== "thread")
          return "authority-unavailable";
        const replacement = this.prepareReplacement(command, command.interruptionPolicy);
        if (replacement !== null) return replacement;
        this.snapshot = {
          ...this.snapshot,
          operation: {
            kind: "thread-turn",
            modeSessionId: command.modeSessionId,
            phase: { phase: "arming" },
            turnClientOperationId: command.turnClientOperationId,
            turnOperationId: null,
          },
          mediaOwner: {
            kind: "recorder",
            owner: "thread-mode",
            root: rootForCommand(command),
          },
          readiness: { state: "active", mode: "thread" },
        };
        return null;
      }
      case "resume-thread-mode": {
        if (
          this.snapshot.operation.kind !== "thread-turn" ||
          this.snapshot.operation.modeSessionId !== command.modeSessionId
        ) {
          return "invalid-phase";
        }
        this.snapshot = {
          ...this.snapshot,
          operation: {
            ...this.snapshot.operation,
            phase: { phase: "rearming" },
            turnClientOperationId: command.turnClientOperationId,
            turnOperationId: null,
          },
        };
        return null;
      }
      case "finish-thread-turn": {
        const operation = this.snapshot.operation;
        if (
          operation.kind !== "thread-turn" ||
          operation.modeSessionId !== command.modeSessionId ||
          operation.turnClientOperationId !== command.turnClientOperationId
        )
          return "invalid-phase";
        this.snapshot = {
          ...this.snapshot,
          operation: {
            ...operation,
            phase: {
              phase: command.outcome === "finish-to-draft" ? "draft-ready" : "finalizing",
            },
          },
          mediaOwner: { kind: "none" },
        };
        return null;
      }
      case "cancel-thread-turn": {
        if (!this.isMatchingThreadTurn(command.modeSessionId, command.turnClientOperationId))
          return "invalid-phase";
        const root = rootForCommand(command);
        this.snapshot = {
          ...this.snapshot,
          operation: { kind: "none" },
          mediaOwner: { kind: "none" },
          readiness: this.readyReadiness(),
        };
        this.publishTerminal(root, "cancelled", command.commandId);
        return null;
      }
      case "stop-mode": {
        if (
          (this.snapshot.operation.kind !== "realtime" &&
            this.snapshot.operation.kind !== "thread-turn") ||
          this.snapshot.operation.modeSessionId !== command.modeSessionId
        ) {
          return "invalid-phase";
        }
        if (command.policy === "pause-after-turn") {
          if (this.snapshot.operation.kind !== "thread-turn") return "invalid-phase";
          this.snapshot = {
            ...this.snapshot,
            operation: {
              ...this.snapshot.operation,
              phase: { phase: "paused", reason: "user" },
            },
            mediaOwner: { kind: "none" },
            readiness: this.readyReadiness(),
          };
          return null;
        }
        const root = rootForCommand(command);
        if (command.policy === "drain") {
          this.snapshot = {
            ...this.snapshot,
            operation:
              this.snapshot.operation.kind === "realtime"
                ? { ...this.snapshot.operation, phase: "draining" }
                : {
                    ...this.snapshot.operation,
                    phase: { phase: "finalizing" },
                  },
          };
          this.publishState(command.commandId);
        }
        this.snapshot = {
          ...this.snapshot,
          operation: { kind: "none" },
          mediaOwner: { kind: "none" },
          readiness: this.readyReadiness(),
        };
        this.publishTerminal(root, "stopped", command.commandId);
        return null;
      }
      case "set-realtime-muted": {
        if (
          this.snapshot.operation.kind !== "realtime" ||
          this.snapshot.operation.modeSessionId !== command.modeSessionId
        ) {
          return "invalid-phase";
        }
        this.snapshot = {
          ...this.snapshot,
          operation: { ...this.snapshot.operation, muted: command.muted },
        };
        return null;
      }
      case "set-audio-route": {
        if (
          (this.snapshot.operation.kind !== "realtime" &&
            this.snapshot.operation.kind !== "thread-turn") ||
          this.snapshot.operation.modeSessionId !== command.modeSessionId
        ) {
          return "invalid-phase";
        }
        if (
          (command.inputRouteId !== null && !this.descriptor.capabilities.inputRouteSelection) ||
          (command.outputRouteId !== null && !this.descriptor.capabilities.outputRouteSelection)
        ) {
          return "unsupported-capability";
        }
        this.snapshot = {
          ...this.snapshot,
          route: {
            inputRouteId: command.inputRouteId,
            outputRouteId: command.outputRouteId,
          },
        };
        return null;
      }
      case "update-realtime-focus":
        return this.snapshot.operation.kind === "realtime" &&
          this.snapshot.operation.modeSessionId === command.modeSessionId
          ? null
          : "invalid-phase";
      case "decide-realtime-confirmation": {
        if (
          this.snapshot.operation.kind !== "realtime" ||
          this.snapshot.operation.modeSessionId !== command.modeSessionId
        ) {
          return "invalid-phase";
        }
        let lease: VoiceRuntimeConsumerLease;
        try {
          lease = this.requireElectedLease(command.lease);
        } catch {
          return "permission-denied";
        }
        let stored: StoredPresentationAction;
        try {
          stored = this.requireClaimedPresentationAction(command.actionId, lease);
        } catch {
          return "invalid-phase";
        }
        if (
          stored.action.action !== "realtime-confirmation-required" ||
          stored.action.confirmationId !== command.confirmationId
        ) {
          return "invalid-phase";
        }
        stored.acknowledged = true;
        return null;
      }
    }
  }

  private hasUsableAuthority(mode: "realtime" | "thread"): boolean {
    return (
      this.snapshot.availability === "ready" &&
      this.authority !== null &&
      this.authority.generation === this.snapshot.generation &&
      this.authority.target.mode === mode &&
      Date.parse(this.authority.expiresAt) > this.now()
    );
  }

  private prepareReplacement(
    command: VoiceRuntimeCommand,
    policy: "reject" | "stop-conflicting" | "drain-conflicting",
  ): VoiceRuntimeCommandRejectionReason | null {
    const operation = this.snapshot.operation;
    if (operation.kind === "none") return null;
    if (policy === "reject") return "owner-conflict";

    const root: VoiceRuntimeRootOperation =
      operation.kind === "realtime"
        ? { kind: "mode", modeSessionId: operation.modeSessionId }
        : operation.turnClientOperationId === null
          ? { kind: "mode", modeSessionId: operation.modeSessionId }
          : {
              kind: "turn",
              modeSessionId: operation.modeSessionId,
              turnClientOperationId: operation.turnClientOperationId,
              turnOperationId: operation.turnOperationId,
            };
    this.snapshot = {
      ...this.snapshot,
      operation:
        operation.kind === "realtime"
          ? {
              ...operation,
              phase: policy === "drain-conflicting" ? "draining" : "stopping",
            }
          : { ...operation, phase: { phase: "finalizing" } },
    };
    this.publishState(command.commandId);
    this.snapshot = {
      ...this.snapshot,
      operation: { kind: "none" },
      mediaOwner: { kind: "none" },
      readiness: this.readyReadiness(),
    };
    this.publishTerminal(root, "interrupted", command.commandId);
    return null;
  }

  private readyReadiness(): VoiceRuntimeSnapshot["readiness"] {
    if (this.snapshot.availability !== "ready" || this.snapshot.target === null) {
      return { state: "disabled" };
    }
    return { state: "ready", mode: this.snapshot.target.mode };
  }

  private expireAuthority(): void {
    if (this.authority === null || Date.parse(this.authority.expiresAt) > this.now()) return;
    this.authority = null;
    this.snapshot = {
      ...this.snapshot,
      availability: "locked",
      target: this.snapshot.operation.kind === "none" ? null : this.snapshot.target,
      readiness: { state: "disabled" },
    };
    this.publishState();
  }

  private invalidateConsumers(): void {
    this.consumers.clear();
    this.subscribers.clear();
    this.acknowledgements.clear();
    this.presentationActions.clear();
  }

  private requireClaimedPresentationAction(
    actionId: string,
    lease: VoiceRuntimeConsumerLease,
  ): StoredPresentationAction {
    const stored = this.presentationActions.get(actionId);
    if (
      stored === undefined ||
      stored.acknowledged ||
      Date.parse(stored.action.expiresAt) <= this.now() ||
      stored.claimedBy?.leaseId !== lease.leaseId ||
      stored.claimedBy.leaseGeneration !== lease.leaseGeneration
    ) {
      throw new FakeVoiceRuntimePresentationActionError(
        "Presentation action is not claimed by this lease",
      );
    }
    return stored;
  }

  private releasePresentationClaims(leaseId: string): void {
    for (const stored of this.presentationActions.values()) {
      if (stored.claimedBy?.leaseId === leaseId) stored.claimedBy = null;
    }
  }

  private retainBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.set(key, value);
    while (map.size > DEFAULT_IDEMPOTENCY_CAPACITY) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private isMatchingThreadTurn(modeSessionId: string, turnClientOperationId: string): boolean {
    return (
      this.snapshot.operation.kind === "thread-turn" &&
      this.snapshot.operation.modeSessionId === modeSessionId &&
      this.snapshot.operation.turnClientOperationId === turnClientOperationId
    );
  }

  private commandFenceRebase(command: VoiceRuntimeCommand): VoiceRuntimeRebase | null {
    if (
      command.runtimeId !== this.snapshot.runtimeId ||
      command.runtimeInstanceId !== this.snapshot.runtimeInstanceId
    ) {
      return this.rebase("runtime-replaced");
    }
    if (command.authorityGeneration !== this.snapshot.generation) {
      return this.rebase("generation-changed");
    }
    return null;
  }

  private rejectedReceipt(
    command: VoiceRuntimeCommand,
    reason: VoiceRuntimeCommandRejectionReason,
  ): VoiceCommandReceipt {
    return {
      commandId: command.commandId,
      root: rootForCommand(command),
      replayed: false,
      outcome: { type: "rejected", reason },
      cursor: this.cursor(),
    };
  }

  private publishCommandReceipt(command: VoiceRuntimeCommand): VoiceCommandReceipt {
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    const receipt: VoiceCommandReceipt = {
      commandId: command.commandId,
      root: rootForCommand(command),
      replayed: false,
      outcome: { type: "accepted" },
      cursor: this.cursor(),
    };
    const event: VoiceRuntimeEvent = {
      runtimeId: this.snapshot.runtimeId,
      runtimeInstanceId: this.snapshot.runtimeInstanceId,
      authorityGeneration: this.snapshot.generation,
      sequence,
      occurredAt: this.isoNow(),
      root: receipt.root,
      causedByCommandId: command.commandId,
      kind: "command-outcome",
      receipt,
    };
    this.appendEvent(event);
    return receipt;
  }

  private publishState(causedByCommandId?: VoiceRuntimeCommandId): void {
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    const event: VoiceRuntimeEvent = {
      runtimeId: this.snapshot.runtimeId,
      runtimeInstanceId: this.snapshot.runtimeInstanceId,
      authorityGeneration: this.snapshot.generation,
      sequence,
      occurredAt: this.isoNow(),
      root: { kind: "none" },
      ...(causedByCommandId === undefined ? {} : { causedByCommandId }),
      kind: "state-changed",
      snapshot: this.snapshot,
    };
    this.appendEvent(event);
  }

  private publishTerminal(
    root: VoiceRuntimeRootOperation,
    outcome: "completed" | "stopped" | "interrupted" | "failed" | "cancelled",
    causedByCommandId?: VoiceRuntimeCommandId,
  ): void {
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    this.appendEvent({
      runtimeId: this.snapshot.runtimeId,
      runtimeInstanceId: this.snapshot.runtimeInstanceId,
      authorityGeneration: this.snapshot.generation,
      sequence,
      occurredAt: this.isoNow(),
      root,
      ...(causedByCommandId === undefined ? {} : { causedByCommandId }),
      kind: "operation-terminal",
      outcome,
    });
  }

  private publishElection(election: VoiceRuntimePresentationElection): void {
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    const event: VoiceRuntimeEvent = {
      runtimeId: this.snapshot.runtimeId,
      runtimeInstanceId: this.snapshot.runtimeInstanceId,
      authorityGeneration: this.snapshot.generation,
      sequence,
      occurredAt: this.isoNow(),
      root: { kind: "none" },
      kind: "presentation-election",
      election,
    };
    this.appendEvent(event);
  }

  private appendEvent(event: VoiceRuntimeEvent): void {
    const removedExpiredConsumers = this.expireConsumers(false);
    if (removedExpiredConsumers) this.recomputeElection(false);
    this.journal.push(event);
    while (this.journal.length > this.journalCapacity) this.journal.shift();
    for (const subscriber of this.subscribers) {
      if (this.consumers.has(subscriber.leaseId)) subscriber.listener(event);
    }
  }

  private recomputeElection(publish = true): void {
    this.expireConsumers(false);
    const candidates = [...this.consumers.values()]
      .filter((lease) => lease.presentation === "foreground-active")
      .sort((left, right) => right.attachOrdinal - left.attachOrdinal);
    const elected = candidates[0] ?? null;
    for (const [leaseId, lease] of this.consumers) {
      const election = leaseId === elected?.leaseId ? "elected" : "standby";
      if (lease.election !== election) this.consumers.set(leaseId, { ...lease, election });
      if (election === "standby") this.releasePresentationClaims(leaseId);
    }
    if (!publish) return;
    this.publishElection({
      electedLeaseId: elected?.leaseId ?? null,
      electedAttachOrdinal: elected?.attachOrdinal ?? null,
      eligibleConsumerCount: candidates.length,
      changedAt: this.isoNow(),
    });
  }

  private expireConsumers(recompute = true): boolean {
    const now = this.now();
    let removed = false;
    for (const [leaseId, lease] of this.consumers) {
      if (Date.parse(lease.expiresAt) > now) continue;
      this.consumers.delete(leaseId);
      this.acknowledgements.delete(leaseId);
      this.releasePresentationClaims(leaseId);
      for (const subscriber of this.subscribers) {
        if (subscriber.leaseId === leaseId) this.subscribers.delete(subscriber);
      }
      removed = true;
    }
    if (removed && recompute) this.recomputeElection();
    return removed;
  }

  private requireStoredLease(candidate: VoiceRuntimeConsumerLease): VoiceRuntimeConsumerLease {
    this.expireConsumers();
    const current = this.consumers.get(candidate.leaseId);
    if (
      current === undefined ||
      current.runtimeId !== candidate.runtimeId ||
      current.runtimeInstanceId !== candidate.runtimeInstanceId ||
      current.generation !== candidate.generation ||
      current.leaseGeneration !== candidate.leaseGeneration
    ) {
      throw new FakeVoiceRuntimeLeaseError("Voice runtime consumer lease is stale");
    }
    return current;
  }

  private requireElectedLease(candidate: VoiceRuntimeConsumerLease): VoiceRuntimeConsumerLease {
    const current = this.requireStoredLease(candidate);
    if (current.election !== "elected") {
      throw new FakeVoiceRuntimeLeaseError("Voice runtime consumer lease is not elected");
    }
    return current;
  }

  private requireRuntimeFence(
    runtimeId: string,
    runtimeInstanceId: string,
    generation: number,
  ): void {
    if (
      runtimeId !== this.snapshot.runtimeId ||
      runtimeInstanceId !== this.snapshot.runtimeInstanceId
    ) {
      throw new FakeVoiceRuntimeAuthorityError("Voice runtime identity fence failed");
    }
    if (generation !== this.snapshot.generation) {
      throw new FakeVoiceRuntimeAuthorityError("Voice runtime authority generation fence failed");
    }
  }

  private cursor(): VoiceRuntimeCursor {
    return {
      runtimeId: this.snapshot.runtimeId,
      runtimeInstanceId: this.snapshot.runtimeInstanceId,
      generation: this.snapshot.generation,
      sequence: this.snapshot.sequence,
    };
  }

  private rebase(reason: VoiceRuntimeRebase["reason"]): VoiceRuntimeRebase {
    return {
      type: "rebase",
      reason,
      cursor: this.cursor(),
      snapshot: this.snapshot,
      threadReceipts: this.threadReceipts,
      realtimeTerminalSummaries: this.realtimeSummaries,
      draftArtifacts: [...this.draftArtifacts.values()]
        .filter(
          (entry) => !entry.consumed && Date.parse(entry.artifact.handle.expiresAt) > this.now(),
        )
        .map((entry) => entry.artifact.handle),
      presentationActions: [...this.presentationActions.values()]
        .filter((entry) => !entry.acknowledged && Date.parse(entry.action.expiresAt) > this.now())
        .map((entry) => entry.action),
    };
  }

  private isoNow(offsetMs = 0): string {
    return DateTime.formatIso(DateTime.makeUnsafe(this.now() + offsetMs));
  }
}

import type {
  VoiceDraftArtifact,
  VoiceRuntimeCommand,
  VoiceRuntimeConsumerLease,
  VoiceRuntimeCursor,
  VoiceRuntimeEvent,
  VoiceRuntimePresentationAction,
  VoiceRuntimePresentationState,
  VoiceRuntimeRebase,
  VoiceRuntimeSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { VoiceRuntime } from "./runtime.ts";

type VoiceRuntimeCommandFence =
  | "commandId"
  | "runtimeId"
  | "runtimeInstanceId"
  | "authorityGeneration";

export type VoiceRuntimeCommandRequest = VoiceRuntimeCommand extends infer Command
  ? Command extends VoiceRuntimeCommand
    ? Omit<Command, VoiceRuntimeCommandFence>
    : never
  : never;

export interface VoiceRuntimeControllerState {
  readonly snapshot: VoiceRuntimeSnapshot;
  readonly lease: VoiceRuntimeConsumerLease;
  readonly cursor: VoiceRuntimeCursor;
}

export interface VoiceRuntimeControllerOptions {
  readonly runtime: VoiceRuntime;
  readonly createCommandId: () => string;
  readonly onState: (state: VoiceRuntimeControllerState) => void;
  readonly onEvent?: (event: VoiceRuntimeEvent) => Promise<void> | void;
  readonly onPresentationAction?: (
    action: VoiceRuntimePresentationAction,
  ) => Promise<{ readonly outcome: "succeeded" | "failed"; readonly message?: string }>;
  readonly onDraftArtifact?: (artifact: VoiceDraftArtifact) => Promise<"appended" | "discarded">;
  readonly onError?: (error: unknown) => void;
  readonly leaseRenewalMs?: number;
}

function cursorFromSnapshot(snapshot: VoiceRuntimeSnapshot): VoiceRuntimeCursor {
  return {
    runtimeId: snapshot.runtimeId,
    runtimeInstanceId: snapshot.runtimeInstanceId,
    generation: snapshot.generation,
    sequence: snapshot.sequence,
  };
}

function cursorFromEvent(event: VoiceRuntimeEvent): VoiceRuntimeCursor {
  return {
    runtimeId: event.runtimeId,
    runtimeInstanceId: event.runtimeInstanceId,
    generation: event.authorityGeneration,
    sequence: event.sequence,
  };
}

function isSameRuntime(left: VoiceRuntimeCursor, right: VoiceRuntimeCursor): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.generation === right.generation
  );
}

function isRebase(
  delivery: VoiceRuntimeEvent | VoiceRuntimeRebase,
): delivery is VoiceRuntimeRebase {
  return "type" in delivery && delivery.type === "rebase";
}

/**
 * Presentation controller for one consumer of a platform VoiceRuntime. It does
 * not own media or provider work; the selected runtime adapter remains the
 * operation owner.
 */
export class VoiceRuntimeController {
  private readonly options: VoiceRuntimeControllerOptions;
  private stateValue: VoiceRuntimeControllerState | null = null;
  private unsubscribe: (() => void) | null = null;
  private deliveryQueue: Promise<void> = Promise.resolve();
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private renewalEpoch = 0;
  private subscriptionRestartPending = false;
  private readonly completedPresentationActionIds = new Set<string>();
  private stopped = false;

  constructor(options: VoiceRuntimeControllerOptions) {
    this.options = options;
  }

  get state(): VoiceRuntimeControllerState | null {
    return this.stateValue;
  }

  async start(presentation: VoiceRuntimePresentationState): Promise<VoiceRuntimeControllerState> {
    return this.enqueueLifecycle(async () => {
      if (this.stateValue !== null) return this.stateValue;
      this.stopped = false;

      const initial = await this.options.runtime.getSnapshot();
      const lease = await this.options.runtime.attach({
        runtimeId: initial.runtimeId,
        runtimeInstanceId: initial.runtimeInstanceId,
        generation: initial.generation,
        presentation,
      });
      const initialCursor = cursorFromSnapshot(initial);
      this.setState({ snapshot: initial, lease, cursor: initialCursor });

      try {
        // Subscribe before the authoritative follow-up snapshot so an operation
        // transition cannot fall into an attach/snapshot race.
        this.subscribe(lease, initialCursor);

        const current = await this.options.runtime.getSnapshot();
        const currentCursor = cursorFromSnapshot(current);
        if (!isSameRuntime(initialCursor, currentCursor)) {
          throw new Error("Voice runtime changed while attaching.");
        }

        // A snapshot may be newer than the delivery cursor, but observing it does
        // not mean the intervening events were processed or acknowledged.
        this.setState({ snapshot: current, lease, cursor: initialCursor });
        this.scheduleRenewal();
        return this.requireState();
      } catch (error) {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.stateValue = null;
        await this.options.runtime.detach(lease).catch(() => undefined);
        throw error;
      }
    });
  }

  async updatePresentation(
    presentation: VoiceRuntimePresentationState,
  ): Promise<VoiceRuntimeControllerState> {
    return this.enqueueLifecycle(async () => {
      const current = this.requireState();
      const lease = await this.options.runtime.updateAttachment({
        lease: current.lease,
        presentation,
      });
      this.unsubscribe?.();
      this.subscribe(lease, current.cursor);
      this.setState({ ...current, lease });
      this.scheduleRenewal();
      return this.requireState();
    });
  }

  async dispatch(request: VoiceRuntimeCommandRequest) {
    const { snapshot } = this.requireState();
    const receipt = await this.options.runtime.dispatch({
      ...request,
      commandId: this.options.createCommandId(),
      runtimeId: snapshot.runtimeId,
      runtimeInstanceId: snapshot.runtimeInstanceId,
      authorityGeneration: snapshot.generation,
    } as VoiceRuntimeCommand);
    if (receipt.outcome.type === "rebase-required") {
      this.enqueueDelivery(receipt.outcome.rebase);
      await this.deliveryQueue;
      return receipt;
    }
    const current = await this.options.runtime.getSnapshot();
    const cursor = cursorFromSnapshot(current);
    const state = this.stateValue;
    if (
      state !== null &&
      isSameRuntime(state.cursor, cursor) &&
      current.sequence >= state.snapshot.sequence
    ) {
      this.setState({ ...state, snapshot: current });
    }
    return receipt;
  }

  async stop(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      if (this.stopped) return;
      this.stopped = true;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.renewalEpoch += 1;
      await this.deliveryQueue.catch(() => undefined);
      const state = this.stateValue;
      this.stateValue = null;
      if (state !== null) {
        await this.options.runtime.detach(state.lease).catch((error: unknown) => {
          this.reportError(error);
        });
      }
    });
  }

  private enqueueDelivery(delivery: VoiceRuntimeEvent | VoiceRuntimeRebase): void {
    this.deliveryQueue = this.deliveryQueue
      .then(async () => {
        if (this.stopped || this.stateValue === null) return;
        if (isRebase(delivery)) {
          await this.applyRebase(delivery);
        } else {
          await this.applyEvent(delivery);
        }
      })
      .catch((error: unknown) => {
        this.reportError(error);
        this.restartSubscription();
      });
  }

  private subscribe(lease: VoiceRuntimeConsumerLease, after: VoiceRuntimeCursor): void {
    this.unsubscribe = this.options.runtime.subscribe({ lease, after }, (delivery) =>
      this.enqueueDelivery(delivery),
    );
  }

  private async applyEvent(event: VoiceRuntimeEvent): Promise<void> {
    const current = this.requireState();
    const cursor = cursorFromEvent(event);
    if (!isSameRuntime(current.cursor, cursor) || cursor.sequence <= current.cursor.sequence)
      return;
    if (cursor.sequence !== current.cursor.sequence + 1) {
      throw new Error(
        `Voice runtime delivery gap: expected ${current.cursor.sequence + 1}, received ${cursor.sequence}.`,
      );
    }

    let snapshot = current.snapshot;
    let lease = current.lease;
    if (event.kind === "state-changed") snapshot = event.snapshot;
    if (event.kind === "presentation-election") {
      lease = {
        ...lease,
        election: event.election.electedLeaseId === lease.leaseId ? "elected" : "standby",
      };
    }
    this.setState({ ...current, snapshot, lease });

    await this.options.onEvent?.(event);
    if (event.kind === "presentation-action") {
      await this.consumePresentationAction(event.action);
    }
    await this.options.runtime.acknowledge({ lease: this.requireState().lease, through: cursor });
    const committed = this.requireState();
    this.setState({ ...committed, cursor });
  }

  private async applyRebase(rebase: VoiceRuntimeRebase): Promise<void> {
    let current = this.requireState();
    if (rebase.reason === "cursor-too-old") {
      this.setState({ ...current, snapshot: rebase.snapshot });
      for (const action of rebase.presentationActions) {
        await this.consumePresentationAction(action);
      }
      await this.options.runtime.acknowledge({
        lease: this.requireState().lease,
        through: rebase.cursor,
      });
      current = this.requireState();
      this.setState({ ...current, cursor: rebase.cursor });
      return;
    }

    const replacement = await this.options.runtime.attach({
      runtimeId: rebase.snapshot.runtimeId,
      runtimeInstanceId: rebase.snapshot.runtimeInstanceId,
      generation: rebase.snapshot.generation,
      presentation: current.lease.presentation,
    });
    const previous = current.lease;
    this.unsubscribe?.();
    current = { snapshot: rebase.snapshot, lease: replacement, cursor: rebase.cursor };
    this.setState(current);
    this.subscribe(replacement, rebase.cursor);
    this.scheduleRenewal();
    await this.options.runtime.detach(previous).catch(() => undefined);
    for (const action of rebase.presentationActions) {
      await this.consumePresentationAction(action);
    }
    await this.options.runtime.acknowledge({
      lease: this.requireState().lease,
      through: rebase.cursor,
    });
  }

  private async consumePresentationAction(action: VoiceRuntimePresentationAction): Promise<void> {
    if (this.completedPresentationActionIds.has(action.actionId)) return;
    const state = this.requireState();
    if (state.lease.election !== "elected") return;
    if (action.action === "review-draft" && this.options.onDraftArtifact === undefined) return;
    if (action.action !== "review-draft" && this.options.onPresentationAction === undefined) return;

    const claimed = await this.options.runtime.claimPresentationAction({
      lease: state.lease,
      actionId: action.actionId,
    });
    try {
      if (claimed.action === "review-draft") {
        const artifact = await this.options.runtime.readDraftArtifact({
          lease: this.requireState().lease,
          artifactId: claimed.artifact.artifactId,
        });
        const outcome = await this.options.onDraftArtifact!(artifact);
        await this.options.runtime.acknowledgeDraftArtifact({
          lease: this.requireState().lease,
          artifactId: artifact.handle.artifactId,
          outcome,
        });
      }

      if (claimed.action === "realtime-confirmation-required") {
        await this.options.onPresentationAction!(claimed);
        return;
      }

      const result =
        claimed.action === "review-draft"
          ? ({ outcome: "succeeded" } as const)
          : await this.options.onPresentationAction!(claimed);
      await this.options.runtime.acknowledgePresentationAction({
        lease: this.requireState().lease,
        actionId: claimed.actionId,
        ...result,
      });
      this.markPresentationActionCompleted(claimed.actionId);
    } catch (error) {
      if (claimed.action === "realtime-confirmation-required") throw error;
      try {
        await this.options.runtime.acknowledgePresentationAction({
          lease: this.requireState().lease,
          actionId: claimed.actionId,
          outcome: "failed",
          message: error instanceof Error ? error.message.slice(0, 512) : "Presentation failed.",
        });
      } catch (acknowledgementError) {
        this.reportError(error);
        throw acknowledgementError;
      }
      this.markPresentationActionCompleted(claimed.actionId);
      this.reportError(error);
    }
  }

  private markPresentationActionCompleted(actionId: string): void {
    this.completedPresentationActionIds.add(actionId);
    if (this.completedPresentationActionIds.size <= 256) return;
    const oldest = this.completedPresentationActionIds.values().next().value as string | undefined;
    if (oldest !== undefined) this.completedPresentationActionIds.delete(oldest);
  }

  private setState(state: VoiceRuntimeControllerState): void {
    this.stateValue = state;
    try {
      this.options.onState(state);
    } catch (error) {
      this.reportError(error);
    }
  }

  private restartSubscription(): void {
    if (this.stopped || this.stateValue === null || this.subscriptionRestartPending) return;
    this.subscriptionRestartPending = true;
    queueMicrotask(() => {
      this.subscriptionRestartPending = false;
      const state = this.stateValue;
      if (this.stopped || state === null) return;
      this.unsubscribe?.();
      this.subscribe(state.lease, state.cursor);
    });
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Consumer diagnostics must not break delivery or lifecycle ownership.
    }
  }

  private scheduleRenewal(): void {
    if (this.stopped) return;
    const epoch = ++this.renewalEpoch;
    void Effect.runPromise(Effect.sleep(this.options.leaseRenewalMs ?? 10_000)).then(() => {
      if (epoch !== this.renewalEpoch) return;
      const presentation = this.stateValue?.lease.presentation;
      if (presentation === undefined || this.stopped) return;
      void this.updatePresentation(presentation).catch((error: unknown) => {
        this.reportError(error);
        if (!this.stopped) this.scheduleRenewal();
      });
    });
  }

  private requireState(): VoiceRuntimeControllerState {
    if (this.stateValue === null) throw new Error("Voice runtime controller is not attached.");
    return this.stateValue;
  }

  private async enqueueLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(work, work);
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

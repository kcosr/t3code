import type {
  VoiceCommandReceipt,
  VoiceDraftArtifact,
  VoiceDraftArtifactAcknowledgement,
  VoiceRuntimeAuthorityClearCommand,
  VoiceRuntimeAuthorityReservation,
  VoiceRuntimeDescriptor,
  VoiceRuntimeEvent,
  VoiceRuntimePresentationAction,
  VoiceRuntimePresentationActionAcknowledgement,
  VoiceRuntimePresentationState,
  VoiceRuntimeRebase,
  VoiceRuntimeSnapshot,
} from "@t3tools/contracts";

import type { VoiceRuntime, VoiceRuntimeFactory } from "./runtime.ts";
import {
  VoiceRuntimeController,
  VoiceRuntimePresentationReleasedError,
  type VoiceRuntimeCommandRequest,
  type VoiceRuntimeControllerState,
} from "./runtimeController.ts";

export type VoiceRuntimePresentationBindingPhase =
  | "detached"
  | "attaching"
  | "attached"
  | "detaching"
  | "error";

export interface VoiceRuntimePresentationBindingSnapshot {
  readonly phase: VoiceRuntimePresentationBindingPhase;
  readonly descriptor: VoiceRuntimeDescriptor | null;
  readonly controller: VoiceRuntimeControllerState | null;
  readonly snapshot: VoiceRuntimeSnapshot | null;
  readonly presentationAction: VoiceRuntimePresentationAction | null;
  readonly draftArtifact: VoiceDraftArtifact | null;
  readonly error: unknown | null;
}

export interface VoiceRuntimePresentationBindingOptions {
  readonly runtime: VoiceRuntime | VoiceRuntimeFactory;
  readonly createCommandId: () => string;
  readonly onEvent?: (event: VoiceRuntimeEvent) => Promise<void> | void;
  readonly onRebase?: (rebase: VoiceRuntimeRebase) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
  readonly leaseRenewalMs?: number;
}

export interface VoiceRuntimePresentationHandle {
  readonly ready: Promise<void>;
  readonly updatePresentation: (presentation: VoiceRuntimePresentationState) => Promise<void>;
  readonly release: () => Promise<void>;
}

interface PendingPresentationAction {
  readonly action: VoiceRuntimePresentationAction;
  readonly resolve: (result: PresentationActionResult) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingDraftArtifact {
  readonly artifact: VoiceDraftArtifact;
  readonly resolve: (outcome: VoiceDraftArtifactAcknowledgement["outcome"]) => void;
  readonly reject: (error: unknown) => void;
}

type PresentationActionResult = Pick<
  VoiceRuntimePresentationActionAcknowledgement,
  "outcome" | "message"
>;

const PRESENTATION_PRIORITY: Readonly<Record<VoiceRuntimePresentationState, number>> = {
  background: 0,
  "visible-inactive": 1,
  "foreground-active": 2,
};

function isRuntimeFactory(
  source: VoiceRuntime | VoiceRuntimeFactory,
): source is VoiceRuntimeFactory {
  return "create" in source;
}

/**
 * External-store owner for one React presentation attachment. The platform
 * runtime remains the sole owner of media and provider work.
 */
export class VoiceRuntimePresentationBinding {
  private readonly options: VoiceRuntimePresentationBindingOptions;
  private readonly listeners = new Set<() => void>();
  private readonly presentations = new Map<symbol, VoiceRuntimePresentationState>();
  private stateValue: VoiceRuntimePresentationBindingSnapshot = {
    phase: "detached",
    descriptor: null,
    controller: null,
    snapshot: null,
    presentationAction: null,
    draftArtifact: null,
    error: null,
  };
  private runtimeValue: VoiceRuntime | null = null;
  private runtimePromise: Promise<VoiceRuntime> | null = null;
  private controllerValue: VoiceRuntimeController | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private reconcileScheduled = false;
  private reconcileWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private pendingPresentationAction: PendingPresentationAction | null = null;
  private pendingDraftArtifact: PendingDraftArtifact | null = null;

  constructor(options: VoiceRuntimePresentationBindingOptions) {
    this.options = options;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceRuntimePresentationBindingSnapshot => this.stateValue;

  acquire(presentation: VoiceRuntimePresentationState): VoiceRuntimePresentationHandle {
    const token = Symbol("voice-runtime-presentation");
    let released = false;
    this.presentations.set(token, presentation);
    const ready = this.requestReconcile();
    return {
      ready,
      updatePresentation: async (next) => {
        if (released) return;
        if (this.presentations.get(token) === next) return;
        this.presentations.set(token, next);
        await this.requestReconcile();
      },
      release: async () => {
        if (released) return;
        released = true;
        this.presentations.delete(token);
        await this.requestReconcile();
      },
    };
  }

  retry(): Promise<void> {
    return this.requestReconcile();
  }

  async dispatch(request: VoiceRuntimeCommandRequest): Promise<VoiceCommandReceipt> {
    const controller = this.controllerValue;
    if (controller?.state === null || controller === null) {
      throw new Error("Voice runtime presentation is not attached.");
    }
    return controller.dispatch(request);
  }

  configureAuthority(input: VoiceRuntimeAuthorityReservation): Promise<VoiceRuntimeSnapshot> {
    return this.enqueueLifecycle(async () => {
      const runtime = await this.ensureRuntime();
      const snapshot = await runtime.configureAuthority(input);
      this.publish({ snapshot, error: null });
      const controller = this.controllerValue;
      const controllerState = controller?.state ?? null;
      if (
        controller !== null &&
        controllerState !== null &&
        (controllerState.snapshot.runtimeId !== snapshot.runtimeId ||
          controllerState.snapshot.runtimeInstanceId !== snapshot.runtimeInstanceId ||
          controllerState.snapshot.generation !== snapshot.generation)
      ) {
        this.releasePendingPresentation();
        await controller.stop();
        this.publish({ controller: null });
        await this.reconcileDesiredPresentation();
      }
      return snapshot;
    });
  }

  clearAuthority(input: VoiceRuntimeAuthorityClearCommand): Promise<VoiceRuntimeSnapshot> {
    return this.enqueueLifecycle(async () => {
      const runtime = await this.ensureRuntime();
      const snapshot = await runtime.clearAuthority(input);
      this.publish({ snapshot, error: null });
      return snapshot;
    });
  }

  completePresentationAction(
    actionId: VoiceRuntimePresentationAction["actionId"],
    result: PresentationActionResult,
  ): boolean {
    const pending = this.pendingPresentationAction;
    if (pending?.action.actionId !== actionId) return false;
    this.pendingPresentationAction = null;
    this.publish({ presentationAction: null });
    pending.resolve(result);
    return true;
  }

  completeDraftArtifact(
    artifactId: VoiceDraftArtifact["handle"]["artifactId"],
    outcome: VoiceDraftArtifactAcknowledgement["outcome"],
  ): boolean {
    const pending = this.pendingDraftArtifact;
    if (pending?.artifact.handle.artifactId !== artifactId) return false;
    this.pendingDraftArtifact = null;
    this.publish({ draftArtifact: null });
    pending.resolve(outcome);
    return true;
  }

  private requestReconcile(): Promise<void> {
    const requested = new Promise<void>((resolve, reject) => {
      this.reconcileWaiters.push({ resolve, reject });
    });
    if (this.reconcileScheduled) return requested;
    this.reconcileScheduled = true;
    queueMicrotask(() => {
      this.reconcileScheduled = false;
      const waiters = this.reconcileWaiters.splice(0);
      void this.enqueueLifecycle(() => this.reconcileDesiredPresentation()).then(
        () => {
          for (const waiter of waiters) waiter.resolve();
        },
        (error: unknown) => {
          for (const waiter of waiters) waiter.reject(error);
        },
      );
    });
    return requested;
  }

  private async reconcileDesiredPresentation(): Promise<void> {
    const presentation = this.desiredPresentation();
    const controller = this.controllerValue;
    if (presentation === null) {
      if (controller?.state === null || controller === null) {
        this.publish({ phase: "detached", controller: null, error: null });
        return;
      }
      this.publish({ phase: "detaching" });
      this.releasePendingPresentation();
      await controller.stop();
      this.publish({ phase: "detached", controller: null, error: null });
      return;
    }

    this.publish({
      phase: controller?.state === null || controller === null ? "attaching" : "attached",
    });
    const activeController = await this.ensureController();
    const latestPresentation = this.desiredPresentation();
    if (latestPresentation === null) {
      this.publish({ phase: "detached", controller: null, error: null });
      return;
    }
    if (activeController.state === null) {
      await activeController.start(latestPresentation);
    } else if (activeController.state.lease.presentation !== latestPresentation) {
      await activeController.updatePresentation(latestPresentation);
    }
    this.publish({
      phase: "attached",
      controller: activeController.state,
      snapshot: activeController.state?.snapshot ?? this.stateValue.snapshot,
      error: null,
    });
  }

  private desiredPresentation(): VoiceRuntimePresentationState | null {
    let desired: VoiceRuntimePresentationState | null = null;
    for (const presentation of this.presentations.values()) {
      if (
        desired === null ||
        PRESENTATION_PRIORITY[presentation] > PRESENTATION_PRIORITY[desired]
      ) {
        desired = presentation;
      }
    }
    return desired;
  }

  private async ensureRuntime(): Promise<VoiceRuntime> {
    if (this.runtimeValue !== null) return this.runtimeValue;
    if (this.runtimePromise !== null) return this.runtimePromise;
    const creation = Promise.resolve(
      isRuntimeFactory(this.options.runtime) ? this.options.runtime.create() : this.options.runtime,
    );
    this.runtimePromise = creation;
    try {
      const runtime = await creation;
      this.runtimeValue = runtime;
      return runtime;
    } catch (error) {
      if (this.runtimePromise === creation) this.runtimePromise = null;
      throw error;
    }
  }

  private async ensureController(): Promise<VoiceRuntimeController> {
    if (this.controllerValue !== null) return this.controllerValue;
    const runtime = await this.ensureRuntime();
    const descriptor = await runtime.describe();
    this.publish({ descriptor });
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: this.options.createCommandId,
      onState: (state) => {
        if (state.lease.election !== "elected") this.releasePendingPresentation();
        this.publish({
          phase: this.stateValue.phase === "detaching" ? "detaching" : "attached",
          controller: state,
          snapshot: state.snapshot,
        });
      },
      ...(this.options.onEvent === undefined ? {} : { onEvent: this.options.onEvent }),
      ...(this.options.onRebase === undefined ? {} : { onRebase: this.options.onRebase }),
      onPresentationAction: (action) => this.presentAction(action),
      onDraftArtifact: (artifact) => this.presentDraftArtifact(artifact),
      onError: (error) => {
        this.publish({ error });
        this.reportError(error);
      },
      ...(this.options.leaseRenewalMs === undefined
        ? {}
        : { leaseRenewalMs: this.options.leaseRenewalMs }),
    });
    this.controllerValue = controller;
    return controller;
  }

  private presentAction(action: VoiceRuntimePresentationAction): Promise<PresentationActionResult> {
    if (this.pendingPresentationAction !== null) {
      return Promise.reject(new Error("Another voice presentation action is already pending."));
    }
    return new Promise((resolve, reject) => {
      this.pendingPresentationAction = { action, resolve, reject };
      this.publish({ presentationAction: action });
    });
  }

  private presentDraftArtifact(
    artifact: VoiceDraftArtifact,
  ): Promise<VoiceDraftArtifactAcknowledgement["outcome"]> {
    if (this.pendingDraftArtifact !== null) {
      return Promise.reject(new Error("Another voice draft artifact is already pending."));
    }
    return new Promise((resolve, reject) => {
      this.pendingDraftArtifact = { artifact, resolve, reject };
      this.publish({ draftArtifact: artifact });
    });
  }

  private releasePendingPresentation(): void {
    const action = this.pendingPresentationAction;
    if (action !== null) {
      this.pendingPresentationAction = null;
      this.publish({ presentationAction: null });
      action.reject(new VoiceRuntimePresentationReleasedError());
    }
    const draft = this.pendingDraftArtifact;
    if (draft !== null) {
      this.pendingDraftArtifact = null;
      this.publish({ draftArtifact: null });
      draft.reject(new VoiceRuntimePresentationReleasedError());
    }
  }

  private publish(update: Partial<VoiceRuntimePresentationBindingSnapshot>): void {
    this.stateValue = { ...this.stateValue, ...update };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics must not break presentation ownership.
    }
  }

  private async enqueueLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(work, work);
    this.lifecycleQueue = result.then(
      () => undefined,
      (error: unknown) => {
        this.publish({ phase: "error", error });
        this.reportError(error);
      },
    );
    return result;
  }
}

import type {
  T3VoiceCommandEvent,
  T3VoiceReadinessDisabledEvent,
  T3VoiceReadinessSnapshot,
} from "@t3tools/mobile-voice-native";

import type { Preferences } from "../../persistence/mobile-preferences";

export const disabledNativeVoiceReadiness = (): T3VoiceReadinessSnapshot => ({
  enabled: false,
  mode: "realtime",
  targetId: null,
  audioRouteId: "system",
  autoRearm: false,
  microphonePermissionGranted: false,
  notificationPermissionGranted: false,
});

export interface NativeVoiceReadinessContext {
  readonly microphonePermissionGranted: boolean;
  readonly notificationPermissionGranted: boolean;
  readonly threadTargetValid: boolean;
}

export function resolveNativeVoiceReadiness(
  preferences: Preferences | null,
  environmentId: string | null,
  context: NativeVoiceReadinessContext,
): T3VoiceReadinessSnapshot {
  if (preferences?.voiceBackgroundControlsEnabled !== true || environmentId === null) {
    return disabledNativeVoiceReadiness();
  }

  const mode = preferences.voiceBackgroundDefaultMode ?? "realtime";
  const target = preferences.voiceThreadTarget;
  const targetId =
    mode === "thread" && context.threadTargetValid && target?.environmentId === environmentId
      ? `${target.environmentId}/${target.threadId}`
      : null;

  return {
    enabled:
      context.microphonePermissionGranted &&
      context.notificationPermissionGranted &&
      (mode === "realtime" || targetId !== null),
    mode,
    targetId,
    audioRouteId: preferences.voiceAudioRouteId ?? "system",
    autoRearm: preferences.voiceAutoListenEnabled === true,
    microphonePermissionGranted: context.microphonePermissionGranted,
    notificationPermissionGranted: context.notificationPermissionGranted,
  };
}

/**
 * React registrations use an epoch-based generation so a recreated bridge cannot
 * accidentally acknowledge a command queued for an older controller instance.
 */
export class NativeVoiceControllerGeneration {
  private nextGeneration = Date.now();
  private activeGeneration: number | null = null;
  private activeReadinessGeneration: number | null = null;

  register(readinessGeneration: number): number {
    this.nextGeneration += 1;
    this.activeGeneration = this.nextGeneration;
    this.activeReadinessGeneration = readinessGeneration;
    return this.nextGeneration;
  }

  invalidate(generation: number): void {
    if (this.activeGeneration !== generation) return;
    this.activeGeneration = null;
    this.activeReadinessGeneration = null;
  }

  accepts(event: T3VoiceCommandEvent): boolean {
    return (
      this.activeGeneration === event.controllerGeneration &&
      this.activeReadinessGeneration === event.readinessGeneration
    );
  }
}

export async function completeNativeVoiceCommandAttempt(
  event: T3VoiceCommandEvent,
  attempt: () => Promise<boolean>,
  complete: (input: {
    readonly commandId: string;
    readonly controllerGeneration: number;
    readonly outcome: "success" | "failure";
  }) => Promise<void>,
): Promise<"success" | "failure"> {
  let outcome: "success" | "failure" = "failure";
  try {
    if (await attempt()) outcome = "success";
  } finally {
    await complete({
      commandId: event.commandId,
      controllerGeneration: event.controllerGeneration,
      outcome,
    });
  }
  return outcome;
}

export function isNextNativeReadinessGeneration(
  currentGeneration: number | null,
  eventGeneration: number,
): boolean {
  return currentGeneration === null || eventGeneration === currentGeneration + 1;
}

export async function reconcilePendingNativeReadinessDisable(input: {
  readonly getPending: () => Promise<T3VoiceReadinessDisabledEvent | null>;
  readonly persistDisabled: (event: T3VoiceReadinessDisabledEvent) => Promise<void>;
  readonly acknowledge: (event: T3VoiceReadinessDisabledEvent) => Promise<void>;
}): Promise<T3VoiceReadinessDisabledEvent | null> {
  const pending = await input.getPending();
  if (pending === null) return null;
  await input.persistDisabled(pending);
  await input.acknowledge(pending);
  return pending;
}

export class NativeVoiceOperationEpoch {
  private currentEpoch = 0;
  private queue: Promise<void> = Promise.resolve();

  begin(): number {
    this.currentEpoch += 1;
    return this.currentEpoch;
  }

  invalidate(epoch: number): void {
    if (this.currentEpoch === epoch) this.currentEpoch += 1;
  }

  isCurrent(epoch: number): boolean {
    return this.currentEpoch === epoch;
  }

  assertCurrent(epoch: number): void {
    if (!this.isCurrent(epoch)) throw new Error("Stale native voice readiness operation");
  }

  run<A>(epoch: number, operation: () => Promise<A>): Promise<A> {
    const result = this.queue.then(() => {
      this.assertCurrent(epoch);
      return operation();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  runCleanup(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export class NativeVoiceCommandDeduplicator {
  private readonly inFlight = new Set<string>();

  claim(commandId: string): boolean {
    if (this.inFlight.has(commandId)) return false;
    this.inFlight.add(commandId);
    return true;
  }

  release(commandId: string): void {
    this.inFlight.delete(commandId);
  }

  clear(): void {
    this.inFlight.clear();
  }
}

export class NativeVoiceCommandCompletionGate {
  private readonly pending = new Set<string>();

  begin(commandId: string): void {
    this.pending.add(commandId);
  }

  claim(commandId: string): boolean {
    if (!this.pending.delete(commandId)) return false;
    return true;
  }

  clear(): void {
    this.pending.clear();
  }
}

export class NativeVoiceForegroundCommandGate<A> {
  private pending: A | null = null;
  private active = false;
  private disposed = false;
  private activationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly activationDelayMs: number,
    private readonly dispatch: (command: A) => void,
  ) {}

  enqueue(command: A): void {
    if (this.disposed) return;
    this.pending = command;
    this.scheduleDispatch();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) {
      this.cancelActivationTimer();
      return;
    }
    this.scheduleDispatch();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.cancelActivationTimer();
  }

  private scheduleDispatch(): void {
    if (!this.active || this.pending === null || this.activationTimer !== null) return;
    this.activationTimer = setTimeout(() => {
      this.activationTimer = null;
      if (this.disposed || !this.active || this.pending === null) return;
      const command = this.pending;
      this.pending = null;
      this.dispatch(command);
    }, this.activationDelayMs);
  }

  private cancelActivationTimer(): void {
    if (this.activationTimer === null) return;
    clearTimeout(this.activationTimer);
    this.activationTimer = null;
  }
}

export class NativeThreadCommandActivationCoordinator {
  private readonly handled = new Set<string>();

  start(
    commandId: string,
    activate: () => Promise<boolean>,
    complete: (commandId: string, outcome: "success" | "failure") => Promise<void>,
  ): boolean {
    if (this.handled.has(commandId)) return false;
    this.handled.add(commandId);
    void activate()
      .then((activated) => complete(commandId, activated ? "success" : "failure"))
      .catch(() => complete(commandId, "failure"))
      .catch(() => undefined);
    return true;
  }
}

export function scheduleNativeVoiceCommandFailure(
  commandId: string,
  timeoutMs: number,
  fail: (commandId: string) => void,
): () => void {
  const timeout = setTimeout(() => fail(commandId), timeoutMs);
  return () => clearTimeout(timeout);
}

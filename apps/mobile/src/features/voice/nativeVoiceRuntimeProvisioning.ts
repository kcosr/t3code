import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import type { VoiceNativeRuntimeId, VoiceNativeRuntimeTarget } from "@t3tools/contracts";
import type {
  T3VoiceBackgroundGrantOperation,
  T3VoiceBackgroundRuntimeGrantInput,
  T3VoiceNativeModule,
  T3VoiceReadinessSnapshot,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  canonicalNativeVoiceRuntimeTargetIdentity,
  type ResolvedNativeVoiceRuntimeTarget,
} from "./nativeVoiceRuntimeTarget";

type NativeRuntimeGrantClient = Pick<
  VoiceHttpClient,
  "provisionNativeRuntimeGrant" | "revokeNativeRuntimeGrant"
>;

export interface NativeVoiceRuntimeReservation {
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly readinessGeneration: number;
}

export interface NativeVoiceRuntimeProvisioningAdapter {
  /**
   * Reserves native readiness state. Repeating an identical epoch after a failed
   * request must return the same runtime ID and readiness generation.
   */
  readonly prepare: (input: {
    readonly epoch: number;
    readonly readiness: T3VoiceReadinessSnapshot;
    readonly environmentOrigin: string;
    readonly operation: T3VoiceBackgroundGrantOperation;
    readonly targetIdentity: string;
  }) => Promise<NativeVoiceRuntimeReservation>;
  /** Atomically stores the credential and publishes the prepared readiness state. */
  readonly activate: (input: T3VoiceBackgroundRuntimeGrantInput) => Promise<void>;
  /** Stops native work and clears credentials before server authority is revoked. */
  readonly disable: (input: {
    readonly epoch: number;
  }) => Promise<{ readonly runtimeId: VoiceNativeRuntimeId | null }>;
}

export interface NativeVoiceRuntimeProvisioningInput {
  readonly epoch: number;
  readonly readiness: T3VoiceReadinessSnapshot;
  readonly environmentOrigin: string;
  readonly operation: T3VoiceBackgroundGrantOperation;
  readonly resolvedTarget: ResolvedNativeVoiceRuntimeTarget;
}

export function makeNativeVoiceRuntimeProvisioningAdapter(
  native: T3VoiceNativeModule,
  createRuntimeId: () => string,
): NativeVoiceRuntimeProvisioningAdapter {
  let prepared: {
    readonly runtimeId: VoiceNativeRuntimeId;
    readonly generation: number;
    readonly readiness: T3VoiceReadinessSnapshot;
  } | null = null;
  return {
    prepare: async ({ readiness }) => {
      const result = await native.prepareBackgroundVoiceReadinessAsync({
        readiness,
        runtimeId: createRuntimeId(),
      });
      const runtimeId = VoiceNativeRuntimeId.make(result.runtimeId);
      prepared = {
        runtimeId,
        generation: result.readiness.generation,
        readiness,
      };
      return { runtimeId, readinessGeneration: result.readiness.generation };
    },
    activate: async (grant) => {
      const reservation = prepared;
      if (
        reservation === null ||
        reservation.runtimeId !== grant.runtimeId ||
        reservation.generation !== grant.readinessGeneration
      ) {
        throw new InvalidNativeVoiceRuntimeProvisioningResultError();
      }
      await native.activateBackgroundVoiceReadinessAsync({
        readiness: reservation.readiness,
        expectedGeneration: reservation.generation,
        grant,
      });
      prepared = null;
    },
    disable: async () => {
      prepared = null;
      const disabled = await native.disableBackgroundVoiceReadinessAsync();
      return {
        runtimeId:
          disabled.runtimeId === null ? null : VoiceNativeRuntimeId.make(disabled.runtimeId),
      };
    },
  };
}

export interface NativeVoiceRuntimeProvisioningResult {
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly readinessGeneration: number;
  readonly expiresAt: string;
}

export class StaleNativeVoiceRuntimeProvisioningEpochError extends Error {
  readonly name = "StaleNativeVoiceRuntimeProvisioningEpochError";

  constructor(
    readonly epoch: number,
    readonly currentEpoch: number,
  ) {
    super("A newer native voice runtime provisioning operation has started.");
  }
}

export class ConflictingNativeVoiceRuntimeProvisioningEpochError extends Error {
  readonly name = "ConflictingNativeVoiceRuntimeProvisioningEpochError";

  constructor(readonly epoch: number) {
    super("A native voice runtime provisioning epoch cannot be reused for a different intent.");
  }
}

export class InvalidNativeVoiceRuntimeProvisioningResultError extends Error {
  readonly name = "InvalidNativeVoiceRuntimeProvisioningResultError";

  constructor() {
    super("The native voice runtime grant did not match the prepared readiness state.");
  }
}

const encodeProvisioningIntent = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literal("activate"),
      readiness: Schema.Struct({
        enabled: Schema.Boolean,
        mode: Schema.Literals(["realtime", "thread"]),
        targetId: Schema.NullOr(Schema.String),
        audioRouteId: Schema.String,
        autoRearm: Schema.Boolean,
        microphonePermissionGranted: Schema.Boolean,
        notificationPermissionGranted: Schema.Boolean,
      }),
      environmentOrigin: Schema.String,
      operation: Schema.Literals(["realtime-start", "thread-turn-start"]),
      targetIdentity: Schema.String,
    }),
  ),
);

function activationIntent(input: NativeVoiceRuntimeProvisioningInput): string {
  return encodeProvisioningIntent({
    kind: "activate",
    readiness: input.readiness,
    environmentOrigin: input.environmentOrigin,
    operation: input.operation,
    targetIdentity: input.resolvedTarget.targetIdentity,
  });
}

function assertValidEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new RangeError("Native voice runtime provisioning epochs must be positive integers.");
  }
}

function assertValidReservation(reservation: NativeVoiceRuntimeReservation): void {
  if (
    String(reservation.runtimeId).length === 0 ||
    !Number.isSafeInteger(reservation.readinessGeneration) ||
    reservation.readinessGeneration < 1
  ) {
    throw new InvalidNativeVoiceRuntimeProvisioningResultError();
  }
}

function targetMatches(actual: VoiceNativeRuntimeTarget, expectedIdentity: string): boolean {
  return canonicalNativeVoiceRuntimeTargetIdentity(actual) === expectedIdentity;
}

/**
 * Serializes the React-owned portion of native readiness provisioning. The
 * coordinator only retains non-secret fencing metadata; grant tokens flow
 * directly from the HTTP response into the native keystore adapter.
 */
export class NativeVoiceRuntimeProvisioningCoordinator {
  private currentEpoch = 0;
  private currentIntent: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private active: {
    readonly epoch: number;
    readonly result: NativeVoiceRuntimeProvisioningResult;
  } | null = null;
  private pendingDisableRuntimeId: VoiceNativeRuntimeId | null = null;
  private pendingRevocationRuntimeId: VoiceNativeRuntimeId | null = null;

  constructor(
    private readonly client: NativeRuntimeGrantClient,
    private readonly native: NativeVoiceRuntimeProvisioningAdapter,
  ) {}

  provision(
    input: NativeVoiceRuntimeProvisioningInput,
  ): Promise<NativeVoiceRuntimeProvisioningResult> {
    const intent = activationIntent(input);
    this.acceptEpoch(input.epoch, intent);
    return this.enqueue(async () => {
      this.assertCurrent(input.epoch);
      if (this.active?.epoch === input.epoch && this.currentIntent === intent) {
        return this.active.result;
      }
      await this.completePendingCleanup(input.epoch);
      await this.revokePending();
      this.assertCurrent(input.epoch);

      const expectedIdentity = canonicalNativeVoiceRuntimeTargetIdentity(
        input.resolvedTarget.target,
      );
      if (expectedIdentity !== input.resolvedTarget.targetIdentity) {
        throw new InvalidNativeVoiceRuntimeProvisioningResultError();
      }

      let reservation: NativeVoiceRuntimeReservation | null = null;
      try {
        reservation = await this.native.prepare({
          epoch: input.epoch,
          readiness: input.readiness,
          environmentOrigin: input.environmentOrigin,
          operation: input.operation,
          targetIdentity: input.resolvedTarget.targetIdentity,
        });
        assertValidReservation(reservation);
        this.assertCurrent(input.epoch);

        const grant = await Effect.runPromise(
          this.client.provisionNativeRuntimeGrant(reservation.runtimeId, {
            generation: reservation.readinessGeneration,
            target: input.resolvedTarget.target,
          }),
        );
        this.assertCurrent(input.epoch);
        if (
          grant.runtimeId !== reservation.runtimeId ||
          grant.generation !== reservation.readinessGeneration ||
          !targetMatches(grant.target, input.resolvedTarget.targetIdentity)
        ) {
          throw new InvalidNativeVoiceRuntimeProvisioningResultError();
        }

        const expiresAtEpochMillis = Date.parse(grant.expiresAt);
        if (!Number.isFinite(expiresAtEpochMillis)) {
          throw new InvalidNativeVoiceRuntimeProvisioningResultError();
        }
        await this.native.activate({
          runtimeId: grant.runtimeId,
          readinessGeneration: grant.generation,
          environmentOrigin: input.environmentOrigin,
          operation: input.operation,
          targetIdentity: input.resolvedTarget.targetIdentity,
          expiresAtEpochMillis,
          token: grant.token,
        });
        this.assertCurrent(input.epoch);

        const result = {
          runtimeId: grant.runtimeId,
          readinessGeneration: grant.generation,
          expiresAt: grant.expiresAt,
        } satisfies NativeVoiceRuntimeProvisioningResult;
        this.active = { epoch: input.epoch, result };
        return result;
      } catch (cause) {
        if (reservation !== null && !this.isCurrent(input.epoch)) {
          await this.disableThenRevoke(input.epoch, reservation.runtimeId).catch(() => undefined);
          throw new StaleNativeVoiceRuntimeProvisioningEpochError(input.epoch, this.currentEpoch);
        }
        if (cause instanceof InvalidNativeVoiceRuntimeProvisioningResultError) {
          await this.disableThenRevoke(input.epoch, reservation?.runtimeId ?? null).catch(
            () => undefined,
          );
        }
        throw cause;
      }
    });
  }

  disable(epoch: number): Promise<void> {
    this.acceptEpoch(epoch, "disable");
    return this.enqueue(async () => {
      this.assertCurrent(epoch);
      await this.disableThenRevoke(
        epoch,
        this.pendingDisableRuntimeId ??
          this.active?.result.runtimeId ??
          this.pendingRevocationRuntimeId,
      );
    });
  }

  private acceptEpoch(epoch: number, intent: string): void {
    assertValidEpoch(epoch);
    if (epoch < this.currentEpoch) {
      throw new StaleNativeVoiceRuntimeProvisioningEpochError(epoch, this.currentEpoch);
    }
    if (epoch === this.currentEpoch && this.currentIntent !== intent) {
      throw new ConflictingNativeVoiceRuntimeProvisioningEpochError(epoch);
    }
    if (epoch > this.currentEpoch) {
      this.currentEpoch = epoch;
      this.currentIntent = intent;
    }
  }

  private isCurrent(epoch: number): boolean {
    return epoch === this.currentEpoch;
  }

  private assertCurrent(epoch: number): void {
    if (!this.isCurrent(epoch)) {
      throw new StaleNativeVoiceRuntimeProvisioningEpochError(epoch, this.currentEpoch);
    }
  }

  private enqueue<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async disableNative(epoch: number): Promise<VoiceNativeRuntimeId | null> {
    const disabled = await this.native.disable({ epoch });
    return (
      disabled.runtimeId ??
      this.active?.result.runtimeId ??
      this.pendingDisableRuntimeId ??
      this.pendingRevocationRuntimeId
    );
  }

  private async disableThenRevoke(
    epoch: number,
    fallbackRuntimeId: VoiceNativeRuntimeId | null,
  ): Promise<void> {
    this.pendingDisableRuntimeId = fallbackRuntimeId;
    const runtimeId = (await this.disableNative(epoch)) ?? fallbackRuntimeId;
    this.pendingDisableRuntimeId = null;
    this.active = null;
    if (runtimeId === null) return;
    this.pendingRevocationRuntimeId = runtimeId;
    await this.revokePending();
  }

  private async completePendingCleanup(epoch: number): Promise<void> {
    if (this.pendingDisableRuntimeId === null) return;
    await this.disableThenRevoke(epoch, this.pendingDisableRuntimeId);
  }

  private async revokePending(): Promise<void> {
    const runtimeId = this.pendingRevocationRuntimeId;
    if (runtimeId === null) return;
    await Effect.runPromise(this.client.revokeNativeRuntimeGrant(runtimeId));
    if (this.pendingRevocationRuntimeId === runtimeId) {
      this.pendingRevocationRuntimeId = null;
    }
  }
}

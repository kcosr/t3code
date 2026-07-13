import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import { VoiceNativeRuntimeId, type VoiceNativeRuntimeTarget } from "@t3tools/contracts";
import type {
  T3VoiceBackgroundAuthoritySnapshot,
  T3VoiceBackgroundGrantOperation,
  T3VoiceBackgroundRuntimeGrantInput,
  T3VoiceBackgroundRuntimeRevocation,
  T3VoiceNativeModule,
  T3VoiceReadinessSnapshot,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  canonicalNativeVoiceRuntimeTargetIdentity,
  type ResolvedNativeVoiceRuntimeTarget,
} from "./nativeVoiceRuntimeTarget";

export type NativeRuntimeGrantClient = Pick<
  VoiceHttpClient,
  "provisionNativeRuntimeGrant" | "revokeNativeRuntimeGrant"
>;

export interface NativeVoiceRuntimeReservation {
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly readinessGeneration: number;
}

export interface NativeVoiceRuntimeProvisioningAdapter {
  /** Returns exact matching sanitized native authority without mutating it. */
  readonly inspect: (input: {
    readonly readiness: T3VoiceReadinessSnapshot;
    readonly environmentOrigin: string;
    readonly operation: T3VoiceBackgroundGrantOperation;
    readonly targetIdentity: string;
  }) => Promise<T3VoiceBackgroundAuthoritySnapshot | null>;
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
  /** Marks an exact active authority refresh as recoverable before the server PUT. */
  readonly beginRefresh: (input: {
    readonly runtimeId: VoiceNativeRuntimeId;
    readonly readinessGeneration: number;
    readonly environmentOrigin: string;
    readonly operation: T3VoiceBackgroundGrantOperation;
    readonly targetIdentity: string;
  }) => Promise<T3VoiceBackgroundAuthoritySnapshot>;
  /** Atomically replaces an exact authority's encrypted token and expiry. */
  readonly installRefresh: (
    input: T3VoiceBackgroundRuntimeGrantInput,
  ) => Promise<T3VoiceBackgroundAuthoritySnapshot>;
  /** Stops native work and clears credentials before server authority is revoked. */
  readonly disable: (input: {
    readonly epoch: number;
  }) => Promise<{ readonly runtimeId: VoiceNativeRuntimeId | null }>;
  readonly pendingRevocation: () => Promise<T3VoiceBackgroundRuntimeRevocation | null>;
  readonly acknowledgeRevocation: (input: T3VoiceBackgroundRuntimeRevocation) => Promise<void>;
}

export interface NativeVoiceRuntimeProvisioningInput {
  readonly epoch: number;
  readonly readiness: T3VoiceReadinessSnapshot;
  readonly environmentOrigin: string;
  readonly operation: T3VoiceBackgroundGrantOperation;
  readonly resolvedTarget: ResolvedNativeVoiceRuntimeTarget;
  readonly refreshRequested?: boolean;
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
    inspect: async (input) => {
      const result = await native.inspectBackgroundVoiceAuthorityAsync(input);
      if (result?.state === "prepared") {
        prepared = {
          runtimeId: VoiceNativeRuntimeId.make(result.runtimeId),
          generation: result.readiness.generation,
          readiness: input.readiness,
        };
      } else {
        prepared = null;
      }
      return result;
    },
    prepare: async ({ readiness, environmentOrigin, operation, targetIdentity }) => {
      const result = await native.prepareBackgroundVoiceReadinessAsync({
        readiness,
        runtimeId: createRuntimeId(),
        environmentOrigin,
        operation,
        targetIdentity,
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
    beginRefresh: (input) => native.beginBackgroundVoiceGrantRefreshAsync(input),
    installRefresh: async (grant) => native.installBackgroundVoiceRuntimeGrantAsync({ grant }),
    disable: async () => {
      prepared = null;
      const disabled = await native.disableBackgroundVoiceReadinessAsync();
      return {
        runtimeId:
          disabled.runtimeId === null ? null : VoiceNativeRuntimeId.make(disabled.runtimeId),
      };
    },
    pendingRevocation: () => native.getPendingBackgroundVoiceRuntimeRevocationAsync(),
    acknowledgeRevocation: (input) =>
      native.acknowledgeBackgroundVoiceRuntimeRevocationAsync(input),
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

export class PendingNativeVoiceRuntimeRevocationOriginError extends Error {
  readonly name = "PendingNativeVoiceRuntimeRevocationOriginError";

  constructor(
    readonly pendingOrigin: string,
    readonly requestedOrigin: string,
  ) {
    super("A pending native voice authority belongs to a different environment.");
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
    environmentOrigin: new URL(input.environmentOrigin).origin,
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

export function nativeVoiceRuntimeRefreshAt(
  expiresAtEpochMillis: number,
  nowEpochMillis: number,
): number {
  if (
    !Number.isSafeInteger(expiresAtEpochMillis) ||
    !Number.isSafeInteger(nowEpochMillis) ||
    expiresAtEpochMillis <= nowEpochMillis
  ) {
    return nowEpochMillis;
  }
  const remaining = expiresAtEpochMillis - nowEpochMillis;
  const refreshLead = Math.min(24 * 60 * 60 * 1_000, Math.max(60_000, remaining * 0.2));
  return Math.max(nowEpochMillis, expiresAtEpochMillis - refreshLead);
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
    readonly intent: string;
    readonly client: NativeRuntimeGrantClient;
    readonly environmentOrigin: string;
    readonly result: NativeVoiceRuntimeProvisioningResult;
  } | null = null;

  constructor(private readonly native: NativeVoiceRuntimeProvisioningAdapter) {}

  provision(
    client: NativeRuntimeGrantClient,
    input: NativeVoiceRuntimeProvisioningInput,
  ): Promise<NativeVoiceRuntimeProvisioningResult> {
    const intent = activationIntent(input);
    this.acceptEpoch(input.epoch, intent);
    return this.enqueue(async () => {
      this.assertCurrent(input.epoch);
      let nativeAuthorityCleared = false;
      if (
        this.active !== null &&
        (this.active.intent !== intent ||
          this.active.environmentOrigin !== new URL(input.environmentOrigin).origin)
      ) {
        const previous = this.active;
        await this.native.disable({ epoch: input.epoch });
        await this.drainPendingRevocation(previous.client, previous.environmentOrigin);
        this.active = null;
        nativeAuthorityCleared = true;
        this.assertCurrent(input.epoch);
      }
      await this.drainPendingRevocation(client, input.environmentOrigin);
      this.assertCurrent(input.epoch);

      const expectedIdentity = canonicalNativeVoiceRuntimeTargetIdentity(
        input.resolvedTarget.target,
      );
      if (expectedIdentity !== input.resolvedTarget.targetIdentity) {
        throw new InvalidNativeVoiceRuntimeProvisioningResultError();
      }

      const adopted = await this.native.inspect({
        readiness: input.readiness,
        environmentOrigin: input.environmentOrigin,
        operation: input.operation,
        targetIdentity: input.resolvedTarget.targetIdentity,
      });
      this.assertCurrent(input.epoch);
      if (adopted?.state === "active") {
        const result = this.resultFromSnapshot(adopted);
        if (input.refreshRequested === true || adopted.refreshPending) {
          return this.refresh(client, input, intent, adopted);
        }
        this.active = {
          epoch: input.epoch,
          intent,
          client,
          environmentOrigin: new URL(input.environmentOrigin).origin,
          result,
        };
        return result;
      }

      if (adopted === null && !nativeAuthorityCleared) {
        await this.native.disable({ epoch: input.epoch });
        await this.drainPendingRevocation(client, input.environmentOrigin);
        this.assertCurrent(input.epoch);
      }

      let reservation: NativeVoiceRuntimeReservation | null =
        adopted?.state === "prepared"
          ? {
              runtimeId: VoiceNativeRuntimeId.make(adopted.runtimeId),
              readinessGeneration: adopted.readiness.generation,
            }
          : null;
      try {
        reservation ??= await this.native.prepare({
          epoch: input.epoch,
          readiness: input.readiness,
          environmentOrigin: input.environmentOrigin,
          operation: input.operation,
          targetIdentity: input.resolvedTarget.targetIdentity,
        });
        assertValidReservation(reservation);
        this.assertCurrent(input.epoch);

        const grant = await this.issueGrant(client, input, reservation);
        this.assertCurrent(input.epoch);

        const expiresAtEpochMillis = Date.parse(grant.expiresAt);
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
        this.active = {
          epoch: input.epoch,
          intent,
          client,
          environmentOrigin: new URL(input.environmentOrigin).origin,
          result,
        };
        return result;
      } catch (cause) {
        if (!this.isCurrent(input.epoch)) {
          if (this.currentIntent !== intent) {
            await this.native.disable({ epoch: input.epoch });
            await this.drainPendingRevocation(client, input.environmentOrigin);
          }
          throw new StaleNativeVoiceRuntimeProvisioningEpochError(input.epoch, this.currentEpoch);
        }
        if (cause instanceof InvalidNativeVoiceRuntimeProvisioningResultError) {
          await this.native.disable({ epoch: input.epoch });
          await this.drainPendingRevocation(client, input.environmentOrigin);
        }
        throw cause;
      }
    });
  }

  disable(
    epoch: number,
    fallback?: {
      readonly client: NativeRuntimeGrantClient;
      readonly environmentOrigin: string;
    },
  ): Promise<void> {
    this.acceptEpoch(epoch, "disable");
    return this.enqueue(async () => {
      this.assertCurrent(epoch);
      const endpoint = this.active ?? fallback;
      if (endpoint === undefined) {
        const pending = await this.native.pendingRevocation();
        if (pending !== null) {
          throw new PendingNativeVoiceRuntimeRevocationOriginError(
            pending.environmentOrigin,
            "unknown",
          );
        }
        await this.native.disable({ epoch });
        this.active = null;
        return;
      }
      await this.native.disable({ epoch });
      await this.drainPendingRevocation(endpoint.client, endpoint.environmentOrigin);
      this.active = null;
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

  private async drainPendingRevocation(
    client: NativeRuntimeGrantClient,
    environmentOrigin: string,
  ): Promise<void> {
    const pending = await this.native.pendingRevocation();
    if (pending === null) return;
    const normalizedOrigin = new URL(environmentOrigin).origin;
    if (pending.environmentOrigin !== normalizedOrigin) {
      throw new PendingNativeVoiceRuntimeRevocationOriginError(
        pending.environmentOrigin,
        normalizedOrigin,
      );
    }
    await Effect.runPromise(
      client.revokeNativeRuntimeGrant(VoiceNativeRuntimeId.make(pending.runtimeId)),
    );
    await this.native.acknowledgeRevocation(pending);
  }

  private async issueGrant(
    client: NativeRuntimeGrantClient,
    input: NativeVoiceRuntimeProvisioningInput,
    reservation: NativeVoiceRuntimeReservation,
  ) {
    const grant = await Effect.runPromise(
      client.provisionNativeRuntimeGrant(reservation.runtimeId, {
        generation: reservation.readinessGeneration,
        target: input.resolvedTarget.target,
      }),
    );
    if (
      grant.runtimeId !== reservation.runtimeId ||
      grant.generation !== reservation.readinessGeneration ||
      !targetMatches(grant.target, input.resolvedTarget.targetIdentity) ||
      !Number.isFinite(Date.parse(grant.expiresAt))
    ) {
      throw new InvalidNativeVoiceRuntimeProvisioningResultError();
    }
    return grant;
  }

  private resultFromSnapshot(
    snapshot: T3VoiceBackgroundAuthoritySnapshot,
  ): NativeVoiceRuntimeProvisioningResult {
    if (
      snapshot.state !== "active" ||
      snapshot.expiresAtEpochMillis === null ||
      !Number.isSafeInteger(snapshot.expiresAtEpochMillis) ||
      snapshot.expiresAtEpochMillis <= 0
    ) {
      throw new InvalidNativeVoiceRuntimeProvisioningResultError();
    }
    return {
      runtimeId: VoiceNativeRuntimeId.make(snapshot.runtimeId),
      readinessGeneration: snapshot.readiness.generation,
      expiresAt: new Date(snapshot.expiresAtEpochMillis).toISOString(),
    };
  }

  private async refresh(
    client: NativeRuntimeGrantClient,
    input: NativeVoiceRuntimeProvisioningInput,
    intent: string,
    snapshot: T3VoiceBackgroundAuthoritySnapshot,
  ): Promise<NativeVoiceRuntimeProvisioningResult> {
    const reservation = {
      runtimeId: VoiceNativeRuntimeId.make(snapshot.runtimeId),
      readinessGeneration: snapshot.readiness.generation,
    } satisfies NativeVoiceRuntimeReservation;
    if (!snapshot.refreshPending) {
      await this.native.beginRefresh({
        runtimeId: reservation.runtimeId,
        readinessGeneration: reservation.readinessGeneration,
        environmentOrigin: input.environmentOrigin,
        operation: input.operation,
        targetIdentity: input.resolvedTarget.targetIdentity,
      });
    }
    this.assertCurrent(input.epoch);
    const grant = await this.issueGrant(client, input, reservation);
    this.assertCurrent(input.epoch);
    const installed = await this.native.installRefresh({
      runtimeId: grant.runtimeId,
      readinessGeneration: grant.generation,
      environmentOrigin: input.environmentOrigin,
      operation: input.operation,
      targetIdentity: input.resolvedTarget.targetIdentity,
      expiresAtEpochMillis: Date.parse(grant.expiresAt),
      token: grant.token,
    });
    this.assertCurrent(input.epoch);
    const result = this.resultFromSnapshot(installed);
    this.active = {
      epoch: input.epoch,
      intent,
      client,
      environmentOrigin: new URL(input.environmentOrigin).origin,
      result,
    };
    return result;
  }
}

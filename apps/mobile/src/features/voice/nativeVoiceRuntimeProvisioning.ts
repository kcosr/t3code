import {
  computeVoiceRuntimeTargetDigest,
  type VoiceHttpClient,
} from "@t3tools/client-runtime/voice";
import {
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceRuntimeCredentialHash,
  VoiceRuntimeTargetDigest,
  type VoiceRuntimeAuthorityReservation,
  type VoiceRuntimeGrant,
} from "@t3tools/contracts";
import type {
  T3VoiceNativeModule,
  T3VoiceReadinessSnapshot,
  T3VoiceRuntimeAuthorityRevocation,
  T3VoiceRuntimeAuthoritySnapshot,
  T3VoiceRuntimeGrantOperation,
  T3VoiceRuntimeOwnership,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ResolvedNativeVoiceRuntimeTarget } from "./nativeVoiceRuntimeTarget";

export type NativeRuntimeGrantClient = Pick<
  VoiceHttpClient,
  "provisionVoiceRuntimeGrant" | "revokeVoiceRuntimeGrant"
>;

export interface NativeVoiceRuntimeReservation {
  readonly runtimeId: VoiceRuntimeId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly provisioningOperationId: VoiceRuntimeProvisioningOperationId;
  readonly expectedCurrentGeneration: number;
  readonly generation: number;
  readonly targetDigest: VoiceRuntimeTargetDigest;
  readonly refreshCredentialHash: VoiceRuntimeCredentialHash | null;
}

export interface NativeVoiceRuntimeProvisioningAdapter {
  readonly inspect: () => Promise<T3VoiceRuntimeAuthoritySnapshot | null>;
  /**
   * Reserves native readiness state. Repeating an identical epoch after a failed
   * request must return the same authority reservation and credential hash.
   */
  readonly prepare: (input: {
    readonly epoch: number;
    readonly readiness: T3VoiceReadinessSnapshot;
    readonly environmentOrigin: string;
    readonly operation: T3VoiceRuntimeGrantOperation;
    readonly resolvedTarget: ResolvedNativeVoiceRuntimeTarget;
  }) => Promise<NativeVoiceRuntimeReservation>;
  readonly activate: (input: VoiceRuntimeAuthorityReservation) => Promise<void>;
  /** Stops native work and clears credentials before server authority is revoked. */
  readonly disable: (input: {
    readonly epoch: number;
  }) => Promise<{ readonly runtimeId: VoiceRuntimeId | null }>;
  /** Atomically disables only the exact idle authority observed by React. */
  readonly disableIfIdle: (input: {
    readonly expectedRuntimeId: VoiceRuntimeId | null;
    readonly expectedGeneration: number | null;
  }) => Promise<boolean>;
  readonly ownership: () => Promise<T3VoiceRuntimeOwnership | null>;
  readonly pendingRevocation: () => Promise<T3VoiceRuntimeAuthorityRevocation | null>;
  readonly acknowledgeRevocation: (input: T3VoiceRuntimeAuthorityRevocation) => Promise<void>;
}

export interface NativeVoiceRuntimeProvisioningInput {
  readonly epoch: number;
  readonly readiness: T3VoiceReadinessSnapshot;
  readonly environmentOrigin: string;
  readonly resolvedTarget: ResolvedNativeVoiceRuntimeTarget;
  readonly resolvePendingRevocationEndpoint?: (
    environmentOrigin: string,
  ) => Promise<NativeVoiceRuntimeRevocationEndpointResolution>;
  readonly retireUnresolvableRevocation?: boolean;
}

export function makeNativeVoiceRuntimeProvisioningAdapter(
  native: T3VoiceNativeModule,
  createId: () => string,
  activateAuthority: (input: VoiceRuntimeAuthorityReservation) => Promise<void>,
): NativeVoiceRuntimeProvisioningAdapter {
  return {
    inspect: () => native.inspectVoiceRuntimeAuthorityAsync(),
    prepare: async ({ readiness, environmentOrigin, operation, resolvedTarget }) => {
      const snapshot = await native.getVoiceRuntimeSnapshotAsync();
      const expectedCurrentGeneration = snapshot.generation;
      const generation = expectedCurrentGeneration + 1;
      const targetDigest = VoiceRuntimeTargetDigest.make(
        await computeVoiceRuntimeTargetDigest(resolvedTarget.target),
      );
      const provisioningOperationId = VoiceRuntimeProvisioningOperationId.make(createId());
      const input = {
        readiness,
        runtimeId: snapshot.runtimeId,
        runtimeInstanceId: snapshot.runtimeInstanceId,
        provisioningOperationId,
        expectedCurrentGeneration,
        generation,
        targetDigest,
        target: resolvedTarget.target,
        environmentOrigin,
        operation,
      };
      const result = await native.prepareVoiceRuntimeAuthorityAsync(input);
      if (
        result.runtimeId !== input.runtimeId ||
        result.runtimeInstanceId !== input.runtimeInstanceId ||
        result.provisioningOperationId !== input.provisioningOperationId ||
        result.expectedCurrentGeneration !== input.expectedCurrentGeneration ||
        result.generation !== input.generation ||
        result.targetDigest !== input.targetDigest ||
        result.readinessEnabled !== input.readiness.enabled
      ) {
        throw new InvalidNativeVoiceRuntimeProvisioningResultError();
      }
      return {
        runtimeId: VoiceRuntimeId.make(result.runtimeId),
        runtimeInstanceId: VoiceRuntimeInstanceId.make(result.runtimeInstanceId),
        provisioningOperationId: VoiceRuntimeProvisioningOperationId.make(
          result.provisioningOperationId,
        ),
        expectedCurrentGeneration: result.expectedCurrentGeneration,
        generation: result.generation,
        targetDigest: VoiceRuntimeTargetDigest.make(result.targetDigest),
        refreshCredentialHash:
          result.refreshCredentialHash === null
            ? null
            : VoiceRuntimeCredentialHash.make(result.refreshCredentialHash),
      };
    },
    activate: activateAuthority,
    disable: async () => {
      const disabled = await native.disableVoiceRuntimeReadinessAsync();
      return {
        runtimeId: VoiceRuntimeId.make(disabled.runtimeId),
      };
    },
    disableIfIdle: async (input) => {
      const disabled = await native.clearVoiceRuntimeAuthorityIfIdleAsync({
        runtimeId: input.expectedRuntimeId,
        generation: input.expectedGeneration,
      });
      if (disabled === null) return false;
      return true;
    },
    ownership: () => native.getVoiceRuntimeOwnershipAsync(),
    pendingRevocation: () => native.getPendingVoiceRuntimeAuthorityRevocationAsync(),
    acknowledgeRevocation: (input) => native.acknowledgeVoiceRuntimeAuthorityRevocationAsync(input),
  };
}

export interface NativeVoiceRuntimeProvisioningResult {
  readonly runtimeId: VoiceRuntimeId;
  readonly generation: number;
}

export type NativeVoiceRuntimeRevocationEndpointResolution =
  | {
      readonly type: "available";
      readonly client: NativeRuntimeGrantClient;
      readonly environmentOrigin: string;
    }
  | { readonly type: "unavailable" }
  | { readonly type: "absent" };

export async function resolveNativeVoiceRuntimeRevocationEndpoint<
  ConnectionId,
  Prepared extends { readonly httpBaseUrl: string },
>(input: {
  readonly environmentOrigin: string;
  readonly connections: ReadonlyArray<{
    readonly id: ConnectionId;
    readonly httpBaseUrl: string;
  }>;
  readonly getPrepared: (id: ConnectionId) => Prepared | null;
  readonly prepare?: (id: ConnectionId) => Promise<Prepared | null>;
  readonly makeClient: (prepared: Prepared) => Promise<NativeRuntimeGrantClient>;
}): Promise<NativeVoiceRuntimeRevocationEndpointResolution> {
  const expectedOrigin = new URL(input.environmentOrigin).origin;
  let matchingSavedConnection = false;
  for (const connection of input.connections) {
    let connectionOrigin: string;
    try {
      connectionOrigin = new URL(connection.httpBaseUrl).origin;
    } catch {
      continue;
    }
    if (connectionOrigin !== expectedOrigin) continue;
    matchingSavedConnection = true;
    const prepared =
      input.getPrepared(connection.id) ?? (await input.prepare?.(connection.id)) ?? null;
    if (prepared === null || new URL(prepared.httpBaseUrl).origin !== expectedOrigin) continue;
    return {
      type: "available",
      client: await input.makeClient(prepared),
      environmentOrigin: expectedOrigin,
    };
  }
  return { type: matchingSavedConnection ? "unavailable" : "absent" };
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

export class NativeVoiceRuntimeReplacementDeferredError extends Error {
  readonly name = "NativeVoiceRuntimeReplacementDeferredError";

  constructor(readonly reconciliationKey: string | null = null) {
    super("Native Realtime media became active before authority replacement.");
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
  const operation = grantOperationForTarget(input.resolvedTarget.target);
  return encodeProvisioningIntent({
    kind: "activate",
    readiness: input.readiness,
    environmentOrigin: new URL(input.environmentOrigin).origin,
    operation,
    targetIdentity: input.resolvedTarget.targetIdentity,
  });
}

function grantOperationForTarget(
  target: ResolvedNativeVoiceRuntimeTarget["target"],
): T3VoiceRuntimeGrantOperation {
  return target.mode === "realtime" ? "realtime-start" : "thread-turn-start";
}

function assertValidEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new RangeError("Native voice runtime provisioning epochs must be positive integers.");
  }
}

function assertValidReservation(reservation: NativeVoiceRuntimeReservation): void {
  if (
    String(reservation.runtimeId).length === 0 ||
    String(reservation.runtimeInstanceId).length === 0 ||
    !Number.isSafeInteger(reservation.expectedCurrentGeneration) ||
    reservation.expectedCurrentGeneration < 0 ||
    reservation.generation !== reservation.expectedCurrentGeneration + 1
  ) {
    throw new InvalidNativeVoiceRuntimeProvisioningResultError();
  }
}

function authorityMatches(
  authority: T3VoiceRuntimeAuthoritySnapshot,
  input: NativeVoiceRuntimeProvisioningInput,
  targetDigest: VoiceRuntimeTargetDigest,
): boolean {
  return (
    authority.environmentOrigin === new URL(input.environmentOrigin).origin &&
    authority.operation === grantOperationForTarget(input.resolvedTarget.target) &&
    authority.targetDigest === targetDigest &&
    authority.readinessEnabled === input.readiness.enabled
  );
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
        if (!(await this.disableForReplacement(input, this.active.result))) {
          throw new NativeVoiceRuntimeReplacementDeferredError();
        }
        const previous = this.active;
        await this.drainPendingRevocation(previous.client, previous.environmentOrigin);
        this.active = null;
        nativeAuthorityCleared = true;
        this.assertCurrent(input.epoch);
      }
      await this.reconcilePendingRevocationBeforeProvision(client, input);
      this.assertCurrent(input.epoch);

      const targetDigest = VoiceRuntimeTargetDigest.make(
        await computeVoiceRuntimeTargetDigest(input.resolvedTarget.target),
      );
      const inspected = await this.native.inspect();
      const adopted =
        inspected !== null && authorityMatches(inspected, input, targetDigest) ? inspected : null;
      this.assertCurrent(input.epoch);
      if (adopted?.state === "active") {
        const result = this.resultFromSnapshot(adopted);
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
        if (!(await this.disableForReplacement(input, null))) {
          throw new NativeVoiceRuntimeReplacementDeferredError();
        }
        await this.drainPendingRevocation(client, input.environmentOrigin);
        this.assertCurrent(input.epoch);
      }

      let reservation: NativeVoiceRuntimeReservation | null =
        adopted?.state === "prepared"
          ? {
              runtimeId: VoiceRuntimeId.make(adopted.runtimeId),
              runtimeInstanceId: VoiceRuntimeInstanceId.make(adopted.runtimeInstanceId),
              provisioningOperationId: VoiceRuntimeProvisioningOperationId.make(
                adopted.provisioningOperationId,
              ),
              expectedCurrentGeneration: adopted.expectedCurrentGeneration,
              generation: adopted.generation,
              targetDigest: VoiceRuntimeTargetDigest.make(adopted.targetDigest),
              refreshCredentialHash:
                adopted.refreshCredentialHash === null
                  ? null
                  : VoiceRuntimeCredentialHash.make(adopted.refreshCredentialHash),
            }
          : null;
      try {
        reservation ??= await this.native.prepare({
          epoch: input.epoch,
          readiness: input.readiness,
          environmentOrigin: input.environmentOrigin,
          operation: grantOperationForTarget(input.resolvedTarget.target),
          resolvedTarget: input.resolvedTarget,
        });
        assertValidReservation(reservation);
        if ((reservation.refreshCredentialHash !== null) !== input.readiness.enabled) {
          throw new InvalidNativeVoiceRuntimeProvisioningResultError();
        }
        this.assertCurrent(input.epoch);

        const grant = await this.issueGrant(client, input, reservation);
        this.assertCurrent(input.epoch);

        const activation = {
          runtimeId: grant.runtimeId,
          runtimeInstanceId: reservation.runtimeInstanceId,
          expectedCurrentGeneration: reservation.expectedCurrentGeneration,
          generation: grant.generation,
          environmentOrigin: input.environmentOrigin,
          targetDigest: grant.targetDigest,
          readinessEnabled: input.readiness.enabled,
          provisioningOperationId: grant.provisioningOperationId,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
          refreshRotationCounter: grant.refreshRotationCounter,
          token: grant.token,
        } as const;
        if (grant.operation === "realtime-start" && grant.target.mode === "realtime") {
          await this.native.activate({
            ...activation,
            operation: "realtime-start",
            target: grant.target,
          });
        } else if (grant.operation === "thread-turn-start" && grant.target.mode === "thread") {
          await this.native.activate({
            ...activation,
            operation: "thread-turn-start",
            target: grant.target,
          });
        } else {
          throw new InvalidNativeVoiceRuntimeProvisioningResultError();
        }
        this.assertCurrent(input.epoch);

        const result = {
          runtimeId: grant.runtimeId,
          generation: grant.generation,
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
            if (await this.disableObservedIdle(input.environmentOrigin, null)) {
              await this.drainPendingRevocation(client, input.environmentOrigin);
            }
          }
          throw new StaleNativeVoiceRuntimeProvisioningEpochError(input.epoch, this.currentEpoch);
        }
        if (cause instanceof InvalidNativeVoiceRuntimeProvisioningResultError) {
          if (!(await this.disableForReplacement(input, null))) {
            throw new NativeVoiceRuntimeReplacementDeferredError();
          }
          await this.drainPendingRevocation(client, input.environmentOrigin);
        }
        const ownership = await this.native.ownership().catch(() => null);
        if (ownership?.active === true || (ownership !== null && ownership.phase !== "idle")) {
          throw new NativeVoiceRuntimeReplacementDeferredError();
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

  disableIfIdle(
    epoch: number,
    options?: {
      readonly fallback?: {
        readonly client: NativeRuntimeGrantClient;
        readonly environmentOrigin: string;
      };
      readonly resolveEndpoint?: (
        environmentOrigin: string,
      ) => Promise<NativeVoiceRuntimeRevocationEndpointResolution>;
      readonly retireUnresolvableRevocation?: boolean;
    },
  ): Promise<boolean> {
    this.acceptEpoch(epoch, "disable");
    return this.enqueue(async () => {
      this.assertCurrent(epoch);
      if ((await this.native.pendingRevocation()) !== null) {
        await this.reconcilePendingDisableRevocation(options);
        this.active = null;
        return true;
      }
      const ownership = await this.native.ownership();
      this.assertCurrent(epoch);
      if (ownership?.active === true || (ownership !== null && ownership.phase !== "idle")) {
        return false;
      }
      const disabled = await this.native.disableIfIdle({
        expectedRuntimeId:
          ownership?.runtimeId === null || ownership?.runtimeId === undefined
            ? null
            : VoiceRuntimeId.make(ownership.runtimeId),
        expectedGeneration: ownership?.generation ?? null,
      });
      this.assertCurrent(epoch);
      if (!disabled) return false;
      await this.reconcilePendingDisableRevocation(options);
      this.active = null;
      return true;
    });
  }

  private async reconcilePendingDisableRevocation(options?: {
    readonly fallback?: {
      readonly client: NativeRuntimeGrantClient;
      readonly environmentOrigin: string;
    };
    readonly resolveEndpoint?: (
      environmentOrigin: string,
    ) => Promise<NativeVoiceRuntimeRevocationEndpointResolution>;
    readonly retireUnresolvableRevocation?: boolean;
  }): Promise<void> {
    const pending = await this.native.pendingRevocation();
    if (pending !== null) {
      const endpoints = [
        ...(this.active === null ? [] : [this.active]),
        ...(options?.fallback === undefined ? [] : [options.fallback]),
      ];
      let endpoint = endpoints.find(
        (candidate) => new URL(candidate.environmentOrigin).origin === pending.environmentOrigin,
      );
      const resolved =
        endpoint === undefined && options?.resolveEndpoint !== undefined
          ? await options.resolveEndpoint(pending.environmentOrigin)
          : null;
      if (resolved?.type === "available") endpoint = resolved;
      if (endpoint !== undefined) {
        await this.drainPendingRevocation(endpoint.client, endpoint.environmentOrigin);
      } else if (resolved?.type === "unavailable") {
        throw new NativeVoiceRuntimeReplacementDeferredError(pending.environmentOrigin);
      } else if (
        options?.retireUnresolvableRevocation === true &&
        (options.resolveEndpoint === undefined || resolved?.type === "absent")
      ) {
        console.warn("[voice] retiring an unresolvable native runtime revocation", {
          runtimeId: pending.runtimeId,
        });
        await this.native.acknowledgeRevocation(pending);
      } else {
        const observedOrigin =
          this.active?.environmentOrigin ?? options?.fallback?.environmentOrigin;
        throw new PendingNativeVoiceRuntimeRevocationOriginError(
          pending.environmentOrigin,
          observedOrigin === undefined ? "unknown" : new URL(observedOrigin).origin,
        );
      }
    }
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
    await Effect.runPromise(client.revokeVoiceRuntimeGrant(VoiceRuntimeId.make(pending.runtimeId)));
    await this.native.acknowledgeRevocation(pending);
  }

  private async reconcilePendingRevocationBeforeProvision(
    client: NativeRuntimeGrantClient,
    input: NativeVoiceRuntimeProvisioningInput,
  ): Promise<void> {
    const pending = await this.native.pendingRevocation();
    if (pending === null) return;
    const requestedOrigin = new URL(input.environmentOrigin).origin;
    if (pending.environmentOrigin === requestedOrigin) {
      await this.drainPendingRevocation(client, requestedOrigin);
      return;
    }
    const resolved = await input.resolvePendingRevocationEndpoint?.(pending.environmentOrigin);
    if (resolved?.type === "available") {
      await this.drainPendingRevocation(resolved.client, resolved.environmentOrigin);
      return;
    }
    if (resolved?.type === "unavailable") {
      throw new NativeVoiceRuntimeReplacementDeferredError(pending.environmentOrigin);
    }
    if (resolved?.type === "absent" && input.retireUnresolvableRevocation === true) {
      console.warn("[voice] retiring an unresolvable native runtime revocation", {
        runtimeId: pending.runtimeId,
      });
      await this.native.acknowledgeRevocation(pending);
      return;
    }
    throw new PendingNativeVoiceRuntimeRevocationOriginError(
      pending.environmentOrigin,
      requestedOrigin,
    );
  }

  private async issueGrant(
    client: NativeRuntimeGrantClient,
    input: NativeVoiceRuntimeProvisioningInput,
    reservation: NativeVoiceRuntimeReservation,
  ) {
    const base = {
      expectedCurrentGeneration: reservation.expectedCurrentGeneration,
      generation: reservation.generation,
      provisioningOperationId: reservation.provisioningOperationId,
      targetDigest: reservation.targetDigest,
    } as const;
    const target = input.resolvedTarget.target;
    const refreshCredentialHash = reservation.refreshCredentialHash;
    let grant: VoiceRuntimeGrant;
    if (input.readiness.enabled) {
      if (refreshCredentialHash === null) {
        throw new InvalidNativeVoiceRuntimeProvisioningResultError();
      }
      grant = await Effect.runPromise(
        target.mode === "realtime"
          ? client.provisionVoiceRuntimeGrant(reservation.runtimeId, {
              ...base,
              operation: "realtime-start",
              target,
              readinessEnabled: true,
              refreshCredentialHash,
            })
          : client.provisionVoiceRuntimeGrant(reservation.runtimeId, {
              ...base,
              operation: "thread-turn-start",
              target,
              readinessEnabled: true,
              refreshCredentialHash,
            }),
      );
    } else {
      grant = await Effect.runPromise(
        target.mode === "realtime"
          ? client.provisionVoiceRuntimeGrant(reservation.runtimeId, {
              ...base,
              operation: "realtime-start",
              target,
              readinessEnabled: false,
              refreshCredentialHash: null,
            })
          : client.provisionVoiceRuntimeGrant(reservation.runtimeId, {
              ...base,
              operation: "thread-turn-start",
              target,
              readinessEnabled: false,
              refreshCredentialHash: null,
            }),
      );
    }
    const expectedOperation = grantOperationForTarget(target);
    const responseTargetDigest = VoiceRuntimeTargetDigest.make(
      await computeVoiceRuntimeTargetDigest(grant.target),
    );
    if (
      grant.runtimeId !== reservation.runtimeId ||
      grant.generation !== reservation.generation ||
      grant.provisioningOperationId !== reservation.provisioningOperationId ||
      grant.targetDigest !== reservation.targetDigest ||
      grant.operation !== expectedOperation ||
      grant.target.mode !== target.mode ||
      responseTargetDigest !== reservation.targetDigest ||
      grant.readinessEnabled !== input.readiness.enabled ||
      !Number.isSafeInteger(grant.refreshRotationCounter) ||
      grant.refreshRotationCounter < 0 ||
      !Number.isFinite(Date.parse(grant.issuedAt)) ||
      !Number.isFinite(Date.parse(grant.expiresAt))
    ) {
      throw new InvalidNativeVoiceRuntimeProvisioningResultError();
    }
    return grant;
  }

  private async disableForReplacement(
    input: NativeVoiceRuntimeProvisioningInput,
    known: NativeVoiceRuntimeProvisioningResult | null,
  ): Promise<boolean> {
    const ownership = await this.native.ownership();
    this.assertCurrent(input.epoch);
    const inputOrigin = new URL(input.environmentOrigin).origin;
    if (known === null && ownership !== null && ownership.environmentOrigin !== inputOrigin) {
      throw new PendingNativeVoiceRuntimeRevocationOriginError(
        ownership.environmentOrigin,
        inputOrigin,
      );
    }
    return this.native.disableIfIdle({
      expectedRuntimeId:
        known?.runtimeId ??
        (ownership?.runtimeId === null || ownership?.runtimeId === undefined
          ? null
          : VoiceRuntimeId.make(ownership.runtimeId)),
      expectedGeneration: known?.generation ?? ownership?.generation ?? null,
    });
  }

  private async disableObservedIdle(
    environmentOrigin: string,
    known: NativeVoiceRuntimeProvisioningResult | null,
  ): Promise<boolean> {
    const ownership = await this.native.ownership();
    const inputOrigin = new URL(environmentOrigin).origin;
    if (ownership !== null && ownership.environmentOrigin !== inputOrigin) return false;
    return this.native.disableIfIdle({
      expectedRuntimeId:
        known?.runtimeId ??
        (ownership?.runtimeId === null || ownership?.runtimeId === undefined
          ? null
          : VoiceRuntimeId.make(ownership.runtimeId)),
      expectedGeneration: known?.generation ?? ownership?.generation ?? null,
    });
  }

  private resultFromSnapshot(
    snapshot: T3VoiceRuntimeAuthoritySnapshot,
  ): NativeVoiceRuntimeProvisioningResult {
    if (snapshot.state !== "active" || !Number.isFinite(Date.parse(snapshot.expiresAt))) {
      throw new InvalidNativeVoiceRuntimeProvisioningResultError();
    }
    return {
      runtimeId: VoiceRuntimeId.make(snapshot.runtimeId),
      generation: snapshot.generation,
    };
  }
}

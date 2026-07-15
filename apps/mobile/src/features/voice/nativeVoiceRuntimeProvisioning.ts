import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import { VoiceRuntimeId, type VoiceRuntimeAuthorityReservation } from "@t3tools/contracts";
import type {
  T3VoiceNativeModule,
  T3VoiceReadinessSnapshot,
  T3VoiceRuntimeOwnership,
} from "@t3tools/mobile-voice-native";
import * as Effect from "effect/Effect";

import type { ResolvedNativeVoiceRuntimeTarget } from "./nativeVoiceRuntimeTarget";

export type NativeRuntimeAuthClient = Pick<
  VoiceHttpClient,
  "bearerSessionCredential" | "configureVoiceRuntimeAuthority" | "clearVoiceRuntimeAuthority"
>;

export interface NativeVoiceRuntimeProvisioningAdapter {
  readonly reserve: (input: {
    readonly readiness: T3VoiceReadinessSnapshot;
    readonly environmentOrigin: string;
    readonly resolvedTarget: ResolvedNativeVoiceRuntimeTarget;
  }) => Promise<VoiceRuntimeAuthorityReservation>;
  readonly setSessionCredential: (input: {
    readonly environmentOrigin: string;
    readonly credential: string;
  }) => Promise<void>;
  readonly activate: (input: VoiceRuntimeAuthorityReservation) => Promise<void>;
  readonly disable: () => Promise<{ readonly runtimeId: VoiceRuntimeId | null }>;
  readonly disableIfIdle: (input: {
    readonly expectedRuntimeId: VoiceRuntimeId | null;
    readonly expectedGeneration: number | null;
  }) => Promise<boolean>;
  readonly ownership: () => Promise<T3VoiceRuntimeOwnership | null>;
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
  activateAuthority: (input: VoiceRuntimeAuthorityReservation) => Promise<void>,
): NativeVoiceRuntimeProvisioningAdapter {
  return {
    reserve: async ({ readiness, environmentOrigin, resolvedTarget }) => {
      const snapshot = await native.getVoiceRuntimeSnapshotAsync();
      return {
        runtimeId: snapshot.runtimeId,
        runtimeInstanceId: snapshot.runtimeInstanceId,
        expectedCurrentGeneration: snapshot.generation,
        generation: snapshot.generation + 1,
        target: resolvedTarget.target,
        environmentOrigin: new URL(environmentOrigin).origin,
        readinessEnabled: readiness.enabled,
      } as VoiceRuntimeAuthorityReservation;
    },
    setSessionCredential: (input) => native.setVoiceRuntimeSessionCredentialAsync(input),
    activate: activateAuthority,
    disable: async () => {
      const disabled = await native.disableVoiceRuntimeReadinessAsync();
      return { runtimeId: VoiceRuntimeId.make(disabled.runtimeId) };
    },
    disableIfIdle: async (input) =>
      (await native.clearVoiceRuntimeAuthorityIfIdleAsync({
        runtimeId: input.expectedRuntimeId,
        generation: input.expectedGeneration,
      })) !== null,
    ownership: () => native.getVoiceRuntimeOwnershipAsync(),
  };
}

export interface NativeVoiceRuntimeProvisioningResult {
  readonly runtimeId: VoiceRuntimeId;
  readonly generation: number;
}

export type NativeVoiceRuntimeRevocationEndpointResolution =
  | {
      readonly type: "available";
      readonly client: NativeRuntimeAuthClient;
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
  readonly makeClient: (prepared: Prepared) => Promise<NativeRuntimeAuthClient>;
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
    super("The native voice runtime epoch was reused for a different target.");
  }
}

export class InvalidNativeVoiceRuntimeProvisioningResultError extends Error {
  readonly name = "InvalidNativeVoiceRuntimeProvisioningResultError";
  constructor() {
    super("The native voice runtime returned an invalid authority result.");
  }
}

export class NativeVoiceRuntimeReplacementDeferredError extends Error {
  readonly name = "NativeVoiceRuntimeReplacementDeferredError";
  readonly reconciliationKey: string | undefined;
  constructor(readonly environmentOrigin?: string) {
    super("Native voice runtime replacement is deferred until the current operation is idle.");
    this.reconciliationKey = environmentOrigin;
  }
}

const intentFor = (input: NativeVoiceRuntimeProvisioningInput) =>
  JSON.stringify({
    environmentOrigin: new URL(input.environmentOrigin).origin,
    target: input.resolvedTarget.target,
    readiness: input.readiness,
  });

export class NativeVoiceRuntimeProvisioningCoordinator {
  private currentEpoch = 0;
  private currentIntent: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private active: {
    readonly client: NativeRuntimeAuthClient;
    readonly environmentOrigin: string;
    readonly result: NativeVoiceRuntimeProvisioningResult;
  } | null = null;

  constructor(private readonly native: NativeVoiceRuntimeProvisioningAdapter) {}

  provision(
    client: NativeRuntimeAuthClient,
    input: NativeVoiceRuntimeProvisioningInput,
  ): Promise<NativeVoiceRuntimeProvisioningResult> {
    const intent = intentFor(input);
    this.acceptEpoch(input.epoch, intent);
    return this.enqueue(async () => {
      this.assertCurrent(input.epoch);
      const origin = new URL(input.environmentOrigin).origin;
      if (client.bearerSessionCredential === null) {
        throw new InvalidNativeVoiceRuntimeProvisioningResultError();
      }
      const ownership = await this.native.ownership();
      if (this.active === null && ownership !== null && ownership.environmentOrigin !== origin) {
        if (ownership.active || ownership.phase !== "idle") {
          throw new NativeVoiceRuntimeReplacementDeferredError(ownership.environmentOrigin);
        }
        const resolution = await input.resolvePendingRevocationEndpoint?.(
          ownership.environmentOrigin,
        );
        if (resolution?.type !== "available" && input.retireUnresolvableRevocation !== true) {
          throw new NativeVoiceRuntimeReplacementDeferredError(ownership.environmentOrigin);
        }
        const priorRuntimeId =
          ownership.runtimeId === null ? null : VoiceRuntimeId.make(ownership.runtimeId);
        const cleared = await this.native.disableIfIdle({
          expectedRuntimeId: priorRuntimeId,
          expectedGeneration: ownership.generation,
        });
        if (!cleared) {
          throw new NativeVoiceRuntimeReplacementDeferredError(ownership.environmentOrigin);
        }
        if (priorRuntimeId !== null && resolution?.type === "available") {
          await Effect.runPromise(resolution.client.clearVoiceRuntimeAuthority(priorRuntimeId));
        }
      }
      if (this.active !== null && this.active.environmentOrigin !== origin) {
        const cleared = await this.native.disableIfIdle({
          expectedRuntimeId: this.active.result.runtimeId,
          expectedGeneration: this.active.result.generation,
        });
        if (!cleared) throw new NativeVoiceRuntimeReplacementDeferredError();
        await Effect.runPromise(
          this.active.client.clearVoiceRuntimeAuthority(this.active.result.runtimeId),
        );
        this.active = null;
      }
      const reservation = await this.native.reserve({
        readiness: input.readiness,
        environmentOrigin: origin,
        resolvedTarget: input.resolvedTarget,
      });
      this.assertCurrent(input.epoch);
      const authority = await Effect.runPromise(
        client.configureVoiceRuntimeAuthority(reservation.runtimeId, {
          expectedCurrentGeneration: reservation.expectedCurrentGeneration,
          generation: reservation.generation,
          target: reservation.target,
        }),
      );
      if (
        authority.runtimeId !== reservation.runtimeId ||
        authority.generation !== reservation.generation ||
        JSON.stringify(authority.target) !== JSON.stringify(reservation.target)
      ) {
        throw new InvalidNativeVoiceRuntimeProvisioningResultError();
      }
      await this.native.setSessionCredential({
        environmentOrigin: origin,
        credential: client.bearerSessionCredential,
      });
      await this.native.activate(reservation);
      this.assertCurrent(input.epoch);
      const result = { runtimeId: reservation.runtimeId, generation: reservation.generation };
      this.active = { client, environmentOrigin: origin, result };
      return result;
    });
  }

  disable(
    epoch: number,
    fallback?: { readonly client: NativeRuntimeAuthClient; readonly environmentOrigin: string },
  ): Promise<void> {
    this.acceptEpoch(epoch, "disable");
    return this.enqueue(async () => {
      this.assertCurrent(epoch);
      const disabled = await this.native.disable();
      const endpoint = this.active ?? fallback;
      if (disabled.runtimeId !== null && endpoint !== undefined) {
        await Effect.runPromise(endpoint.client.clearVoiceRuntimeAuthority(disabled.runtimeId));
      }
      this.active = null;
    });
  }

  disableIfIdle(
    epoch: number,
    options?: {
      readonly fallback?: {
        readonly client: NativeRuntimeAuthClient;
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
      const ownership = await this.native.ownership();
      if (ownership?.active === true || (ownership !== null && ownership.phase !== "idle")) {
        return false;
      }
      const runtimeId =
        ownership?.runtimeId === null || ownership?.runtimeId === undefined
          ? null
          : VoiceRuntimeId.make(ownership.runtimeId);
      let endpoint = this.active ?? options?.fallback;
      if (endpoint === undefined && ownership !== null && options?.resolveEndpoint !== undefined) {
        const resolution = await options.resolveEndpoint(ownership.environmentOrigin);
        if (resolution.type === "available") {
          endpoint = {
            client: resolution.client,
            environmentOrigin: resolution.environmentOrigin,
          };
        } else if (options.retireUnresolvableRevocation !== true) {
          return false;
        }
      }
      const cleared = await this.native.disableIfIdle({
        expectedRuntimeId: runtimeId,
        expectedGeneration: ownership?.generation ?? null,
      });
      if (!cleared) return false;
      if (runtimeId !== null && endpoint !== undefined) {
        await Effect.runPromise(endpoint.client.clearVoiceRuntimeAuthority(runtimeId));
      }
      this.active = null;
      return true;
    });
  }

  private acceptEpoch(epoch: number, intent: string): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new RangeError("Native voice runtime epochs must be positive safe integers.");
    }
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

  private assertCurrent(epoch: number): void {
    if (epoch !== this.currentEpoch) {
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
}

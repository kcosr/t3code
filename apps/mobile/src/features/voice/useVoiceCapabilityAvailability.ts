import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  VoiceCapabilities,
  VoiceCapability,
  VoiceCapabilityDescriptor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { makeMobileVoiceClient } from "./mobileVoiceClient";

interface CapabilityCacheEntry {
  readonly promise: Promise<VoiceCapabilities>;
  settled: boolean;
  expiresAt: number;
}

export interface VoiceCapabilityLoadOptions {
  readonly load?: () => Promise<VoiceCapabilities>;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

const CAPABILITY_CACHE_TTL_MS = 30_000;
const capabilityRequests = new WeakMap<PreparedConnection, CapabilityCacheEntry>();

export function loadVoiceCapabilities(
  prepared: PreparedConnection,
  options: VoiceCapabilityLoadOptions = {},
): Promise<VoiceCapabilities> {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? CAPABILITY_CACHE_TTL_MS;
  if (cacheTtlMs < 0) throw new Error("Voice capability cache TTL must be non-negative");
  const cached = capabilityRequests.get(prepared);
  if (cached !== undefined && (!cached.settled || cached.expiresAt > now())) {
    return cached.promise;
  }

  const load =
    options.load ??
    (async () => {
      const client = await makeMobileVoiceClient(prepared);
      return Effect.runPromise(client.capabilities());
    });
  let entry: CapabilityCacheEntry;
  const promise = Promise.resolve()
    .then(load)
    .then(
      (result) => {
        entry.settled = true;
        entry.expiresAt = now() + cacheTtlMs;
        return result;
      },
      (cause: unknown) => {
        if (capabilityRequests.get(prepared) === entry) capabilityRequests.delete(prepared);
        throw cause;
      },
    );
  entry = { promise, settled: false, expiresAt: Number.NEGATIVE_INFINITY };
  capabilityRequests.set(prepared, entry);
  return promise;
}

export function watchVoiceCapabilities(
  prepared: PreparedConnection,
  listener: (capabilities: VoiceCapabilities | null) => void,
  options: VoiceCapabilityLoadOptions = {},
): () => void {
  const refreshIntervalMs = Math.max(1, options.cacheTtlMs ?? CAPABILITY_CACHE_TTL_MS);
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRefresh = () => {
    refreshTimer = setTimeout(refresh, refreshIntervalMs);
  };
  const refresh = () => {
    void loadVoiceCapabilities(prepared, options).then(
      (result) => {
        if (disposed) return;
        listener(result);
        scheduleRefresh();
      },
      () => {
        if (disposed) return;
        listener(null);
        scheduleRefresh();
      },
    );
  };
  refresh();

  return () => {
    disposed = true;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
  };
}

export function useVoiceCapabilityDescriptor(
  prepared: PreparedConnection | null,
  capability: VoiceCapability,
): VoiceCapabilityDescriptor | null {
  const [descriptor, setDescriptor] = useState<VoiceCapabilityDescriptor | null>(null);

  useEffect(() => {
    setDescriptor(null);
    if (prepared === null) return;

    return watchVoiceCapabilities(prepared, (result) => {
      if (result === null) {
        setDescriptor(null);
      } else {
        setDescriptor(
          result.capabilities.find(
            (candidate) => candidate.capability === capability && candidate.state === "ready",
          ) ?? null,
        );
      }
    });
  }, [capability, prepared]);

  return descriptor;
}

export function useVoiceCapabilityAvailability(
  prepared: PreparedConnection | null,
  capability: VoiceCapability,
): boolean {
  return useVoiceCapabilityDescriptor(prepared, capability) !== null;
}

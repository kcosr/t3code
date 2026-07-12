import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { VoiceCapability, VoiceCapabilityDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { makeMobileVoiceClient } from "./mobileVoiceClient";

export function useVoiceCapabilityDescriptor(
  prepared: PreparedConnection | null,
  capability: VoiceCapability,
): VoiceCapabilityDescriptor | null {
  const [descriptor, setDescriptor] = useState<VoiceCapabilityDescriptor | null>(null);

  useEffect(() => {
    let disposed = false;
    setDescriptor(null);
    if (prepared === null) return;

    void makeMobileVoiceClient(prepared)
      .then((client) => Effect.runPromise(client.capabilities()))
      .then((result) => {
        if (disposed) return;
        setDescriptor(
          result.capabilities.find(
            (candidate) => candidate.capability === capability && candidate.state === "ready",
          ) ?? null,
        );
      })
      .catch(() => {
        if (!disposed) setDescriptor(null);
      });

    return () => {
      disposed = true;
    };
  }, [capability, prepared]);

  return descriptor;
}

export function useVoiceCapabilityAvailability(
  prepared: PreparedConnection | null,
  capability: VoiceCapability,
): boolean {
  return useVoiceCapabilityDescriptor(prepared, capability) !== null;
}

import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { VoiceCapability } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { makeMobileVoiceClient } from "./mobileVoiceClient";

export function useVoiceCapabilityAvailability(
  prepared: PreparedConnection | null,
  capability: VoiceCapability,
): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let disposed = false;
    setAvailable(false);
    if (prepared === null) return;

    void makeMobileVoiceClient(prepared)
      .then((client) => Effect.runPromise(client.capabilities()))
      .then((result) => {
        if (disposed) return;
        setAvailable(
          result.capabilities.some(
            (descriptor) => descriptor.capability === capability && descriptor.state === "ready",
          ),
        );
      })
      .catch(() => {
        if (!disposed) setAvailable(false);
      });

    return () => {
      disposed = true;
    };
  }, [capability, prepared]);

  return available;
}

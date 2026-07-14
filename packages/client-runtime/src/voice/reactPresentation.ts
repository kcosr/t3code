import { useEffect, useRef, useSyncExternalStore } from "react";
import type { VoiceRuntimePresentationState } from "@t3tools/contracts";

import type {
  VoiceRuntimePresentationBinding,
  VoiceRuntimePresentationBindingSnapshot,
  VoiceRuntimePresentationHandle,
} from "./presentationBinding.ts";

/** Attaches one React tree as a presentation-only VoiceRuntime consumer. */
export function useVoiceRuntimePresentation(
  binding: VoiceRuntimePresentationBinding,
  presentation: VoiceRuntimePresentationState,
): VoiceRuntimePresentationBindingSnapshot {
  const handleRef = useRef<VoiceRuntimePresentationHandle | null>(null);
  const snapshot = useSyncExternalStore(
    binding.subscribe,
    binding.getSnapshot,
    binding.getSnapshot,
  );

  useEffect(() => {
    const handle = binding.acquire(presentation);
    handleRef.current = handle;
    void handle.ready.catch(() => undefined);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      void handle.release().catch(() => undefined);
    };
  }, [binding]);

  useEffect(() => {
    void handleRef.current?.updatePresentation(presentation).catch(() => undefined);
  }, [binding, presentation]);

  return snapshot;
}

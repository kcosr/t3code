import type {
  VoiceRuntime,
  VoiceRuntimeDelivery,
  VoiceRuntimeFactory,
  VoiceRuntimeSubscriptionInput,
} from "@t3tools/client-runtime/voice";
import type {
  VoiceRuntimeConsumerLease,
  VoiceRuntimeCursor,
  VoiceRuntimeEvent,
} from "@t3tools/contracts";
import {
  getT3VoiceNativeModule,
  type T3VoiceNativeModule,
  type T3VoiceRuntimeReadDelivery,
  type T3VoiceRuntimeWakeEvent,
} from "@t3tools/mobile-voice-native";

type AndroidVoiceRuntimeNative = Pick<
  T3VoiceNativeModule,
  | "addListener"
  | "describeVoiceRuntimeAsync"
  | "getVoiceRuntimeSnapshotAsync"
  | "configureVoiceRuntimeAuthorityAsync"
  | "clearVoiceRuntimeAuthorityAsync"
  | "attachVoiceRuntimeAsync"
  | "updateVoiceRuntimeAttachmentAsync"
  | "detachVoiceRuntimeAsync"
  | "readVoiceRuntimeAsync"
  | "acknowledgeVoiceRuntimeAsync"
  | "dispatchVoiceRuntimeAsync"
  | "readVoiceRuntimeDraftArtifactAsync"
  | "acknowledgeVoiceRuntimeDraftArtifactAsync"
  | "claimVoiceRuntimePresentationActionAsync"
  | "acknowledgeVoiceRuntimePresentationActionAsync"
>;

function eventCursor(event: VoiceRuntimeDelivery) {
  return "type" in event
    ? event.cursor
    : {
        runtimeId: event.runtimeId,
        runtimeInstanceId: event.runtimeInstanceId,
        generation: event.authorityGeneration,
        sequence: event.sequence,
      };
}

function isEventForLease(event: VoiceRuntimeEvent, lease: VoiceRuntimeConsumerLease): boolean {
  return (
    event.runtimeId === lease.runtimeId &&
    event.runtimeInstanceId === lease.runtimeInstanceId &&
    event.authorityGeneration === lease.generation
  );
}

function isNewerCursor(current: VoiceRuntimeCursor | null, next: VoiceRuntimeCursor): boolean {
  if (current === null) return true;
  if (
    current.runtimeId !== next.runtimeId ||
    current.runtimeInstanceId !== next.runtimeInstanceId ||
    current.generation !== next.generation
  ) {
    return true;
  }
  return next.sequence > current.sequence;
}

export function createAndroidVoiceRuntime(native: AndroidVoiceRuntimeNative): VoiceRuntime {
  return {
    describe: () => native.describeVoiceRuntimeAsync(),
    getSnapshot: () => native.getVoiceRuntimeSnapshotAsync(),
    configureAuthority: (input) => native.configureVoiceRuntimeAuthorityAsync(input),
    clearAuthority: (input) => native.clearVoiceRuntimeAuthorityAsync(input),
    attach: (input) => native.attachVoiceRuntimeAsync(input),
    updateAttachment: (input) => native.updateVoiceRuntimeAttachmentAsync(input),
    detach: (input) => native.detachVoiceRuntimeAsync(input),
    acknowledge: (input) => native.acknowledgeVoiceRuntimeAsync(input),
    dispatch: (input) => native.dispatchVoiceRuntimeAsync(input),
    readDraftArtifact: (input) => native.readVoiceRuntimeDraftArtifactAsync(input),
    acknowledgeDraftArtifact: (input) => native.acknowledgeVoiceRuntimeDraftArtifactAsync(input),
    claimPresentationAction: (input) => native.claimVoiceRuntimePresentationActionAsync(input),
    acknowledgePresentationAction: (input) =>
      native.acknowledgeVoiceRuntimePresentationActionAsync(input),
    subscribe: (input, listener) => subscribeToNativeRuntime(native, input, listener),
  };
}

export const androidVoiceRuntimeFactory: VoiceRuntimeFactory = {
  create: () => {
    const native = getT3VoiceNativeModule();
    if (native === null) throw new Error("The Android voice runtime is not available.");
    return createAndroidVoiceRuntime(native);
  },
};

function subscribeToNativeRuntime(
  native: AndroidVoiceRuntimeNative,
  input: VoiceRuntimeSubscriptionInput,
  listener: (delivery: VoiceRuntimeDelivery) => void,
): () => void {
  let cursor = input.after;
  let stopped = false;
  let draining = false;
  let requested = true;

  const requestDrain = (): void => {
    if (stopped) return;
    requested = true;
    void drain().catch(() => {
      if (!stopped) setTimeout(requestDrain, 250);
    });
  };

  const drain = async (): Promise<void> => {
    if (stopped || draining) {
      requested = !stopped;
      return;
    }
    draining = true;
    try {
      while (requested) {
        if (stopped) return;
        requested = false;
        const delivery: T3VoiceRuntimeReadDelivery = await native.readVoiceRuntimeAsync({
          lease: input.lease,
          after: cursor,
        });
        if (stopped) return;
        if (delivery.type === "rebase") {
          if (!isNewerCursor(cursor, delivery.cursor)) continue;
          cursor = delivery.cursor;
          listener(delivery);
          requested = true;
          continue;
        }
        if (delivery.events.length === 0) continue;
        for (const event of delivery.events) {
          if (stopped) return;
          if (!isEventForLease(event, input.lease)) continue;
          const nextCursor = eventCursor(event);
          if (!isNewerCursor(cursor, nextCursor)) continue;
          cursor = nextCursor;
          listener(event);
        }
        requested = true;
      }
    } finally {
      draining = false;
      if (requested && !stopped) requestDrain();
    }
  };

  const subscription = native.addListener("voiceRuntimeWake", (wake: T3VoiceRuntimeWakeEvent) => {
    if (
      wake.runtimeId !== input.lease.runtimeId ||
      wake.runtimeInstanceId !== input.lease.runtimeInstanceId ||
      wake.generation !== input.lease.generation ||
      (cursor !== null && wake.sequence <= cursor.sequence)
    ) {
      return;
    }
    requestDrain();
  });
  requestDrain();

  return () => {
    stopped = true;
    subscription.remove();
  };
}

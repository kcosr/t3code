import {
  VoiceModeSessionId,
  VoiceRuntimeConsumerLeaseId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  type VoiceRuntimeConsumerLease,
  type VoiceRuntimeEvent,
} from "@t3tools/contracts";
import type {
  T3VoiceNativeModule,
  T3VoiceRuntimeReadDelivery,
  T3VoiceRuntimeWakeEvent,
} from "@t3tools/mobile-voice-native";
import { describe, expect, it, vi } from "vitest";

vi.mock("@t3tools/mobile-voice-native", () => ({
  getT3VoiceNativeModule: () => null,
}));

import { createAndroidVoiceRuntime } from "./androidVoiceRuntime";

const runtimeId = VoiceRuntimeId.make("android-runtime");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("android-runtime-instance");
const lease: VoiceRuntimeConsumerLease = {
  leaseId: VoiceRuntimeConsumerLeaseId.make("android-lease"),
  runtimeId,
  runtimeInstanceId,
  generation: 1,
  leaseGeneration: 1,
  attachOrdinal: 1,
  presentation: "foreground-active",
  election: "elected",
  expiresAt: "2026-07-13T13:00:00.000Z",
};

function terminal(sequence: number): VoiceRuntimeEvent {
  return {
    runtimeId,
    runtimeInstanceId,
    authorityGeneration: 1,
    sequence,
    occurredAt: "2026-07-13T12:00:00.000Z",
    root: { kind: "mode", modeSessionId: VoiceModeSessionId.make("android-mode") },
    kind: "operation-terminal",
    outcome: "completed",
  };
}

describe("createAndroidVoiceRuntime", () => {
  it("flattens native batches and drains again after a matching wake", async () => {
    const listeners = new Set<(event: T3VoiceRuntimeWakeEvent) => void>();
    const deliveries: T3VoiceRuntimeReadDelivery[] = [
      { type: "events", events: [terminal(1)] },
      { type: "events", events: [] },
      { type: "events", events: [terminal(2)] },
      { type: "events", events: [] },
    ];
    const read = vi.fn(async () => deliveries.shift() ?? { type: "events", events: [] });
    const native = {
      addListener: (
        _name: "voiceRuntimeWake",
        listener: (event: T3VoiceRuntimeWakeEvent) => void,
      ) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
      readVoiceRuntimeAsync: read,
    } as unknown as T3VoiceNativeModule;
    const runtime = createAndroidVoiceRuntime(native);
    const received: Array<number> = [];
    const unsubscribe = runtime.subscribe({ lease, after: null }, (event) => {
      if (!("type" in event)) received.push(event.sequence);
    });

    await vi.waitFor(() => expect(received).toEqual([1]));
    for (const listener of listeners) {
      listener({ runtimeId, runtimeInstanceId, generation: 1, sequence: 2 });
    }
    await vi.waitFor(() => expect(received).toEqual([1, 2]));
    expect(read).toHaveBeenLastCalledWith({
      lease,
      after: { runtimeId, runtimeInstanceId, generation: 1, sequence: 2 },
    });

    unsubscribe();
    expect(listeners).toHaveLength(0);
  });

  it("ignores wakes from stale runtime instances", async () => {
    const listeners = new Set<(event: T3VoiceRuntimeWakeEvent) => void>();
    const read = vi.fn(async () => ({ type: "events" as const, events: [] }));
    const native = {
      addListener: (
        _name: "voiceRuntimeWake",
        listener: (event: T3VoiceRuntimeWakeEvent) => void,
      ) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
      readVoiceRuntimeAsync: read,
    } as unknown as T3VoiceNativeModule;
    const runtime = createAndroidVoiceRuntime(native);
    const unsubscribe = runtime.subscribe({ lease, after: null }, () => undefined);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    for (const listener of listeners)
      listener({
        runtimeId,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("stale-instance"),
        generation: 1,
        sequence: 1,
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(read).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("filters stale, duplicate, and wrong-fence events without moving the read cursor back", async () => {
    const staleInstance = VoiceRuntimeInstanceId.make("stale-runtime-instance");
    const wrongFence = { ...terminal(4), runtimeInstanceId: staleInstance };
    const deliveries: T3VoiceRuntimeReadDelivery[] = [
      {
        type: "events",
        events: [terminal(2), terminal(1), terminal(2), wrongFence, terminal(3)],
      },
      { type: "events", events: [] },
    ];
    const read = vi.fn(async () => deliveries.shift() ?? { type: "events", events: [] });
    const native = {
      addListener: () => ({ remove: () => undefined }),
      readVoiceRuntimeAsync: read,
    } as unknown as T3VoiceNativeModule;
    const runtime = createAndroidVoiceRuntime(native);
    const received: number[] = [];

    const unsubscribe = runtime.subscribe(
      {
        lease,
        after: { runtimeId, runtimeInstanceId, generation: 1, sequence: 1 },
      },
      (event) => {
        if (!("type" in event)) received.push(event.sequence);
      },
    );

    await vi.waitFor(() => expect(received).toEqual([2, 3]));
    await vi.waitFor(() =>
      expect(read).toHaveBeenLastCalledWith({
        lease,
        after: { runtimeId, runtimeInstanceId, generation: 1, sequence: 3 },
      }),
    );
    unsubscribe();
  });
});

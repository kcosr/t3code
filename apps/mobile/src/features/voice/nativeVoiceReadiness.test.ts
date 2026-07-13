import { describe, expect, it, vi } from "vitest";

import {
  NativeVoiceControllerGeneration,
  NativeVoiceCommandDeduplicator,
  NativeVoiceCommandCompletionGate,
  NativeVoiceForegroundCommandGate,
  completeNativeVoiceCommandSafely,
  NativeThreadCommandActivationCoordinator,
  NativeVoiceOperationEpoch,
  completeNativeVoiceCommandAttempt,
  disabledNativeVoiceReadiness,
  isNextNativeReadinessGeneration,
  reconcilePendingNativeReadinessDisable,
  resolveNativeVoiceReadiness,
  scheduleNativeVoiceCommandFailure,
} from "./nativeVoiceReadiness";

describe("native voice readiness", () => {
  it("does not expose readiness until the user opts in", () => {
    expect(
      resolveNativeVoiceReadiness({}, "environment-1", {
        microphonePermissionGranted: true,
        notificationPermissionGranted: true,
        threadTargetValid: false,
      }),
    ).toEqual(disabledNativeVoiceReadiness());
  });

  it("mirrors realtime preferences without secret connection state", () => {
    expect(
      resolveNativeVoiceReadiness(
        {
          voiceBackgroundControlsEnabled: true,
          voiceBackgroundDefaultMode: "realtime",
          voiceAudioRouteId: "speaker",
          voiceAutoListenEnabled: true,
        },
        "environment-1",
        {
          microphonePermissionGranted: true,
          notificationPermissionGranted: true,
          threadTargetValid: false,
        },
      ),
    ).toEqual({
      enabled: true,
      mode: "realtime",
      targetId: null,
      audioRouteId: "speaker",
      autoRearm: true,
      microphonePermissionGranted: true,
      notificationPermissionGranted: true,
    });
  });

  it("rejects a thread target from another environment", () => {
    expect(
      resolveNativeVoiceReadiness(
        {
          voiceBackgroundControlsEnabled: true,
          voiceBackgroundDefaultMode: "thread",
          voiceThreadTarget: {
            environmentId: "environment-2",
            threadId: "thread-1",
            generation: 1,
          },
        },
        "environment-1",
        {
          microphonePermissionGranted: true,
          notificationPermissionGranted: true,
          threadTargetValid: false,
        },
      ),
    ).toMatchObject({ enabled: false, mode: "thread", targetId: null });
  });

  it("keeps opted-in readiness disabled when either permission is revoked", () => {
    expect(
      resolveNativeVoiceReadiness(
        {
          voiceBackgroundControlsEnabled: true,
          voiceBackgroundDefaultMode: "realtime",
        },
        "environment-1",
        {
          microphonePermissionGranted: true,
          notificationPermissionGranted: false,
          threadTargetValid: false,
        },
      ),
    ).toMatchObject({
      enabled: false,
      microphonePermissionGranted: true,
      notificationPermissionGranted: false,
    });
  });

  it("fences commands from replaced controller registrations", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const generations = new NativeVoiceControllerGeneration();
    const first = generations.register(1);
    const second = generations.register(2);
    expect(first).toBe(101);
    expect(second).toBe(102);
    expect(
      generations.accepts({
        commandId: "old",
        command: "primary",
        controllerGeneration: first,
        readinessGeneration: 2,
      }),
    ).toBe(false);
    expect(
      generations.accepts({
        commandId: "current",
        command: "primary",
        controllerGeneration: second,
        readinessGeneration: 2,
      }),
    ).toBe(true);
    expect(
      generations.accepts({
        commandId: "stale-readiness",
        command: "primary",
        controllerGeneration: second,
        readinessGeneration: 1,
      }),
    ).toBe(false);
    generations.invalidate(second);
    expect(
      generations.accepts({
        commandId: "current",
        command: "primary",
        controllerGeneration: second,
        readinessGeneration: 2,
      }),
    ).toBe(false);
    vi.restoreAllMocks();
  });

  it("completes the exact failed activation so a replay can retry", async () => {
    const complete = vi.fn(async () => undefined);
    const event = {
      commandId: "command-1",
      command: "primary" as const,
      controllerGeneration: 12,
      readinessGeneration: 4,
    };
    await expect(
      completeNativeVoiceCommandAttempt(event, async () => false, complete),
    ).resolves.toBe("failure");
    expect(complete).toHaveBeenCalledWith({
      commandId: "command-1",
      controllerGeneration: 12,
      outcome: "failure",
    });

    await expect(
      completeNativeVoiceCommandAttempt(event, async () => true, complete),
    ).resolves.toBe("success");
    expect(complete).toHaveBeenLastCalledWith({
      commandId: "command-1",
      controllerGeneration: 12,
      outcome: "success",
    });
  });

  it("reports thrown starts as failed completions", async () => {
    const complete = vi.fn(async () => undefined);
    const event = {
      commandId: "command-2",
      command: "primary" as const,
      controllerGeneration: 13,
      readinessGeneration: 5,
    };
    await expect(
      completeNativeVoiceCommandAttempt(
        event,
        async () => {
          throw new Error("start failed");
        },
        complete,
      ),
    ).rejects.toThrow("start failed");
    expect(complete).toHaveBeenCalledWith({
      commandId: "command-2",
      controllerGeneration: 13,
      outcome: "failure",
    });
  });

  it("accepts only the immediate native disable generation", () => {
    expect(isNextNativeReadinessGeneration(4, 5)).toBe(true);
    expect(isNextNativeReadinessGeneration(4, 4)).toBe(false);
    expect(isNextNativeReadinessGeneration(4, 6)).toBe(false);
    expect(isNextNativeReadinessGeneration(null, 1)).toBe(true);
  });

  it("persists and acknowledges a replayed disable before readiness can be rewritten", async () => {
    const order: string[] = [];
    const event = { readinessGeneration: 8, reason: "notification" as const };
    await expect(
      reconcilePendingNativeReadinessDisable({
        getPending: async () => {
          order.push("get");
          return event;
        },
        persistDisabled: async () => {
          order.push("persist");
        },
        acknowledge: async () => {
          order.push("acknowledge");
        },
      }),
    ).resolves.toEqual(event);
    expect(order).toEqual(["get", "persist", "acknowledge"]);
  });

  it("does not acknowledge a replayed disable when durable persistence fails", async () => {
    const acknowledge = vi.fn(async () => undefined);
    await expect(
      reconcilePendingNativeReadinessDisable({
        getPending: async () => ({ readinessGeneration: 9, reason: "notification" }),
        persistDisabled: async () => {
          throw new Error("storage unavailable");
        },
        acknowledge,
      }),
    ).rejects.toThrow("storage unavailable");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("fences an older async readiness epoch before it can publish state", async () => {
    const operations = new NativeVoiceOperationEpoch();
    const first = operations.begin();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const published: string[] = [];
    const old = operations.run(first, async () => {
      await firstGate;
      operations.assertCurrent(first);
      published.push("old");
    });
    operations.invalidate(first);
    const second = operations.begin();
    releaseFirst();
    await expect(old).rejects.toThrow("Stale native voice readiness operation");
    await operations.run(second, async () => {
      published.push("new");
    });
    expect(published).toEqual(["new"]);
  });

  it("deduplicates a command delivered live and again by pending replay", () => {
    const commands = new NativeVoiceCommandDeduplicator();
    expect(commands.claim("command-1")).toBe(true);
    expect(commands.claim("command-1")).toBe(false);
    commands.release("command-1");
    expect(commands.claim("command-1")).toBe(true);
  });

  it("retains a background command until React remains active", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const gate = new NativeVoiceForegroundCommandGate(300, dispatch);

    gate.enqueue("command-1");
    vi.advanceTimersByTime(1_000);
    expect(dispatch).not.toHaveBeenCalled();

    gate.setActive(true);
    vi.advanceTimersByTime(299);
    expect(dispatch).not.toHaveBeenCalled();
    gate.setActive(false);
    vi.advanceTimersByTime(1_000);
    expect(dispatch).not.toHaveBeenCalled();

    gate.setActive(true);
    vi.advanceTimersByTime(300);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("command-1");
    gate.dispose();
    vi.useRealTimers();
  });

  it("dispatches realtime commands immediately while React is backgrounded", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const gate = new NativeVoiceForegroundCommandGate(300, dispatch);

    gate.enqueue("realtime-command", "realtime");

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("realtime-command");
    vi.runAllTimers();
    expect(dispatch).toHaveBeenCalledOnce();
    gate.dispose();
    vi.useRealTimers();
  });

  it("settles stale native completions without an unhandled rejection", async () => {
    const settled = vi.fn();

    await expect(
      completeNativeVoiceCommandSafely(async () => {
        throw new Error("stale controller generation");
      }, settled),
    ).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("does not dispatch a queued command after controller disposal", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const gate = new NativeVoiceForegroundCommandGate(300, dispatch);
    gate.enqueue("command-1");
    gate.setActive(true);
    gate.dispose();
    vi.runAllTimers();
    expect(dispatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("allows only one completion winner for a thread command", () => {
    const completions = new NativeVoiceCommandCompletionGate();
    completions.begin("command-1");
    expect(completions.claim("command-1")).toBe(true);
    expect(completions.claim("command-1")).toBe(false);
  });

  it("fails an unclaimed thread command at its bounded deadline", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const cancel = scheduleNativeVoiceCommandFailure("command-1", 10_000, fail);
    vi.advanceTimersByTime(9_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith("command-1");
    cancel();
    vi.useRealTimers();
  });

  it("cancels the deadline after completion and accepts a fresh command", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const cancel = scheduleNativeVoiceCommandFailure("command-1", 10_000, fail);
    cancel();
    vi.runAllTimers();
    expect(fail).not.toHaveBeenCalled();

    const completions = new NativeVoiceCommandCompletionGate();
    completions.begin("command-1");
    expect(completions.claim("command-1")).toBe(true);
    completions.begin("command-2");
    expect(completions.claim("command-2")).toBe(true);
    vi.useRealTimers();
  });

  it("activates a thread command exactly once across callback identity changes", async () => {
    const coordinator = new NativeThreadCommandActivationCoordinator();
    const activate = vi.fn(async () => true);
    const replacementActivate = vi.fn(async () => true);
    const complete = vi.fn(async () => undefined);

    expect(coordinator.start("command-1", activate, complete)).toBe(true);
    expect(coordinator.start("command-1", replacementActivate, complete)).toBe(false);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());

    expect(activate).toHaveBeenCalledOnce();
    expect(replacementActivate).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("command-1", "success");
  });

  it("retains completion ownership after the initiating view unmounts", async () => {
    const coordinator = new NativeThreadCommandActivationCoordinator();
    let finishActivation!: (activated: boolean) => void;
    const activation = new Promise<boolean>((resolve) => {
      finishActivation = resolve;
    });
    const complete = vi.fn(async () => undefined);

    coordinator.start("command-2", () => activation, complete);
    // No component cleanup is required: the coordinator owns this terminal completion.
    finishActivation(false);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());

    expect(complete).toHaveBeenCalledWith("command-2", "failure");
  });
});

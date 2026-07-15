import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceRuntimeCommandId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { FakeVoiceRuntime } from "./fakeRuntime.ts";
import { VoiceRuntimeController } from "./runtimeController.ts";

const now = Date.parse("2026-07-13T12:00:00.000Z");
const runtimeId = VoiceRuntimeId.make("runtime-controller");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("runtime-controller-instance");

async function configuredRuntime() {
  const runtime = new FakeVoiceRuntime({ runtimeId, runtimeInstanceId, now: () => now });
  const target = {
    mode: "realtime" as const,
    environmentId: EnvironmentId.make("environment-controller"),
    conversationId: VoiceConversationId.make("conversation-controller"),
  };
  await runtime.configureAuthority({
    runtimeId,
    runtimeInstanceId,
    expectedCurrentGeneration: 0,
    generation: 1,
    target,
    environmentOrigin: "https://termstation",
    readinessEnabled: true,
  });
  return runtime;
}

describe("VoiceRuntimeController", () => {
  it("attaches, reduces ordered events, and owns command fences", async () => {
    const runtime = await configuredRuntime();
    const states = vi.fn();
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-controller"),
      onState: states,
    });

    const attached = await controller.start("foreground-active");
    expect(attached.lease.election).toBe("elected");

    const receipt = await controller.dispatch({
      kind: "start-realtime",
      modeSessionId: VoiceModeSessionId.make("mode-controller"),
      interruptionPolicy: "reject",
    });
    await vi.waitFor(() => expect(controller.state?.snapshot.operation.kind).toBe("realtime"));

    expect(receipt.commandId).toBe("command-controller");
    expect(controller.state?.cursor.sequence).toBeGreaterThan(0);
    expect(states).toHaveBeenCalled();
    await controller.stop();
  });

  it("claims a presentation action only from the elected lease", async () => {
    const runtime = await configuredRuntime();
    const handled = vi.fn(async () => ({ outcome: "succeeded" as const }));
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-action"),
      onState: () => undefined,
      onPresentationAction: handled,
    });
    await controller.start("foreground-active");

    runtime.seedPresentationAction({
      actionId: VoiceClientActionId.make("action-controller"),
      action: "navigate-thread",
      projectId: ProjectId.make("project-controller"),
      threadId: ThreadId.make("thread-controller"),
      expiresAt: "2026-07-13T13:00:00.000Z",
    });

    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    await controller.stop();
  });

  it("renews an attached consumer lease before it silently expires", async () => {
    const runtime = await configuredRuntime();
    const renew = vi.spyOn(runtime, "updateAttachment");
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-renew"),
      onState: () => undefined,
      leaseRenewalMs: 5,
    });
    await controller.start("foreground-active");

    await vi.waitFor(() => expect(renew).toHaveBeenCalled());
    expect(controller.state?.lease.leaseGeneration).toBeGreaterThan(1);
    await controller.stop();
  });

  it("retries lease renewal after a transient adapter failure", async () => {
    const runtime = await configuredRuntime();
    const renew = vi
      .spyOn(runtime, "updateAttachment")
      .mockRejectedValueOnce(new Error("temporary renewal failure"));
    const errors = vi.fn();
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-renew-retry"),
      onState: () => undefined,
      onError: errors,
      leaseRenewalMs: 5,
    });
    await controller.start("foreground-active");

    await vi.waitFor(() => expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "temporary renewal failure" }),
    );
    expect(controller.state?.lease.leaseGeneration).toBeGreaterThan(1);
    await controller.stop();
  });

  it("replays an event when its consumer fails before acknowledgement", async () => {
    const runtime = await configuredRuntime();
    const errors = vi.fn();
    let realtimeAttempts = 0;
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-replay"),
      onState: () => undefined,
      onEvent: (event) => {
        if (event.kind !== "command-outcome" || event.receipt.commandId !== "command-replay")
          return;
        realtimeAttempts += 1;
        if (realtimeAttempts === 1) throw new Error("consumer failed");
      },
      onError: errors,
    });
    await controller.start("foreground-active");

    await controller.dispatch({
      kind: "start-realtime",
      modeSessionId: VoiceModeSessionId.make("mode-replay"),
      interruptionPolicy: "reject",
    });

    await vi.waitFor(() => expect(realtimeAttempts).toBe(2));
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "consumer failed" }));
    expect(controller.state?.snapshot.operation.kind).toBe("realtime");
    expect(controller.state?.cursor.sequence).toBe(controller.state?.snapshot.sequence);
    await controller.stop();
  });

  it("does not fail an in-flight dispatch when stop wins the lifecycle race", async () => {
    const runtime = await configuredRuntime();
    const originalDispatch = runtime.dispatch.bind(runtime);
    let releaseDispatch!: () => void;
    let dispatchEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      dispatchEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    vi.spyOn(runtime, "dispatch").mockImplementation(async (command) => {
      dispatchEntered();
      await released;
      return originalDispatch(command);
    });
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-stop-race"),
      onState: () => undefined,
    });
    await controller.start("foreground-active");

    const dispatch = controller.dispatch({
      kind: "start-realtime",
      modeSessionId: VoiceModeSessionId.make("mode-stop-race"),
      interruptionPolicy: "reject",
    });
    await entered;
    await controller.stop();
    releaseDispatch();

    await expect(dispatch).resolves.toMatchObject({ outcome: { type: "accepted" } });
    expect(controller.state).toBeNull();
  });

  it("keeps delivery alive when presentation state observers throw", async () => {
    const runtime = await configuredRuntime();
    const errors = vi.fn();
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-observer-error"),
      onState: () => {
        throw new Error("observer failed");
      },
      onError: errors,
    });

    await expect(controller.start("foreground-active")).resolves.toBeDefined();
    await expect(
      controller.dispatch({
        kind: "start-realtime",
        modeSessionId: VoiceModeSessionId.make("mode-observer-error"),
        interruptionPolicy: "reject",
      }),
    ).resolves.toMatchObject({ outcome: { type: "accepted" } });
    await vi.waitFor(() => expect(controller.state?.snapshot.operation.kind).toBe("realtime"));
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "observer failed" }));
    await controller.stop();
  });

  it("rolls back a partial attachment and permits a clean startup retry", async () => {
    const runtime = await configuredRuntime();
    const originalSubscribe = runtime.subscribe.bind(runtime);
    const subscribe = vi
      .spyOn(runtime, "subscribe")
      .mockImplementationOnce(() => {
        throw new Error("subscription failed");
      })
      .mockImplementation(originalSubscribe);
    const detach = vi.spyOn(runtime, "detach");
    const controller = new VoiceRuntimeController({
      runtime,
      createCommandId: () => VoiceRuntimeCommandId.make("command-start-retry"),
      onState: () => undefined,
    });

    await expect(controller.start("foreground-active")).rejects.toThrow("subscription failed");
    expect(controller.state).toBeNull();
    expect(detach).toHaveBeenCalledTimes(1);

    await expect(controller.start("foreground-active")).resolves.toBeDefined();
    expect(subscribe).toHaveBeenCalledTimes(2);
    await controller.stop();
  });
});

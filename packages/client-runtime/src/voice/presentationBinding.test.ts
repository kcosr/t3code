import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceClientActionId,
  VoiceConversationId,
  VoiceDraftArtifactId,
  VoiceModeSessionId,
  VoiceRuntimeCommandId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceTurnClientOperationId,
  type VoiceRuntimeAuthorityReservation,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { FakeVoiceRuntime } from "./fakeRuntime.ts";
import { VoiceRuntimePresentationBinding } from "./presentationBinding.ts";
import { computeVoiceRuntimeTargetDigest, type VoiceRuntime } from "./runtime.ts";

const now = Date.parse("2026-07-13T12:00:00.000Z");
const runtimeId = VoiceRuntimeId.make("presentation-runtime");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("presentation-runtime-instance");
const environmentId = EnvironmentId.make("presentation-environment");
const conversationId = VoiceConversationId.make("presentation-conversation");

async function realtimeAuthority(
  generation = 1,
  expectedCurrentGeneration = generation - 1,
): Promise<VoiceRuntimeAuthorityReservation> {
  const target = { mode: "realtime" as const, environmentId, conversationId };
  return {
    runtimeId,
    runtimeInstanceId,
    provisioningOperationId: VoiceRuntimeProvisioningOperationId.make(
      `presentation-provision-${generation}`,
    ),
    expectedCurrentGeneration,
    generation,
    targetDigest: await computeVoiceRuntimeTargetDigest(target),
    target,
    environmentOrigin: "https://termstation",
    operation: "realtime-start",
    readinessEnabled: true,
    environmentOrigin: "https://termstation",
    token: `presentation-token-${generation}`,
    issuedAt: "2026-07-13T12:00:00.000Z",
    expiresAt: "2026-07-13T13:00:00.000Z",
  };
}

async function configuredRuntime(): Promise<FakeVoiceRuntime> {
  const runtime = new FakeVoiceRuntime({ runtimeId, runtimeInstanceId, now: () => now });
  await runtime.configureAuthority(await realtimeAuthority());
  return runtime;
}

function binding(runtime: VoiceRuntime, onError = vi.fn()) {
  let command = 0;
  return new VoiceRuntimePresentationBinding({
    runtime,
    createCommandId: () => VoiceRuntimeCommandId.make(`presentation-command-${++command}`),
    onError,
    leaseRenewalMs: 60_000,
  });
}

describe("VoiceRuntimePresentationBinding", () => {
  it("coalesces a StrictMode-shaped release and reacquire into one attachment", async () => {
    const runtime = await configuredRuntime();
    const attach = vi.spyOn(runtime, "attach");
    const detach = vi.spyOn(runtime, "detach");
    const presentation = binding(runtime);

    const first = presentation.acquire("foreground-active");
    const released = first.release();
    const replacement = presentation.acquire("foreground-active");
    await Promise.all([first.ready, released, replacement.ready]);

    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
    expect(presentation.getSnapshot()).toMatchObject({
      phase: "attached",
      controller: { lease: { presentation: "foreground-active" } },
    });

    await replacement.release();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(presentation.getSnapshot().phase).toBe("detached");
  });

  it("updates one lease as application presentation changes", async () => {
    const runtime = await configuredRuntime();
    const update = vi.spyOn(runtime, "updateAttachment");
    const presentation = binding(runtime);
    const handle = presentation.acquire("background");
    await handle.ready;

    await handle.updatePresentation("visible-inactive");
    await handle.updatePresentation("foreground-active");

    expect(update).toHaveBeenCalledTimes(2);
    expect(presentation.getSnapshot().controller?.lease.presentation).toBe("foreground-active");
    await handle.release();
  });

  it("subscribes before taking the authoritative follow-up snapshot", async () => {
    const runtime = await configuredRuntime();
    const getSnapshot = vi.spyOn(runtime, "getSnapshot");
    const subscribe = vi.spyOn(runtime, "subscribe");
    const presentation = binding(runtime);
    const handle = presentation.acquire("foreground-active");

    await handle.ready;

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      getSnapshot.mock.invocationCallOrder[1]!,
    );
    await handle.release();
  });

  it("exposes descriptor, snapshot, and fenced dispatch without owning the operation", async () => {
    const runtime = await configuredRuntime();
    const presentation = binding(runtime);
    const handle = presentation.acquire("foreground-active");
    await handle.ready;

    const receipt = await presentation.dispatch({
      kind: "start-realtime",
      modeSessionId: VoiceModeSessionId.make("presentation-mode"),
      interruptionPolicy: "reject",
    });
    await vi.waitFor(() =>
      expect(presentation.getSnapshot().snapshot?.operation.kind).toBe("realtime"),
    );

    expect(receipt.outcome.type).toBe("accepted");
    expect(presentation.getSnapshot().descriptor?.executionModel).toBe("autonomous");
    await handle.release();
    expect((await runtime.getSnapshot()).operation.kind).toBe("realtime");
  });

  it("lets the runtime elect across overlapping React presentation bindings", async () => {
    const runtime = await configuredRuntime();
    const first = binding(runtime);
    const second = binding(runtime);
    const firstHandle = first.acquire("foreground-active");
    await firstHandle.ready;
    const secondHandle = second.acquire("foreground-active");
    await secondHandle.ready;

    await vi.waitFor(() => expect(first.getSnapshot().controller?.lease.election).toBe("standby"));
    expect(second.getSnapshot().controller?.lease.election).toBe("elected");

    await secondHandle.release();
    await vi.waitFor(() => expect(first.getSnapshot().controller?.lease.election).toBe("elected"));
    await firstHandle.release();
  });

  it("surfaces and completes presentation actions through binding state", async () => {
    const runtime = await configuredRuntime();
    const presentation = binding(runtime);
    const handle = presentation.acquire("foreground-active");
    await handle.ready;
    const actionId = VoiceClientActionId.make("presentation-action");

    runtime.seedPresentationAction({
      actionId,
      action: "navigate-thread",
      projectId: ProjectId.make("presentation-project"),
      threadId: ThreadId.make("presentation-thread"),
      expiresAt: "2026-07-13T13:00:00.000Z",
    });
    await vi.waitFor(() =>
      expect(presentation.getSnapshot().presentationAction?.actionId).toBe(actionId),
    );

    expect(presentation.completePresentationAction(actionId, { outcome: "succeeded" })).toBe(true);
    await vi.waitFor(() => expect(presentation.getSnapshot().presentationAction).toBeNull());
    await handle.release();
  });

  it("surfaces draft artifacts and discards an unresolved draft on detach", async () => {
    const runtime = await configuredRuntime();
    const presentation = binding(runtime);
    const handle = presentation.acquire("foreground-active");
    await handle.ready;
    const artifactId = VoiceDraftArtifactId.make("presentation-draft");
    const artifact = {
      artifactId,
      runtimeId,
      runtimeInstanceId,
      runtimeGeneration: 1,
      modeSessionId: VoiceModeSessionId.make("presentation-draft-mode"),
      turnClientOperationId: VoiceTurnClientOperationId.make("presentation-draft-turn"),
      target: {
        environmentId,
        projectId: ProjectId.make("presentation-draft-project"),
        threadId: ThreadId.make("presentation-draft-thread"),
      },
      composerRevision: "presentation-revision",
      expiresAt: "2026-07-13T13:00:00.000Z",
    };
    runtime.seedDraftArtifact(artifact, "draft transcript");
    runtime.seedPresentationAction({
      actionId: VoiceClientActionId.make("presentation-review-action"),
      action: "review-draft",
      artifact,
      expiresAt: "2026-07-13T13:00:00.000Z",
    });
    await vi.waitFor(() =>
      expect(presentation.getSnapshot().draftArtifact?.handle.artifactId).toBe(artifactId),
    );

    await handle.release();
    expect(presentation.getSnapshot()).toMatchObject({
      phase: "detached",
      draftArtifact: null,
    });
  });

  it("does not attach when an async factory resolves after its presentation released", async () => {
    const runtime = await configuredRuntime();
    const attach = vi.spyOn(runtime, "attach");
    let resolveRuntime!: (runtime: VoiceRuntime) => void;
    const runtimePromise = new Promise<VoiceRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const presentation = new VoiceRuntimePresentationBinding({
      runtime: { create: () => runtimePromise },
      createCommandId: () => VoiceRuntimeCommandId.make("presentation-async-command"),
    });
    const handle = presentation.acquire("foreground-active");
    await Promise.resolve();
    const release = handle.release();
    resolveRuntime(runtime);

    await Promise.all([handle.ready, release]);
    expect(attach).not.toHaveBeenCalled();
    expect(presentation.getSnapshot().phase).toBe("detached");
  });

  it("retries creation after a transient factory failure", async () => {
    const runtime = await configuredRuntime();
    const create = vi
      .fn<() => Promise<VoiceRuntime>>()
      .mockRejectedValueOnce(new Error("factory unavailable"))
      .mockResolvedValue(runtime);
    const errors = vi.fn();
    const presentation = new VoiceRuntimePresentationBinding({
      runtime: { create },
      createCommandId: () => VoiceRuntimeCommandId.make("presentation-retry-command"),
      onError: errors,
    });
    const handle = presentation.acquire("foreground-active");

    await expect(handle.ready).rejects.toThrow("factory unavailable");
    await expect(presentation.retry()).resolves.toBeUndefined();
    expect(presentation.getSnapshot().phase).toBe("attached");
    expect(create).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalled();
    await handle.release();
  });

  it("configures and clears authority while retaining the presentation attachment", async () => {
    const runtime = new FakeVoiceRuntime({ runtimeId, runtimeInstanceId, now: () => now });
    const presentation = binding(runtime);
    const handle = presentation.acquire("foreground-active");
    await handle.ready;

    const configured = await presentation.configureAuthority(await realtimeAuthority());
    expect(configured.availability).toBe("ready");
    expect(presentation.getSnapshot()).toMatchObject({
      phase: "attached",
      snapshot: { generation: 1, availability: "ready" },
      controller: { snapshot: { generation: 1 } },
    });

    const cleared = await presentation.clearAuthority({
      commandId: VoiceRuntimeCommandId.make("presentation-clear"),
      runtimeId,
      runtimeInstanceId,
      authorityGeneration: 1,
    });
    expect(cleared.availability).toBe("locked");
    await vi.waitFor(() =>
      expect(presentation.getSnapshot().snapshot?.availability).toBe("locked"),
    );
    await handle.release();
  });

  it("reattaches on a rebase-required command receipt", async () => {
    const runtime = await configuredRuntime();
    const presentation = binding(runtime);
    const handle = presentation.acquire("foreground-active");
    await handle.ready;
    await runtime.configureAuthority(await realtimeAuthority(2, 1));

    const receipt = await presentation.dispatch({
      kind: "start-realtime",
      modeSessionId: VoiceModeSessionId.make("presentation-rebased-mode"),
      interruptionPolicy: "reject",
    });

    expect(receipt.outcome.type).toBe("rebase-required");
    expect(presentation.getSnapshot().controller?.snapshot.generation).toBe(2);
    await handle.release();
  });
});

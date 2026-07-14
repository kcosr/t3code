import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  VoiceClientActionId,
  VoiceConfirmationId,
  ProjectId,
  ThreadId,
  VoiceDraftArtifactId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceRuntimeCommandId,
  VoiceRuntimeConsumerLeaseId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeProvisioningOperationId,
  VoiceToolCallId,
  VoiceTurnClientOperationId,
} from "@t3tools/contracts";

import {
  FakeVoiceRuntime,
  FakeVoiceRuntimeDraftArtifactError,
  FakeVoiceRuntimeAuthorityError,
  FakeVoiceRuntimeLeaseError,
  FakeVoiceRuntimePresentationActionError,
} from "./fakeRuntime.ts";
import {
  makeFakeVoiceRuntimeConformanceFixture,
  verifyVoiceRuntimeConformance,
} from "./runtimeConformance.ts";
import { computeVoiceRuntimeTargetDigest } from "./runtime.ts";

async function configureThreadRuntime(runtime: FakeVoiceRuntime) {
  const initial = await runtime.getSnapshot();
  const target = {
    mode: "thread" as const,
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    speechPreset: "default" as const,
    autoRearm: true,
    endpointPolicy: {
      endSilenceMs: 2_200,
      noSpeechTimeoutMs: null,
      maximumUtteranceMs: 600_000,
    },
    speechEnabled: true,
    rearmGuardMs: 500,
  };
  return runtime.configureAuthority({
    runtimeId: initial.runtimeId,
    runtimeInstanceId: initial.runtimeInstanceId,
    provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("thread-provision"),
    expectedCurrentGeneration: initial.generation,
    generation: initial.generation + 1,
    targetDigest: await computeVoiceRuntimeTargetDigest(target),
    target,
    environmentOrigin: "https://termstation",
    operation: "thread-turn-start",
    readinessEnabled: true,
    environmentOrigin: "https://termstation",
    token: "thread-token",
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

describe("VoiceRuntime foundation", () => {
  it("computes a deterministic SHA-256 target digest without WebCrypto", async () => {
    await expect(
      computeVoiceRuntimeTargetDigest({
        mode: "realtime",
        environmentId: EnvironmentId.make("environment-1"),
        conversationId: VoiceConversationId.make("conversation-1"),
      }),
    ).resolves.toBe("ed90e56c178637e806ddcbebd79d1a38c43316669e098549cc5b2afbcb1e80ac");

    const left = await computeVoiceRuntimeTargetDigest({
      mode: "realtime",
      environmentId: EnvironmentId.make("environment-1"),
      conversationId: VoiceConversationId.make("conversation-1"),
    });
    const right = await computeVoiceRuntimeTargetDigest({
      conversationId: VoiceConversationId.make("conversation-1"),
      environmentId: EnvironmentId.make("environment-1"),
      mode: "realtime",
    });
    expect(right).toBe(left);
  });

  it("passes the shared fake-runtime conformance scenario", async () => {
    const report = await verifyVoiceRuntimeConformance(makeFakeVoiceRuntimeConformanceFixture());

    expect(report.executionModel).toBe("autonomous");
    expect(report.replayedDeliveryCount).toBeGreaterThan(0);
    expect(report.finalSequence).toBeGreaterThan(0);
  });

  it("rebases a consumer whose cursor fell behind the bounded journal", async () => {
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const runtime = await fixture.factory.create();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    if (prepared.start.kind !== "start-realtime") throw new Error("Expected Realtime fixture");
    const configured = await runtime.configureAuthority(prepared.authority);
    const lease = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    const before = await runtime.getSnapshot();

    await runtime.dispatch(prepared.start);
    await runtime.dispatch({
      kind: "set-realtime-muted",
      commandId: VoiceRuntimeCommandId.make("mute-1"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      muted: true,
    });
    await runtime.dispatch({
      kind: "set-realtime-muted",
      commandId: VoiceRuntimeCommandId.make("mute-2"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      muted: false,
    });

    const deliveries: Array<{ readonly type: string; readonly reason: string }> = [];
    const smallJournalRuntime = runtime as FakeVoiceRuntime;
    // The fake's normal journal is deliberately bounded; an old-instance cursor always forces
    // the same atomic rebase path without relying on journal implementation details.
    const unsubscribe = smallJournalRuntime.subscribe(
      {
        lease,
        after: {
          runtimeId: before.runtimeId,
          runtimeInstanceId: VoiceRuntimeInstanceId.make("replaced-instance"),
          generation: before.generation,
          sequence: before.sequence,
        },
      },
      (delivery) => {
        if ("type" in delivery) deliveries.push(delivery);
      },
    );
    unsubscribe();

    expect(deliveries[0]).toMatchObject({ type: "rebase", reason: "runtime-replaced" });
  });

  it("allows only the elected foreground lease to consume a draft artifact", async () => {
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const runtime = new FakeVoiceRuntime();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority(prepared.authority);
    const first = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    const second = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    const artifactId = VoiceDraftArtifactId.make("draft-1");
    runtime.seedDraftArtifact(
      {
        artifactId,
        runtimeId: configured.runtimeId,
        runtimeInstanceId: configured.runtimeInstanceId,
        runtimeGeneration: configured.generation,
        modeSessionId: VoiceModeSessionId.make("mode-session-1"),
        turnClientOperationId: VoiceTurnClientOperationId.make("turn-client-1"),
        target: {
          environmentId: EnvironmentId.make("environment-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        },
        composerRevision: "revision-1",
        expiresAt: "2026-07-15T00:00:00.000Z",
      },
      "draft transcript",
    );

    await expect(runtime.readDraftArtifact({ lease: first, artifactId })).rejects.toBeInstanceOf(
      FakeVoiceRuntimeLeaseError,
    );
    await expect(runtime.readDraftArtifact({ lease: second, artifactId })).resolves.toMatchObject({
      transcript: "draft transcript",
    });
    await runtime.acknowledgeDraftArtifact({ lease: second, artifactId, outcome: "appended" });
    await expect(runtime.readDraftArtifact({ lease: second, artifactId })).rejects.toBeInstanceOf(
      FakeVoiceRuntimeDraftArtifactError,
    );
  });

  it("brands consumer lease IDs independently from operation IDs", () => {
    expect(VoiceRuntimeConsumerLeaseId.make("consumer-1")).toBe("consumer-1");
  });

  it("validates and idempotently replays authority provisioning", async () => {
    const runtime = new FakeVoiceRuntime();
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority(prepared.authority);

    await expect(runtime.configureAuthority(prepared.authority)).resolves.toEqual(configured);
    await expect(
      runtime.configureAuthority({ ...prepared.authority, token: "changed-token" }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeAuthorityError);

    const invalidDigestRuntime = new FakeVoiceRuntime();
    const invalidInitial = await invalidDigestRuntime.getSnapshot();
    const invalidPrepared = await fixture.prepare(invalidDigestRuntime, invalidInitial);
    await expect(
      invalidDigestRuntime.configureAuthority({
        ...invalidPrepared.authority,
        targetDigest: "wrong-digest",
      }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeAuthorityError);

    const expiredRuntime = new FakeVoiceRuntime({ now: () => Date.parse("2026-01-02T00:00:00Z") });
    const expiredInitial = await expiredRuntime.getSnapshot();
    const expiredPrepared = await fixture.prepare(expiredRuntime, expiredInitial);
    await expect(
      expiredRuntime.configureAuthority({
        ...expiredPrepared.authority,
        issuedAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeAuthorityError);

    const futureRuntime = new FakeVoiceRuntime({ now: () => Date.parse("2026-01-02T00:00:00Z") });
    const futureInitial = await futureRuntime.getSnapshot();
    const futurePrepared = await fixture.prepare(futureRuntime, futureInitial);
    await expect(
      futureRuntime.configureAuthority({
        ...futurePrepared.authority,
        issuedAt: "2026-01-03T00:00:00.000Z",
        expiresAt: "2026-01-04T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeAuthorityError);
  });

  it("preserves generation monotonicity across clear and rejects reuse and jumps", async () => {
    const runtime = new FakeVoiceRuntime();
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority(prepared.authority);
    await runtime.clearAuthority({
      commandId: VoiceRuntimeCommandId.make("clear-generation-one"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
    });

    await expect(
      runtime.configureAuthority({
        ...prepared.authority,
        provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("reuse-generation-one"),
      }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeAuthorityError);
    await expect(
      runtime.configureAuthority({
        ...prepared.authority,
        provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("jump-generation-three"),
        expectedCurrentGeneration: configured.generation,
        generation: configured.generation + 2,
      }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeAuthorityError);

    const next = await runtime.configureAuthority({
      ...prepared.authority,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-generation-two"),
      expectedCurrentGeneration: configured.generation,
      generation: configured.generation + 1,
    });
    expect(next.generation).toBe(configured.generation + 1);
  });

  it("requires an active operation to stop before authority replacement", async () => {
    const runtime = new FakeVoiceRuntime();
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority(prepared.authority);
    await runtime.dispatch(prepared.start);
    const replacement = {
      ...prepared.authority,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("active-replacement"),
      expectedCurrentGeneration: configured.generation,
      generation: configured.generation + 1,
    };

    await expect(runtime.configureAuthority(replacement)).rejects.toBeInstanceOf(
      FakeVoiceRuntimeAuthorityError,
    );
    expect((await runtime.getSnapshot()).generation).toBe(configured.generation);

    await runtime.dispatch({
      kind: "stop-mode",
      commandId: VoiceRuntimeCommandId.make("stop-before-authority-replacement"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: prepared.start.modeSessionId,
      policy: "drain",
    });
    await expect(runtime.configureAuthority(replacement)).resolves.toMatchObject({
      generation: configured.generation + 1,
    });
  });

  it("invalidates old-generation leases while retaining command idempotency", async () => {
    const runtime = new FakeVoiceRuntime();
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const firstGeneration = await runtime.configureAuthority(prepared.authority);
    const lease = await runtime.attach({
      runtimeId: firstGeneration.runtimeId,
      runtimeInstanceId: firstGeneration.runtimeInstanceId,
      generation: firstGeneration.generation,
      presentation: "foreground-active",
    });
    let deliveryCount = 0;
    runtime.subscribe({ lease, after: null }, () => {
      deliveryCount += 1;
    });
    await runtime.dispatch(prepared.start);
    await runtime.dispatch({
      kind: "stop-mode",
      commandId: VoiceRuntimeCommandId.make("stop-before-rotation"),
      runtimeId: firstGeneration.runtimeId,
      runtimeInstanceId: firstGeneration.runtimeInstanceId,
      authorityGeneration: firstGeneration.generation,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      policy: "immediate",
    });

    const deliveriesBeforeRotation = deliveryCount;
    const secondAuthority = {
      ...prepared.authority,
      provisioningOperationId: VoiceRuntimeProvisioningOperationId.make("provision-runtime-2"),
      expectedCurrentGeneration: firstGeneration.generation,
      generation: firstGeneration.generation + 1,
    };
    const secondGeneration = await runtime.configureAuthority(secondAuthority);
    expect(deliveryCount).toBe(deliveriesBeforeRotation);
    await expect(runtime.detach(lease)).rejects.toBeInstanceOf(FakeVoiceRuntimeLeaseError);

    const reusedCommand = await runtime.dispatch({
      ...prepared.start,
      authorityGeneration: secondGeneration.generation,
    });
    expect(reusedCommand.outcome).toEqual({
      type: "rejected",
      reason: "idempotency-conflict",
    });
  });

  it("rejects starts after authority is cleared or expires", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const runtime = new FakeVoiceRuntime({ now: () => now });
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const targetDigest = await computeVoiceRuntimeTargetDigest(prepared.authority.target);
    await runtime.configureAuthority({
      ...prepared.authority,
      targetDigest,
      issuedAt: "2025-12-31T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:01.000Z",
    });
    now += 2_000;
    const expired = await runtime.dispatch(prepared.start);
    expect(expired.outcome).toEqual({ type: "rejected", reason: "authority-unavailable" });
    expect((await runtime.getSnapshot()).availability).toBe("locked");

    const clearedRuntime = new FakeVoiceRuntime();
    const clearedInitial = await clearedRuntime.getSnapshot();
    const clearedPrepared = await fixture.prepare(clearedRuntime, clearedInitial);
    const clearedConfigured = await clearedRuntime.configureAuthority(clearedPrepared.authority);
    const clear = {
      commandId: VoiceRuntimeCommandId.make("clear-authority"),
      runtimeId: clearedConfigured.runtimeId,
      runtimeInstanceId: clearedConfigured.runtimeInstanceId,
      authorityGeneration: clearedConfigured.generation,
    };
    const cleared = await clearedRuntime.clearAuthority(clear);
    await expect(clearedRuntime.clearAuthority(clear)).resolves.toEqual(cleared);
    const rejected = await clearedRuntime.dispatch(clearedPrepared.start);
    expect(rejected.outcome).toEqual({ type: "rejected", reason: "authority-unavailable" });
  });

  it("orders replacement through draining and a terminal event without overlapping owners", async () => {
    const runtime = new FakeVoiceRuntime();
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority(prepared.authority);
    const lease = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    const deliveries: Array<unknown> = [];
    runtime.subscribe({ lease, after: null }, (delivery) => deliveries.push(delivery));
    if (prepared.start.kind !== "start-realtime") throw new Error("Expected Realtime fixture");
    await runtime.dispatch(prepared.start);
    const replacementCommandId = VoiceRuntimeCommandId.make("replacement-start");
    await runtime.dispatch({
      ...prepared.start,
      commandId: replacementCommandId,
      modeSessionId: VoiceModeSessionId.make("mode-session-2"),
      interruptionPolicy: "drain-conflicting",
    });

    expect(deliveries).toContainEqual(
      expect.objectContaining({
        kind: "state-changed",
        causedByCommandId: replacementCommandId,
        snapshot: expect.objectContaining({
          operation: expect.objectContaining({ phase: "draining" }),
        }),
      }),
    );
    expect(deliveries).toContainEqual(
      expect.objectContaining({
        kind: "operation-terminal",
        causedByCommandId: replacementCommandId,
        outcome: "interrupted",
      }),
    );
    expect(await runtime.getSnapshot()).toMatchObject({
      operation: { kind: "realtime", modeSessionId: "mode-session-2" },
      mediaOwner: { kind: "realtime-peer", modeSessionId: "mode-session-2" },
    });
  });

  it("models thread finish, cancellation, and pause-after-turn transitions", async () => {
    const runtime = new FakeVoiceRuntime();
    const configured = await configureThreadRuntime(runtime);
    const start = {
      kind: "start-thread-mode" as const,
      commandId: VoiceRuntimeCommandId.make("start-thread"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: VoiceModeSessionId.make("thread-mode"),
      turnClientOperationId: VoiceTurnClientOperationId.make("turn-client-1"),
      submissionPolicy: "auto-submit" as const,
      draftContext: null,
      interruptionPolicy: "reject" as const,
    };
    await runtime.dispatch(start);
    await runtime.dispatch({
      kind: "finish-thread-turn",
      commandId: VoiceRuntimeCommandId.make("finish-thread"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: start.modeSessionId,
      turnClientOperationId: start.turnClientOperationId,
      outcome: "finish-to-draft",
      draftContext: {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        composerRevision: "revision-1",
      },
    });
    expect(await runtime.getSnapshot()).toMatchObject({
      operation: { kind: "thread-turn", phase: { phase: "draft-ready" } },
      mediaOwner: { kind: "none" },
    });
    await runtime.dispatch({
      kind: "stop-mode",
      commandId: VoiceRuntimeCommandId.make("pause-thread"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: start.modeSessionId,
      policy: "pause-after-turn",
    });
    expect(await runtime.getSnapshot()).toMatchObject({
      operation: { kind: "thread-turn", phase: { phase: "paused", reason: "user" } },
      readiness: { state: "ready", mode: "thread" },
    });
    await runtime.dispatch({
      kind: "cancel-thread-turn",
      commandId: VoiceRuntimeCommandId.make("cancel-thread"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: start.modeSessionId,
      turnClientOperationId: start.turnClientOperationId,
    });
    expect(await runtime.getSnapshot()).toMatchObject({
      operation: { kind: "none" },
      mediaOwner: { kind: "none" },
    });
  });

  it("expires leases before delivery and validates route commands against the active mode", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const runtime = new FakeVoiceRuntime({ now: () => now, leaseDurationMs: 100 });
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority({
      ...prepared.authority,
      issuedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const beforeStartRoute = await runtime.dispatch({
      kind: "set-audio-route",
      commandId: VoiceRuntimeCommandId.make("route-before-start"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      inputRouteId: null,
      outputRouteId: "speaker",
    });
    expect(beforeStartRoute.outcome).toEqual({ type: "rejected", reason: "invalid-phase" });

    const lease = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    let deliveries = 0;
    runtime.subscribe({ lease, after: null }, () => {
      deliveries += 1;
    });
    const beforeExpiry = deliveries;
    now += 101;
    await runtime.dispatch(prepared.start);
    expect(deliveries).toBe(beforeExpiry);

    const wrongModeRoute = await runtime.dispatch({
      kind: "set-audio-route",
      commandId: VoiceRuntimeCommandId.make("route-wrong-mode"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: VoiceModeSessionId.make("other-mode"),
      inputRouteId: null,
      outputRouteId: "speaker",
    });
    expect(wrongModeRoute.outcome).toEqual({ type: "rejected", reason: "invalid-phase" });
  });

  it("enforces draft expiry and runtime generation on read and acknowledgement", async () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    const runtime = new FakeVoiceRuntime({ now: () => now });
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority(prepared.authority);
    const lease = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    const expiredId = VoiceDraftArtifactId.make("expired-draft");
    runtime.seedDraftArtifact(
      {
        artifactId: expiredId,
        runtimeId: configured.runtimeId,
        runtimeInstanceId: configured.runtimeInstanceId,
        runtimeGeneration: configured.generation,
        modeSessionId: VoiceModeSessionId.make("mode-session-1"),
        turnClientOperationId: VoiceTurnClientOperationId.make("turn-client-1"),
        target: {
          environmentId: EnvironmentId.make("environment-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        },
        composerRevision: "revision-1",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
      "expired",
    );
    await expect(
      runtime.readDraftArtifact({ lease, artifactId: expiredId }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeDraftArtifactError);
    await expect(
      runtime.acknowledgeDraftArtifact({ lease, artifactId: expiredId, outcome: "discarded" }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeDraftArtifactError);

    const deliveries: Array<unknown> = [];
    const unsubscribe = runtime.subscribe({ lease, after: null }, (delivery) =>
      deliveries.push(delivery),
    );
    unsubscribe();
    expect(deliveries[0]).toMatchObject({ type: "rebase", draftArtifacts: [] });
  });

  it("fences presentation claims and requires a strict Realtime confirmation decision", async () => {
    const runtime = new FakeVoiceRuntime();
    const fixture = makeFakeVoiceRuntimeConformanceFixture();
    const initial = await runtime.getSnapshot();
    const prepared = await fixture.prepare(runtime, initial);
    const configured = await runtime.configureAuthority(prepared.authority);
    const standby = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    const elected = await runtime.attach({
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      generation: configured.generation,
      presentation: "foreground-active",
    });
    await runtime.dispatch(prepared.start);
    const actionId = VoiceClientActionId.make("confirmation-action");
    const confirmationId = VoiceConfirmationId.make("confirmation-1");
    runtime.seedPresentationAction({
      actionId,
      action: "realtime-confirmation-required",
      confirmationId,
      toolCallId: VoiceToolCallId.make("tool-call-1"),
      tool: "send_thread_message",
      summary: "Send the prepared message",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(
      runtime.claimPresentationAction({ lease: standby, actionId }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimeLeaseError);
    await expect(
      runtime.claimPresentationAction({ lease: elected, actionId }),
    ).resolves.toMatchObject({
      confirmationId,
    });
    await expect(
      runtime.acknowledgePresentationAction({ lease: elected, actionId, outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimePresentationActionError);

    const denied = await runtime.dispatch({
      kind: "decide-realtime-confirmation",
      commandId: VoiceRuntimeCommandId.make("standby-decision"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      lease: standby,
      actionId,
      confirmationId,
      decision: "approve",
    });
    expect(denied.outcome).toEqual({ type: "rejected", reason: "permission-denied" });
    const accepted = await runtime.dispatch({
      kind: "decide-realtime-confirmation",
      commandId: VoiceRuntimeCommandId.make("elected-decision"),
      runtimeId: configured.runtimeId,
      runtimeInstanceId: configured.runtimeInstanceId,
      authorityGeneration: configured.generation,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      lease: elected,
      actionId,
      confirmationId,
      decision: "approve",
    });
    expect(accepted.outcome).toEqual({ type: "accepted" });
    await expect(
      runtime.claimPresentationAction({ lease: elected, actionId }),
    ).rejects.toBeInstanceOf(FakeVoiceRuntimePresentationActionError);
  });
});

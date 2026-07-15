import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceRuntimeCommandId,
  VoiceRuntimeInstanceId,
  VoiceClientActionId,
  type VoiceRuntimeAuthorityReservation,
  type VoiceRuntimeCommand,
  type VoiceRuntimeRebase,
  type VoiceRuntimePresentationAction,
  type VoiceRuntimeSnapshot,
} from "@t3tools/contracts";

import { FakeVoiceRuntime } from "./fakeRuntime.ts";
import type { VoiceRuntime, VoiceRuntimeFactory } from "./runtime.ts";

export class VoiceRuntimeConformanceError extends Error {}

export interface VoiceRuntimeConformanceFixture {
  readonly factory: VoiceRuntimeFactory;
  readonly prepare: (
    runtime: VoiceRuntime,
    initial: VoiceRuntimeSnapshot,
  ) => Promise<{
    readonly authority: VoiceRuntimeAuthorityReservation;
    readonly start: VoiceRuntimeCommand;
    readonly commandIdConflict: VoiceRuntimeCommand;
    readonly staleInstance: VoiceRuntimeCommand;
    readonly presentationAction: VoiceRuntimePresentationAction;
  }>;
  readonly publishPresentationAction: (
    runtime: VoiceRuntime,
    action: VoiceRuntimePresentationAction,
  ) => Promise<void> | void;
}

export interface VoiceRuntimeConformanceReport {
  readonly executionModel: "autonomous" | "ui-attached";
  readonly replayedDeliveryCount: number;
  readonly finalSequence: number;
}

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new VoiceRuntimeConformanceError(message);
}

async function ensureRejected(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new VoiceRuntimeConformanceError(message);
}

const isRebase = (
  delivery: Parameters<Parameters<VoiceRuntime["subscribe"]>[1]>[0],
): delivery is VoiceRuntimeRebase => "type" in delivery && delivery.type === "rebase";

export async function verifyVoiceRuntimeConformance(
  fixture: VoiceRuntimeConformanceFixture,
): Promise<VoiceRuntimeConformanceReport> {
  const runtime = await fixture.factory.create();
  const descriptor = await runtime.describe();
  const initial = await runtime.getSnapshot();
  const prepared = await fixture.prepare(runtime, initial);
  const configured = await runtime.configureAuthority(prepared.authority);
  ensure(configured.generation === prepared.authority.generation, "authority CAS was not applied");

  const background = await runtime.attach({
    runtimeId: configured.runtimeId,
    runtimeInstanceId: configured.runtimeInstanceId,
    generation: configured.generation,
    presentation: "background",
  });
  ensure(background.election === "standby", "background consumer was incorrectly elected");

  let foreground = await runtime.attach({
    runtimeId: configured.runtimeId,
    runtimeInstanceId: configured.runtimeInstanceId,
    generation: configured.generation,
    presentation: "foreground-active",
  });
  ensure(foreground.election === "elected", "foreground consumer was not elected");

  const initialDeliveries: Array<Parameters<Parameters<VoiceRuntime["subscribe"]>[1]>[0]> = [];
  const unsubscribe = runtime.subscribe({ lease: foreground, after: null }, (delivery) => {
    initialDeliveries.push(delivery);
  });
  const initialRebase = initialDeliveries[0];
  ensure(
    initialRebase !== undefined && isRebase(initialRebase),
    "cursorless subscription did not produce a rebase",
  );

  const accepted = await runtime.dispatch(prepared.start);
  ensure(accepted.outcome.type === "accepted", "valid start command was not accepted");
  const replayed = await runtime.dispatch(prepared.start);
  ensure(
    replayed.outcome.type === "accepted" && replayed.replayed,
    "identical command retry did not replay its outcome",
  );
  const conflict = await runtime.dispatch(prepared.commandIdConflict);
  ensure(
    conflict.outcome.type === "rejected" && conflict.outcome.reason === "idempotency-conflict",
    "command ID payload conflict was not rejected",
  );
  const stale = await runtime.dispatch(prepared.staleInstance);
  ensure(
    stale.outcome.type === "rebase-required" && stale.outcome.rebase.reason === "runtime-replaced",
    "stale runtime instance did not require rebase",
  );

  await fixture.publishPresentationAction(runtime, prepared.presentationAction);
  const claimedAction = await runtime.claimPresentationAction({
    lease: foreground,
    actionId: prepared.presentationAction.actionId,
  });
  ensure(
    claimedAction.actionId === prepared.presentationAction.actionId,
    "elected presenter could not claim its action",
  );
  await runtime.acknowledgePresentationAction({
    lease: foreground,
    actionId: prepared.presentationAction.actionId,
    outcome: "succeeded",
  });

  await runtime.acknowledge({ lease: foreground, through: accepted.cursor });
  unsubscribe();

  const replayedDeliveries: Array<Parameters<Parameters<VoiceRuntime["subscribe"]>[1]>[0]> = [];
  const unsubscribeReplay = runtime.subscribe(
    { lease: foreground, after: initialRebase.cursor },
    (delivery) => replayedDeliveries.push(delivery),
  );
  ensure(
    replayedDeliveries.some(
      (delivery) => !isRebase(delivery) && delivery.kind === "command-outcome",
    ),
    "journal did not replay the accepted command outcome",
  );
  unsubscribeReplay();

  foreground = await runtime.updateAttachment({ lease: foreground, presentation: "background" });
  ensure(foreground.election === "standby", "backgrounded consumer retained presentation election");
  await runtime.detach(foreground);
  await runtime.detach(background);

  const nextAuthority = {
    ...prepared.authority,
    expectedCurrentGeneration: configured.generation,
    generation: configured.generation + 1,
  };
  await ensureRejected(
    () => runtime.configureAuthority(nextAuthority),
    "authority replacement was allowed while an operation was active",
  );
  const unchanged = await runtime.getSnapshot();
  ensure(
    unchanged.generation === configured.generation && unchanged.operation.kind !== "none",
    "rejected authority replacement mutated the active runtime",
  );

  const stopped = await runtime.dispatch({
    kind: "stop-mode",
    commandId: VoiceRuntimeCommandId.make("stop-before-authority-rotation"),
    runtimeId: configured.runtimeId,
    runtimeInstanceId: configured.runtimeInstanceId,
    authorityGeneration: configured.generation,
    modeSessionId: prepared.start.modeSessionId,
    policy: "drain",
  });
  ensure(stopped.outcome.type === "accepted", "explicit drain before authority rotation failed");
  const cleared = await runtime.clearAuthority({
    commandId: VoiceRuntimeCommandId.make("clear-before-authority-rotation"),
    runtimeId: configured.runtimeId,
    runtimeInstanceId: configured.runtimeInstanceId,
    authorityGeneration: configured.generation,
  });
  ensure(
    cleared.generation === configured.generation,
    "authority clear reset its generation fence",
  );

  await ensureRejected(
    () =>
      runtime.configureAuthority({
        ...nextAuthority,
        generation: configured.generation,
      }),
    "authority generation reuse was accepted after clear",
  );
  await ensureRejected(
    () =>
      runtime.configureAuthority({
        ...nextAuthority,
        generation: configured.generation + 2,
      }),
    "authority generation jump was accepted after clear",
  );
  const rotated = await runtime.configureAuthority(nextAuthority);
  ensure(
    rotated.generation === configured.generation + 1,
    "authority did not rotate exactly once after explicit stop",
  );

  const finalSnapshot = await runtime.getSnapshot();
  return {
    executionModel: descriptor.executionModel,
    replayedDeliveryCount: replayedDeliveries.length,
    finalSequence: finalSnapshot.sequence,
  };
}

export function makeFakeVoiceRuntimeConformanceFixture(): VoiceRuntimeConformanceFixture {
  return {
    factory: { create: () => new FakeVoiceRuntime() },
    publishPresentationAction: (runtime, action) => {
      (runtime as FakeVoiceRuntime).seedPresentationAction(action);
    },
    prepare: async (_runtime, initial) => {
      const target = {
        mode: "realtime" as const,
        environmentId: EnvironmentId.make("environment-1"),
        conversationId: VoiceConversationId.make("conversation-1"),
      };
      const authority: VoiceRuntimeAuthorityReservation = {
        runtimeId: initial.runtimeId,
        runtimeInstanceId: initial.runtimeInstanceId,
        expectedCurrentGeneration: initial.generation,
        generation: initial.generation + 1,
        target,
        environmentOrigin: "https://termstation",
        readinessEnabled: true,
      };
      const start: VoiceRuntimeCommand = {
        kind: "start-realtime",
        commandId: VoiceRuntimeCommandId.make("start-realtime"),
        runtimeId: initial.runtimeId,
        runtimeInstanceId: initial.runtimeInstanceId,
        authorityGeneration: authority.generation,
        modeSessionId: VoiceModeSessionId.make("mode-session-1"),
        interruptionPolicy: "stop-conflicting",
      };
      return {
        authority,
        start,
        commandIdConflict: { ...start, interruptionPolicy: "reject" },
        staleInstance: {
          ...start,
          commandId: VoiceRuntimeCommandId.make("stale-start"),
          runtimeInstanceId: VoiceRuntimeInstanceId.make("stale-runtime-instance"),
        },
        presentationAction: {
          actionId: VoiceClientActionId.make("navigate-thread"),
          action: "navigate-thread",
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
    },
  };
}

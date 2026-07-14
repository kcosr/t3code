import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import threadFixture from "./fixtures/voice-runtime-thread.json" with { type: "json" };

import {
  VoiceCommandReceipt,
  VoiceRealtimeOperationPhase,
  VoiceRuntimeCommand,
  VoiceRuntimeAuthorityReservation,
  VoiceRuntimeDescriptor,
  VoiceRuntimeEvent,
  VoiceRuntimeRebase,
  VoiceRuntimeSnapshot,
  VoiceRuntimeThreadTurnCreateInput,
  VoiceRuntimeThreadTurnDispositionInput,
  VoiceRuntimeThreadTurnDispositionResult,
  VoiceRuntimeThreadTurnEventsAckInput,
  VoiceRuntimeThreadTurnSnapshot,
  VoiceThreadOperationPhase,
  VoiceThreadTurnReceipt,
} from "./voiceRuntime.ts";

const decode = Schema.decodeUnknownSync;
const encode = Schema.encodeSync;
const strictDecode = <S extends Schema.Top>(schema: S, value: unknown): Schema.Schema.Type<S> =>
  decode(schema as never)(value, {
    onExcessProperty: "error",
  }) as Schema.Schema.Type<S>;

const target = {
  mode: "realtime",
  environmentId: "environment-1",
  conversationId: "conversation-1",
} as const;

const snapshot = {
  runtimeId: "runtime-1",
  runtimeInstanceId: "instance-1",
  generation: 4,
  sequence: 8,
  availability: "ready",
  target,
  operation: {
    kind: "realtime",
    modeSessionId: "mode-1",
    phase: "connected",
    conversationId: "conversation-1",
    sessionId: "session-1",
    muted: false,
  },
  mediaOwner: { kind: "realtime-peer", modeSessionId: "mode-1" },
  readiness: { state: "active", mode: "realtime" },
  route: { inputRouteId: "system", outputRouteId: "speaker" },
  failure: null,
} as const;

const cursor = {
  runtimeId: "runtime-1",
  runtimeInstanceId: "instance-1",
  generation: 4,
  sequence: 8,
} as const;

describe("voice runtime contracts", () => {
  it("shares exact Thread command snapshot event and receipt fixtures with Android", () => {
    const fixture: Record<string, unknown> = threadFixture;

    expect(strictDecode(VoiceRuntimeCommand, fixture.command)).toEqual(fixture.command);
    expect(strictDecode(VoiceRuntimeSnapshot, fixture.snapshot)).toEqual(fixture.snapshot);
    expect(strictDecode(VoiceThreadTurnReceipt, fixture.receipt)).toEqual(fixture.receipt);
    expect(strictDecode(VoiceRuntimeEvent, fixture.event)).toEqual(fixture.event);
  });
  it("strictly round-trips the descriptor and independent snapshot axes", () => {
    const descriptor = {
      protocolMajor: 1,
      executionModel: "autonomous",
      capabilities: {
        automaticEndpointing: true,
        recordingFormats: ["audio/mp4"],
        playbackFormats: [
          {
            encoding: "pcm-s16le",
            sampleRates: [16_000, 24_000],
            channelCounts: [1],
          },
        ],
        realtimeWebRtc: true,
        persistentReadiness: true,
        notificationControl: true,
        headsetControl: true,
        inputRouteSelection: true,
        outputRouteSelection: true,
      },
    } as const;
    const decodedDescriptor = strictDecode(VoiceRuntimeDescriptor, descriptor);
    const decodedSnapshot = strictDecode(VoiceRuntimeSnapshot, snapshot);

    expect(
      decode(VoiceRuntimeDescriptor)(encode(VoiceRuntimeDescriptor)(decodedDescriptor)),
    ).toEqual(decodedDescriptor);
    expect(decode(VoiceRuntimeSnapshot)(encode(VoiceRuntimeSnapshot)(decodedSnapshot))).toEqual(
      decodedSnapshot,
    );
    expect(() =>
      strictDecode(VoiceRuntimeSnapshot, { ...snapshot, androidService: true }),
    ).toThrow();
  });

  it("requires strict command identities and rejects mixed command fields", () => {
    const startRealtime = {
      kind: "start-realtime",
      commandId: "command-1",
      runtimeId: "runtime-1",
      runtimeInstanceId: "instance-1",
      authorityGeneration: 4,
      modeSessionId: "mode-1",
      interruptionPolicy: "stop-conflicting",
    } as const;
    const startThread = {
      kind: "start-thread-mode",
      commandId: "command-2",
      runtimeId: "runtime-1",
      runtimeInstanceId: "instance-1",
      authorityGeneration: 4,
      modeSessionId: "mode-2",
      turnClientOperationId: "turn-client-1",
      submissionPolicy: "auto-submit",
      draftContext: null,
      interruptionPolicy: "drain-conflicting",
    } as const;

    expect(strictDecode(VoiceRuntimeCommand, startRealtime)).toEqual(startRealtime);
    expect(strictDecode(VoiceRuntimeCommand, startThread)).toEqual(startThread);
    expect(
      strictDecode(VoiceRuntimeCommand, {
        kind: "finish-thread-turn",
        commandId: "command-3",
        runtimeId: "runtime-1",
        runtimeInstanceId: "instance-1",
        authorityGeneration: 4,
        modeSessionId: "mode-2",
        turnClientOperationId: "turn-client-1",
        outcome: "finish-to-draft",
        draftContext: {
          environmentId: "environment-1",
          projectId: "project-1",
          threadId: "thread-1",
          composerRevision: "revision-1",
        },
      }),
    ).toMatchObject({ outcome: "finish-to-draft" });
    expect(
      strictDecode(VoiceRuntimeThreadTurnDispositionInput, { submissionPolicy: "draft" }),
    ).toEqual({ submissionPolicy: "draft" });
    expect(() =>
      strictDecode(VoiceRuntimeCommand, {
        ...startRealtime,
        turnClientOperationId: "not-valid-for-realtime",
      }),
    ).toThrow();
    expect(() =>
      strictDecode(VoiceRuntimeCommand, {
        ...startThread,
        runtimeInstanceId: "",
      }),
    ).toThrow();
  });

  it("binds authority operations to their target mode and excludes UI-owned media commands", () => {
    const reservation = {
      runtimeId: "runtime-1",
      runtimeInstanceId: "instance-1",
      provisioningOperationId: "provision-1",
      expectedCurrentGeneration: 3,
      generation: 4,
      targetDigest: "digest",
      environmentOrigin: "https://termstation",
      target,
      operation: "realtime-start",
      readinessEnabled: true,
      token: "token",
      issuedAt: "2026-07-14T00:00:00.000Z",
      expiresAt: "2026-07-15T00:00:00.000Z",
    } as const;

    expect(strictDecode(VoiceRuntimeAuthorityReservation, reservation)).toEqual(reservation);
    expect(() =>
      strictDecode(VoiceRuntimeAuthorityReservation, {
        ...reservation,
        operation: "thread-turn-start",
      }),
    ).toThrow();
    expect(() =>
      strictDecode(VoiceRuntimeCommand, {
        kind: "start-manual-playback",
        commandId: "command-3",
        runtimeId: "runtime-1",
        runtimeInstanceId: "instance-1",
        authorityGeneration: 4,
        playbackOperationId: "playback-1",
        interruptionPolicy: "reject",
      }),
    ).toThrow();
  });

  it("covers every declared operation phase and requires reasons on exceptional thread phases", () => {
    const realtimePhases = [
      "preparing",
      "negotiating",
      "cueing",
      "connected",
      "draining",
      "stopping",
      "retrying",
      "recovering",
      "completed",
      "failed",
      "cancelled",
    ] as const;
    for (const phase of realtimePhases)
      expect(decode(VoiceRealtimeOperationPhase)(phase)).toBe(phase);

    expect(
      strictDecode(VoiceThreadOperationPhase, {
        phase: "paused",
        reason: "authority",
      }),
    ).toEqual({
      phase: "paused",
      reason: "authority",
    });
    expect(
      strictDecode(VoiceThreadOperationPhase, {
        phase: "attention-required",
        reason: "draft-review",
      }),
    ).toEqual({ phase: "attention-required", reason: "draft-review" });
    expect(() => strictDecode(VoiceThreadOperationPhase, { phase: "paused" })).toThrow();
    expect(() =>
      strictDecode(VoiceThreadOperationPhase, {
        phase: "recording",
        reason: "authority",
      }),
    ).toThrow();
  });

  it("round-trips rebases, command outcomes, and events without invented command causality", () => {
    const rebase = {
      type: "rebase",
      reason: "cursor-too-old",
      cursor,
      snapshot,
      threadReceipts: [],
      realtimeTerminalSummaries: [],
      draftArtifacts: [],
      presentationActions: [],
    } as const;
    const receipt = {
      commandId: "command-1",
      root: { kind: "mode", modeSessionId: "mode-1" },
      replayed: false,
      outcome: { type: "rebase-required", rebase },
      cursor,
    } as const;
    const recoveryEvent = {
      runtimeId: "runtime-1",
      runtimeInstanceId: "instance-1",
      authorityGeneration: 4,
      sequence: 9,
      occurredAt: "2026-07-14T00:00:00.000Z",
      root: { kind: "mode", modeSessionId: "mode-1" },
      kind: "operation-terminal",
      outcome: "interrupted",
    } as const;
    const commandEvent = {
      runtimeId: recoveryEvent.runtimeId,
      runtimeInstanceId: recoveryEvent.runtimeInstanceId,
      authorityGeneration: recoveryEvent.authorityGeneration,
      sequence: 10,
      occurredAt: recoveryEvent.occurredAt,
      root: recoveryEvent.root,
      kind: "command-outcome",
      causedByCommandId: "command-1",
      receipt: {
        ...receipt,
        outcome: { type: "accepted" },
        cursor: { ...cursor, sequence: 10 },
      },
    } as const;

    expect(strictDecode(VoiceRuntimeRebase, rebase)).toEqual(rebase);
    expect(strictDecode(VoiceCommandReceipt, receipt)).toEqual(receipt);
    expect(strictDecode(VoiceRuntimeEvent, recoveryEvent)).toEqual(recoveryEvent);
    expect(strictDecode(VoiceRuntimeEvent, commandEvent)).toEqual(commandEvent);
  });

  it("strictly binds thread child operations and monotonic speech receipt reports", () => {
    const create = {
      runtimeId: "runtime-1",
      runtimeInstanceId: "instance-1",
      generation: 4,
      modeSessionId: "mode-1",
      turnClientOperationId: "turn-client-1",
      submissionPolicy: "auto-submit",
      speechPlanId: "speech-plan-1",
    } as const;
    const operation = {
      operationId: "thread-operation-1",
      runtimeId: create.runtimeId,
      runtimeInstanceId: create.runtimeInstanceId,
      generation: create.generation,
      modeSessionId: create.modeSessionId,
      turnClientOperationId: create.turnClientOperationId,
      submissionPolicy: create.submissionPolicy,
      speechPlanId: create.speechPlanId,
      projectId: "project-1",
      threadId: "thread-1",
      speechPreset: "default",
      autoRearm: true,
      phase: "speaking",
      userMessageId: "message-user-1",
      turnId: "turn-1",
      assistantMessageIds: ["message-assistant-1"],
      highestAdvertisedSegment: 1,
      highestStartedSegment: 1,
      highestDrainedSegment: 0,
      segmentDispositions: [{ segmentIndex: 0, disposition: "drained" }],
      lastSequence: 6,
      acknowledgedSequence: 5,
      speechTerminal: null,
      dispatchAccepted: true,
      detachedAt: null,
      operationTokenExpiresAt: "2026-07-14T02:00:00.000Z",
      retentionExpiresAt: "2026-08-13T00:00:00.000Z",
    } as const;
    const acknowledgement = {
      acknowledgedSequence: 6,
      speechPlanId: create.speechPlanId,
      highestStartedSegment: 1,
      highestDrainedSegment: 1,
      segmentDispositions: [
        { segmentIndex: 0, disposition: "drained" },
        { segmentIndex: 1, disposition: "drained" },
      ],
    } as const;

    expect(strictDecode(VoiceRuntimeThreadTurnCreateInput, create)).toEqual(create);
    expect(
      strictDecode(VoiceRuntimeThreadTurnDispositionInput, { submissionPolicy: "draft" }),
    ).toEqual({ submissionPolicy: "draft" });
    expect(strictDecode(VoiceRuntimeThreadTurnDispositionResult, { snapshot: operation })).toEqual({
      snapshot: operation,
    });
    expect(() =>
      strictDecode(VoiceRuntimeThreadTurnDispositionInput, {
        submissionPolicy: "draft",
        legacy: true,
      }),
    ).toThrow();
    expect(strictDecode(VoiceRuntimeThreadTurnSnapshot, operation)).toEqual(operation);
    expect(strictDecode(VoiceRuntimeThreadTurnEventsAckInput, acknowledgement)).toEqual(
      acknowledgement,
    );
    expect(() =>
      strictDecode(VoiceRuntimeThreadTurnCreateInput, {
        ...create,
        clientOperationId: "legacy",
      }),
    ).toThrow();
  });
});

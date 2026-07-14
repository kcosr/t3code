import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  VoiceConversationSelection,
  VoiceConversationTranscriptEntry,
  VoiceConversationTranscriptQuery,
  VoiceConversationUpdateInput,
  VoiceMediaTicketRequest,
  VoiceRuntimeControlGrant,
  VoiceRuntimeHandoffActionAckInput,
  VoiceRuntimeHandoffActionListResult,
  VoiceRuntimeHeartbeatInput,
  VoiceRuntimeHeartbeatResult,
  VoiceRuntimeRealtimeStartInput,
  VoiceThreadTurnCreateInput,
  VoiceThreadTurnEventsAckInput,
  VoiceThreadTurnEventsQuery,
  VoiceThreadTurnEvent,
  VoiceSpeechRequest,
  VoiceSessionCreateInput,
  VoiceSessionCreateResult,
  VoiceSessionFocusInput,
  VoiceSessionEvent,
  VoiceSessionEventsResult,
  VoiceClientActionAckInput,
  VoiceWebRtcOffer,
  VoiceTranscriptionStreamEvent,
  VoiceTranscriptionMetadata,
} from "./voice.ts";

const decodeUnknownSync = Schema.decodeUnknownSync;
const encodeSync = Schema.encodeSync;
const decodeWebRtcOffer = decodeUnknownSync(VoiceWebRtcOffer);

describe("voice contracts", () => {
  it("strictly round-trips the runtime Realtime start input", () => {
    const values = [
      [
        VoiceRuntimeRealtimeStartInput,
        { runtimeId: "android-main", generation: 3, clientOperationId: "start-1" },
      ],
    ] as const;
    for (const [schema, value] of values) {
      const decoded = decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
      expect(decodeUnknownSync(schema)(encodeSync(schema)(decoded))).toEqual(decoded);
      expect(() =>
        decodeUnknownSync(schema)({ ...value, extra: true }, { onExcessProperty: "error" }),
      ).toThrow();
    }
  });

  it("strictly round-trips runtime Thread turn inputs and sanitized events", () => {
    const values = [
      [
        VoiceThreadTurnCreateInput,
        { runtimeId: "android-main", generation: 3, clientOperationId: "turn-1" },
      ],
      [VoiceThreadTurnEventsQuery, { afterSequence: 2, waitMilliseconds: 10_000 }],
      [VoiceThreadTurnEventsAckInput, { acknowledgedSequence: 4 }],
      [
        VoiceThreadTurnEvent,
        {
          type: "speech-ready",
          sequence: 5,
          occurredAt: "2026-07-13T12:00:00.000Z",
          segmentIndex: 1,
          finalSegment: false,
        },
      ],
    ] as const;
    for (const [schema, value] of values) {
      const decoded = decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
      expect(decodeUnknownSync(schema)(encodeSync(schema)(decoded))).toEqual(decoded);
      expect(() =>
        decodeUnknownSync(schema)(
          { ...value, transcript: "must not be journaled" },
          {
            onExcessProperty: "error",
          },
        ),
      ).toThrow();
    }
  });

  it("decodes a provider-neutral realtime session request", () => {
    const decoded = decodeUnknownSync(VoiceSessionCreateInput)({
      mode: "realtime-agent",
      conversation: {
        type: "continue",
        conversationId: "voice-conversation-1",
        takeover: true,
      },
      projectId: "project-1",
      threadId: "thread-1",
      media: {
        transports: ["webrtc-sdp-v1"],
        audioFormats: ["audio/pcm;rate=24000;encoding=s16le;channels=1"],
        supportsInputRouteSelection: true,
        supportsOutputRouteSelection: true,
      },
      idempotencyKey: "mobile-start-1",
    });

    expect(decoded.conversation).toMatchObject({
      type: "continue",
      takeover: true,
    });
  });

  it("preserves SDP line endings", () => {
    const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    expect(
      decodeWebRtcOffer({
        sessionId: "voice-session-1",
        leaseGeneration: 1,
        sdp,
      }).sdp,
    ).toBe(sdp);
  });

  it("rejects an unknown media transport", () => {
    expect(() =>
      decodeUnknownSync(VoiceSessionCreateInput)({
        mode: "realtime-agent",
        conversation: { type: "new", retention: "ephemeral" },
        media: {
          transports: ["provider-native-events"],
          audioFormats: ["audio/wav"],
          supportsInputRouteSelection: false,
          supportsOutputRouteSelection: false,
        },
        idempotencyKey: "mobile-start-2",
      }),
    ).toThrow();
  });

  it("requires explicit takeover intent when continuing", () => {
    expect(() =>
      decodeUnknownSync(VoiceConversationSelection)({
        type: "continue",
        conversationId: "voice-conversation-1",
      }),
    ).toThrow();
  });

  it("bounds public transcript and conversation management inputs", () => {
    expect(
      decodeUnknownSync(VoiceConversationTranscriptEntry)({
        entryId: "entry-1",
        contextEpoch: 2,
        sequence: 3,
        role: "assistant",
        text: "hello",
        truncated: false,
        occurredAt: "2026-07-11T00:00:00.000Z",
      }),
    ).toMatchObject({ contextEpoch: 2, role: "assistant", text: "hello" });
    expect(() => decodeUnknownSync(VoiceConversationTranscriptQuery)({ limit: 51 })).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceConversationTranscriptEntry)({
        entryId: "entry-1",
        contextEpoch: 1,
        sequence: 1,
        role: "user",
        text: "x".repeat(16_001),
        truncated: false,
        occurredAt: "2026-07-11T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceConversationUpdateInput)({
        title: "x".repeat(257),
      }),
    ).toThrow();
  });

  it("defines clear, project, and project-thread focus without accepting a thread alone", () => {
    expect(decodeUnknownSync(VoiceSessionFocusInput)({ leaseGeneration: 1 })).toEqual({
      leaseGeneration: 1,
    });
    expect(
      decodeUnknownSync(VoiceSessionFocusInput)({
        leaseGeneration: 1,
        projectId: "project-1",
        threadId: "thread-1",
      }),
    ).toMatchObject({ projectId: "project-1", threadId: "thread-1" });
    expect(() =>
      decodeUnknownSync(VoiceSessionFocusInput)({
        leaseGeneration: 1,
        threadId: "thread-1",
      }),
    ).toThrow();
  });

  it("decodes normalized events without provider identifiers", () => {
    const decoded = decodeUnknownSync(VoiceSessionEvent)({
      type: "confirmation-required",
      sessionId: "voice-session-1",
      leaseGeneration: 2,
      sequence: 7,
      occurredAt: "2026-07-10T20:00:00.000Z",
      confirmationId: "voice-confirmation-1",
      toolCallId: "voice-tool-call-1",
      tool: "send_thread_message",
      summary: "Send a message to the selected thread",
      expiresAt: "2026-07-10T20:01:00.000Z",
    });

    expect(decoded.type).toBe("confirmation-required");
    expect(decoded).not.toHaveProperty("providerCallId");
  });

  it("decodes acknowledged client navigation actions", () => {
    expect(
      decodeUnknownSync(VoiceSessionEvent)({
        type: "client-action",
        sessionId: "voice-session-1",
        leaseGeneration: 2,
        sequence: 8,
        occurredAt: "2026-07-10T20:00:00.000Z",
        action: "activate-thread",
        actionId: "voice-client-action-1",
        projectId: "project-1",
        threadId: "thread-1",
        expiresAt: "2026-07-10T20:00:10.000Z",
      }),
    ).toMatchObject({ action: "activate-thread", threadId: "thread-1" });
    expect(
      decodeUnknownSync(VoiceClientActionAckInput)({
        leaseGeneration: 2,
        action: "activate-thread",
        outcome: "failed",
        message: "Navigation was unavailable",
      }),
    ).toMatchObject({ outcome: "failed" });
    expect(
      decodeUnknownSync(VoiceClientActionAckInput)({
        leaseGeneration: 2,
        action: "handoff-to-thread-voice",
        outcome: "succeeded",
        state: "accepted",
      }),
    ).toMatchObject({ action: "handoff-to-thread-voice", state: "accepted" });
  });

  it("preserves partial transcript boundaries and normalizes final transcripts", () => {
    const eventBase = {
      type: "transcript" as const,
      sessionId: "voice-session-1",
      leaseGeneration: 1,
      sequence: 8,
      occurredAt: "2026-07-10T20:00:00.000Z",
      role: "assistant" as const,
    };

    expect(
      decodeUnknownSync(VoiceSessionEvent)({
        ...eventBase,
        text: " ",
        final: false,
      }),
    ).toEqual({ ...eventBase, text: " ", final: false });
    expect(
      decodeUnknownSync(VoiceSessionEvent)({
        ...eventBase,
        text: " next ",
        final: false,
      }),
    ).toEqual({ ...eventBase, text: " next ", final: false });
    const partial = decodeUnknownSync(VoiceSessionEvent)({
      ...eventBase,
      text: " next ",
      final: false,
    });
    expect(encodeSync(VoiceSessionEvent)(partial)).toEqual({
      ...eventBase,
      text: " next ",
      final: false,
    });
    expect(
      decodeUnknownSync(VoiceSessionEvent)({
        ...eventBase,
        text: "  Finished.  ",
        final: true,
      }),
    ).toEqual({ ...eventBase, text: "Finished.", final: true });
    expect(() =>
      decodeUnknownSync(VoiceSessionEvent)({
        ...eventBase,
        text: " ",
        final: true,
      }),
    ).toThrow();

    const result = decodeUnknownSync(VoiceSessionEventsResult)({
      state: {
        sessionId: "voice-session-1",
        conversationId: "voice-conversation-1",
        mode: "realtime-agent",
        phase: "speaking",
        leaseGeneration: 1,
        sequence: 8,
      },
      events: [{ ...eventBase, text: " ", final: false }],
    });
    expect(result.events[0]).toMatchObject({
      text: " ",
      final: false,
      sequence: 8,
    });
  });

  it("defines streaming recognition deltas and an authoritative final event", () => {
    const delta = decodeUnknownSync(VoiceTranscriptionStreamEvent)({
      type: "delta",
      requestId: "voice-request-1",
      text: "hello",
    });
    const final = decodeUnknownSync(VoiceTranscriptionStreamEvent)({
      type: "final",
      result: { requestId: "voice-request-1", text: "hello world" },
    });

    expect(delta.type).toBe("delta");
    expect(final.type).toBe("final");
  });

  it("requires ordered segment metadata for streaming thread speech", () => {
    const segment = decodeUnknownSync(VoiceSpeechRequest)({
      requestId: "voice-request-2",
      playbackId: "voice-playback-1",
      segmentIndex: 0,
      finalSegment: false,
      text: "The first complete sentence.",
      preset: "default",
    });

    expect(segment.segmentIndex).toBe(0);
    expect(segment.finalSegment).toBe(false);
  });

  it("bounds transcription metadata and accepts only canonical Android MP4 uploads", () => {
    const valid = decodeUnknownSync(VoiceTranscriptionMetadata)({
      requestId: "voice-request-stt",
      format: "audio/mp4",
      language: "en-US",
      vocabulary: Array.from({ length: 64 }, (_, index) => `term-${index}`),
    });
    expect(valid.format).toBe("audio/mp4");
    expect(() =>
      decodeUnknownSync(VoiceTranscriptionMetadata)({
        requestId: "voice-request-stt",
        format: "audio/wav",
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceTranscriptionMetadata)({
        requestId: "voice-request-stt",
        format: "audio/mp4",
        language: "not_a_language",
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceTranscriptionMetadata)({
        requestId: "voice-request-stt",
        format: "audio/mp4",
        vocabulary: Array.from({ length: 65 }, (_, index) => `term-${index}`),
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceTranscriptionMetadata)({
        requestId: "voice-request-stt",
        format: "audio/mp4",
        vocabulary: ["x".repeat(129)],
      }),
    ).toThrow();
  });

  it("bounds speech by UTF-8 bytes and restricts presets to server-known values", () => {
    const base = {
      requestId: "voice-request-speech",
      playbackId: "voice-playback-speech",
      segmentIndex: 0,
      finalSegment: true,
    };
    expect(
      decodeUnknownSync(VoiceSpeechRequest)({
        ...base,
        text: "x".repeat(8 * 1024),
        preset: "warm",
      }).preset,
    ).toBe("warm");
    expect(() =>
      decodeUnknownSync(VoiceSpeechRequest)({
        ...base,
        text: "x".repeat(8 * 1024 + 1),
        preset: "default",
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceSpeechRequest)({
        ...base,
        text: "😀".repeat(2_049),
        preset: "default",
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceSpeechRequest)({
        ...base,
        text: "hello",
        preset: "unknown",
      }),
    ).toThrow();
  });

  it("uses operation-discriminated media ticket bindings", () => {
    expect(
      decodeUnknownSync(VoiceMediaTicketRequest)({
        operation: "speech-stream",
        requestId: "voice-request-ticket",
      }),
    ).toEqual({
      operation: "speech-stream",
      requestId: "voice-request-ticket",
    });
    expect(() =>
      decodeUnknownSync(VoiceMediaTicketRequest)({
        operation: "speech-stream",
        sessionId: "voice-session-ticket",
      }),
    ).toThrow();
    expect(() =>
      decodeUnknownSync(VoiceMediaTicketRequest)({
        operation: "voice-heartbeat",
        sessionId: "voice-session-ticket",
      }),
    ).toThrow();
  });

  it("decodes exact native control grant and heartbeat shapes", () => {
    const grant = {
      token: "native-control-token",
      sessionId: "voice-session-native",
      leaseGeneration: 2,
      expiresAt: "2026-07-12T12:00:00.000Z",
      heartbeatIntervalSeconds: 10,
      failureGraceSeconds: 30,
    };
    expect(decodeUnknownSync(VoiceRuntimeControlGrant)(grant)).toEqual(grant);
    expect(() =>
      decodeUnknownSync(VoiceRuntimeControlGrant)({
        ...grant,
        token: "x".repeat(129),
      }),
    ).toThrow();
    expect(decodeUnknownSync(VoiceRuntimeHeartbeatInput)({ leaseGeneration: 2 })).toEqual({
      leaseGeneration: 2,
    });
    const heartbeat = {
      sessionId: grant.sessionId,
      leaseGeneration: 2,
      phase: "listening",
      disposition: "live",
      handoffPending: false,
      expiresAt: grant.expiresAt,
    } as const;
    expect(decodeUnknownSync(VoiceRuntimeHeartbeatResult)(heartbeat)).toEqual(heartbeat);
    const createResult = {
      state: {
        sessionId: grant.sessionId,
        conversationId: "voice-conversation-native",
        mode: "realtime-agent",
        phase: "signaling",
        leaseGeneration: 2,
        sequence: 0,
      },
      transport: { kind: "webrtc-sdp-v1", signalingPath: "/offer" },
      expiresAt: grant.expiresAt,
      heartbeatIntervalSeconds: 10,
      runtimeControlGrant: grant,
    } as const;
    expect(decodeUnknownSync(VoiceSessionCreateResult)(createResult)).toMatchObject({
      runtimeControlGrant: grant,
    });

    for (const [schema, value] of [
      [VoiceRuntimeControlGrant, { ...grant, extra: true }],
      [VoiceRuntimeHeartbeatInput, { leaseGeneration: 2, extra: true }],
      [VoiceRuntimeHeartbeatResult, { ...heartbeat, extra: true }],
      [VoiceSessionCreateResult, { ...createResult, extra: true }],
    ] as const) {
      expect(() => decodeUnknownSync(schema)(value, { onExcessProperty: "error" })).toThrow();
    }
  });

  it("decodes native handoff polling and acknowledgement shapes", () => {
    const result = {
      actions: [
        {
          actionId: "voice-client-action-1",
          sessionId: "voice-session-1",
          leaseGeneration: 2,
          projectId: "project-1",
          threadId: "thread-1",
          autoRearm: true,
          expiresAt: "2026-07-12T18:00:00.000Z",
        },
      ],
    };
    expect(decodeUnknownSync(VoiceRuntimeHandoffActionListResult)(result)).toEqual(result);
    expect(
      decodeUnknownSync(VoiceRuntimeHandoffActionAckInput)({
        outcome: "succeeded",
        state: "accepted",
      }),
    ).toEqual({ outcome: "succeeded", state: "accepted" });
    expect(() =>
      decodeUnknownSync(VoiceRuntimeHandoffActionAckInput)(
        {
          outcome: "succeeded",
          state: "accepted",
          leaseGeneration: 2,
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});

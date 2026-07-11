import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  VoiceConversationSelection,
  VoiceSpeechRequest,
  VoiceSessionCreateInput,
  VoiceSessionEvent,
  VoiceWebRtcOffer,
  VoiceTranscriptionStreamEvent,
} from "./voice.ts";

const decodeUnknownSync = Schema.decodeUnknownSync;

describe("voice contracts", () => {
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
      Schema.decodeUnknownSync(VoiceWebRtcOffer)({
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
});

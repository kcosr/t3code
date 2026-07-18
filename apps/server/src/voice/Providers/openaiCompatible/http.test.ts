import { describe, expect, it } from "vitest";

import {
  isCompatiblePcmContentType,
  mapOpenAiCompatibleHttpStatus,
  sanitizedUpstreamRequestId,
} from "./http.ts";

describe("openai-compatible voice HTTP helpers", () => {
  it("accepts compatible PCM content types", () => {
    expect(isCompatiblePcmContentType("audio/pcm")).toBe(true);
    expect(isCompatiblePcmContentType("audio/pcm;rate=24000")).toBe(true);
    expect(isCompatiblePcmContentType("application/octet-stream")).toBe(true);
    expect(isCompatiblePcmContentType("audio/L16;rate=24000;channels=1")).toBe(true);
    expect(isCompatiblePcmContentType("audio/mpeg")).toBe(false);
    expect(isCompatiblePcmContentType(undefined)).toBe(false);
  });

  it("maps upstream statuses to public voice reasons", () => {
    expect(mapOpenAiCompatibleHttpStatus(401, "op").reason).toBe("not-configured");
    expect(mapOpenAiCompatibleHttpStatus(403, "op").reason).toBe("not-configured");
    expect(mapOpenAiCompatibleHttpStatus(400, "op").reason).toBe("unsupported-media");
    expect(mapOpenAiCompatibleHttpStatus(415, "op").reason).toBe("unsupported-media");
    expect(mapOpenAiCompatibleHttpStatus(413, "op").reason).toBe("payload-too-large");
    expect(mapOpenAiCompatibleHttpStatus(429, "op").reason).toBe("quota-exceeded");
    expect(mapOpenAiCompatibleHttpStatus(429, "op").retryable).toBe(true);
    expect(mapOpenAiCompatibleHttpStatus(503, "op").reason).toBe("provider-unavailable");
    expect(mapOpenAiCompatibleHttpStatus(500, "op").retryable).toBe(true);
  });

  it("sanitizes upstream request ids without accepting free text", () => {
    expect(sanitizedUpstreamRequestId({ "x-request-id": "req_abc-123" })).toBe("req_abc-123");
    expect(
      sanitizedUpstreamRequestId({ "x-request-id": "has spaces and secrets" }),
    ).toBeUndefined();
  });
});

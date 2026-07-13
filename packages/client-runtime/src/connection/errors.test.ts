import { describe, expect, it } from "@effect/vitest";
import { EnvironmentVoiceOperationError } from "@t3tools/contracts";

import { mapRemoteEnvironmentError } from "./errors.ts";
import { ConnectionTransientError } from "./model.ts";

describe("mapRemoteEnvironmentError", () => {
  it("keeps unexpected voice failures recoverable during connection setup", () => {
    const mapped = mapRemoteEnvironmentError(
      new EnvironmentVoiceOperationError({
        code: "voice_operation_failed",
        reason: "invalid-phase",
        message: "Unexpected voice response during authorization.",
        retryable: false,
        traceId: "trace-auth-voice-error",
      }),
    );

    expect(mapped).toBeInstanceOf(ConnectionTransientError);
    expect(mapped).toMatchObject({
      reason: "remote-unavailable",
      traceId: "trace-auth-voice-error",
    });
  });
});

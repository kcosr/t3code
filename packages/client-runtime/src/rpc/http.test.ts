import { describe, expect, it } from "@effect/vitest";
import { EnvironmentAuthInvalidError, EnvironmentVoiceOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { executeEnvironmentHttpRequest, RemoteEnvironmentAuthInvalidJsonError } from "./http.ts";

const decodeStringValue = Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }));

describe("executeEnvironmentHttpRequest", () => {
  it.effect("preserves declared voice operation failures", () =>
    Effect.gen(function* () {
      const error = new EnvironmentVoiceOperationError({
        code: "voice_operation_failed",
        reason: "provider-unavailable",
        message: "The voice provider is unavailable.",
        retryable: true,
        traceId: "trace-voice-provider",
      });

      const failure = yield* executeEnvironmentHttpRequest(
        "https://environment.example.test/api/voice/sessions",
        1_000,
        Effect.fail(error),
      ).pipe(Effect.flip);

      expect(failure).toBe(error);
      expect(failure).toMatchObject({
        _tag: "EnvironmentVoiceOperationError",
        message: "The voice provider is unavailable.",
        retryable: true,
      });
    }),
  );

  it.effect("preserves common environment failures", () =>
    Effect.gen(function* () {
      const error = new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-auth-invalid",
      });

      const failure = yield* executeEnvironmentHttpRequest(
        "https://environment.example.test/.well-known/t3/environment",
        1_000,
        Effect.fail(error),
      ).pipe(Effect.flip);

      expect(failure).toBe(error);
    }),
  );

  it.effect("classifies schema decoding failures", () =>
    Effect.gen(function* () {
      const request = decodeStringValue({ value: 1 });

      const failure = yield* executeEnvironmentHttpRequest(
        "https://environment.example.test/api/voice/sessions",
        1_000,
        request,
      ).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(RemoteEnvironmentAuthInvalidJsonError);
    }),
  );
});

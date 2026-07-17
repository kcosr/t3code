import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http";

import { decodeBoundedJson } from "./http.ts";

describe("voice media HTTP bounds", () => {
  it.effect("preserves the typed policy error for an oversized speech body", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("https://example.test/api/voice/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"text":"too large"}',
        }),
      );
      const result = yield* decodeBoundedJson(request, 4).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isSuccess(result)) return;
      const error = result.failure;
      assert.equal(error._tag, "VoiceMediaPolicyError");
      if (error._tag === "VoiceMediaPolicyError") {
        assert.equal(error.reason, "payload-too-large");
      }
    }),
  );
});

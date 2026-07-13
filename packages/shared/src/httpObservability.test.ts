import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { httpHeaderRedactionLayer } from "./httpObservability.ts";

describe("HTTP observability", () => {
  it.effect("redacts authentication and native voice control headers", () =>
    Effect.gen(function* () {
      const names = yield* Headers.CurrentRedactedNames;

      expect(names).toContain("authorization");
      expect(names).toContain("dpop");
      expect(names).toContain("x-t3-voice-control");
      expect(names).toContain("x-t3-voice-runtime");
    }).pipe(Effect.provide(httpHeaderRedactionLayer)),
  );
});

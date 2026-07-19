import { describe, expect, it } from "vitest";

import { ExclusiveTransition } from "./exclusiveTransition";

describe("ExclusiveTransition", () => {
  it("serializes concurrent admissions", async () => {
    const gate = new ExclusiveTransition();
    let resolveFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const first = gate.run(async () => {
      await firstHold;
    });
    const second = gate.run(async () => {
      throw new Error("should not run");
    });

    expect(gate.active).toBe(true);
    expect(await second).toBe(false);
    resolveFirst();
    expect(await first).toBe(true);
    expect(gate.active).toBe(false);
  });
});

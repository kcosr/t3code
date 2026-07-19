import { describe, expect, it } from "vitest";

import { VoiceMediaOwnerGate } from "./mediaOwner";

describe("VoiceMediaOwnerGate", () => {
  it("admits exactly one owner and requires exact release before replace", async () => {
    const gate = new VoiceMediaOwnerGate();
    const releases: string[] = [];

    const first = await gate.admit("realtime", async (generation) => ({
      release: async () => {
        releases.push(`realtime:${generation}`);
      },
    }));
    expect(gate.getState()).toEqual({ owner: "realtime", generation: 1 });
    expect(first.generation).toBe(1);

    const second = await gate.admit("thread-auto-listen", async (generation) => ({
      release: async () => {
        releases.push(`thread:${generation}`);
      },
    }));
    expect(releases).toEqual(["realtime:1"]);
    expect(gate.getState()).toEqual({ owner: "thread-auto-listen", generation: 2 });
    expect(second.generation).toBe(2);

    await second.release();
    expect(releases).toEqual(["realtime:1", "thread:2"]);
    expect(gate.getState().owner).toBe("none");
  });

  it("serializes concurrent admissions", async () => {
    const gate = new VoiceMediaOwnerGate();
    let resolveHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      resolveHold = resolve;
    });

    const firstPromise = gate.admit("realtime", async () => {
      await hold;
      return { release: async () => undefined };
    });
    const secondPromise = gate.admit("dictation", async () => ({
      release: async () => undefined,
    }));

    resolveHold();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(gate.getState().owner).toBe("dictation");
  });
});

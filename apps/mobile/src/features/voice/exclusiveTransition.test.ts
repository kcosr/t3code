import { describe, expect, it, vi } from "vite-plus/test";

import { ExclusiveTransition } from "./exclusiveTransition";

describe("ExclusiveTransition", () => {
  it("admits one ownership transition and does not run a competing operation", async () => {
    const transition = new ExclusiveTransition();
    let releaseWinner!: () => void;
    const winnerOperation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWinner = resolve;
        }),
    );
    const competingOperation = vi.fn(async () => undefined);

    const winner = transition.run(winnerOperation);

    expect(transition.active).toBe(true);
    await expect(transition.run(competingOperation)).resolves.toBe(false);
    expect(competingOperation).not.toHaveBeenCalled();

    releaseWinner();
    await expect(winner).resolves.toBe(true);
    expect(winnerOperation).toHaveBeenCalledOnce();
    expect(transition.active).toBe(false);
  });

  it("releases admission after a failed transition", async () => {
    const transition = new ExclusiveTransition();

    await expect(
      transition.run(async () => {
        throw new Error("transition failed");
      }),
    ).rejects.toThrow("transition failed");

    expect(transition.active).toBe(false);
    await expect(transition.run(async () => undefined)).resolves.toBe(true);
  });
});

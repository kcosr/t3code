import { describe, expect, it } from "vite-plus/test";

import { findCompletedAutoListenResponse } from "./autoListenResponse";

describe("findCompletedAutoListenResponse", () => {
  it("correlates the terminal assistant message through the submitted user turn", () => {
    expect(
      findCompletedAutoListenResponse(
        [
          { id: "other", role: "assistant", turnId: "turn-0", streaming: false },
          { id: "sent", role: "user", turnId: "turn-1", streaming: false },
          { id: "commentary", role: "assistant", turnId: "turn-1", streaming: false },
          { id: "final", role: "assistant", turnId: "turn-1", streaming: false },
        ],
        "sent",
      )?.id,
    ).toBe("final");
  });

  it("does not accept unrelated, unbound, or streaming responses", () => {
    expect(
      findCompletedAutoListenResponse(
        [
          { id: "sent", role: "user", turnId: null, streaming: false },
          { id: "other", role: "assistant", turnId: "turn-2", streaming: false },
        ],
        "sent",
      ),
    ).toBeNull();
    expect(
      findCompletedAutoListenResponse(
        [
          { id: "sent", role: "user", turnId: "turn-1", streaming: false },
          { id: "active", role: "assistant", turnId: "turn-1", streaming: true },
        ],
        "sent",
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { findCompletedAutoListenResponse, hasUserMessageAfter } from "./autoListenResponse";

describe("findCompletedAutoListenResponse", () => {
  it("detects when a later user message makes response correlation ambiguous", () => {
    const messages = [
      { id: "sent", role: "user", turnId: null, streaming: false },
      { id: "later", role: "user", turnId: null, streaming: false },
    ] as const;

    expect(hasUserMessageAfter(messages, "sent")).toBe(true);
    expect(hasUserMessageAfter(messages, "later")).toBe(false);
    expect(hasUserMessageAfter(messages, "missing")).toBe(false);
  });
  it("keeps a completed response correlatable when it precedes a later user", () => {
    const messages = [
      { id: "sent", role: "user", turnId: null, streaming: false },
      { id: "response", role: "assistant", turnId: "turn-1", streaming: false },
      { id: "later", role: "user", turnId: null, streaming: false },
    ] as const;

    expect(findCompletedAutoListenResponse(messages, "sent")?.id).toBe("response");
  });
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

  it("correlates a response by ordering when queued user messages have no turn id", () => {
    expect(
      findCompletedAutoListenResponse(
        [
          { id: "older", role: "assistant", turnId: "turn-0", streaming: false },
          { id: "sent", role: "user", turnId: null, streaming: false },
          { id: "response", role: "assistant", turnId: "turn-2", streaming: false },
        ],
        "sent",
      )?.id,
    ).toBe("response");
  });

  it("does not accept earlier, missing, or streaming responses", () => {
    expect(
      findCompletedAutoListenResponse(
        [
          { id: "older", role: "assistant", turnId: "turn-0", streaming: false },
          { id: "sent", role: "user", turnId: null, streaming: false },
        ],
        "sent",
      ),
    ).toBeNull();
    expect(
      findCompletedAutoListenResponse(
        [
          { id: "sent", role: "user", turnId: null, streaming: false },
          { id: "later", role: "user", turnId: null, streaming: false },
          { id: "later-response", role: "assistant", turnId: "turn-2", streaming: false },
        ],
        "sent",
      ),
    ).toBeNull();
    expect(
      findCompletedAutoListenResponse(
        [
          { id: "sent", role: "user", turnId: null, streaming: false },
          { id: "commentary", role: "assistant", turnId: "turn-1", streaming: false },
          { id: "final", role: "assistant", turnId: "turn-1", streaming: true },
        ],
        "sent",
      ),
    ).toBeNull();
    expect(
      findCompletedAutoListenResponse(
        [{ id: "other", role: "assistant", turnId: "turn-2", streaming: false }],
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

import type { OrchestrationMessage, VoiceThreadTurnReceipt } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  isNativeVoiceReceiptProjected,
  type NativeVoiceReceiptProjectionSource,
  waitForNativeVoiceReceiptProjection,
} from "./nativeVoiceReceiptProjection";

const receipt = {
  userMessageId: "user-1",
  assistantMessageIds: ["assistant-1"],
  turnId: "turn-1",
  target: { environmentId: "environment-1", projectId: "project-1", threadId: "thread-1" },
} as unknown as VoiceThreadTurnReceipt;

const message = (id: string, turnId: string | null): OrchestrationMessage =>
  ({ id, turnId }) as OrchestrationMessage;

class ProjectionSource implements NativeVoiceReceiptProjectionSource {
  messages: ReadonlyArray<OrchestrationMessage> = [];
  private readonly listeners = new Set<(messages: ReadonlyArray<OrchestrationMessage>) => void>();
  read = () => this.messages;
  subscribe = (
    _receipt: VoiceThreadTurnReceipt,
    listener: (messages: ReadonlyArray<OrchestrationMessage>) => void,
  ) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(messages: ReadonlyArray<OrchestrationMessage>) {
    this.messages = messages;
    for (const listener of this.listeners) listener(messages);
  }
}

describe("native voice receipt projection", () => {
  it("requires every named ordinary message and the correlated turn", () => {
    expect(isNativeVoiceReceiptProjected(receipt, [])).toBe(false);
    expect(isNativeVoiceReceiptProjected(receipt, [message("user-1", "turn-1")])).toBe(false);
    expect(
      isNativeVoiceReceiptProjected(receipt, [
        message("user-1", "turn-1"),
        message("assistant-1", "turn-1"),
      ]),
    ).toBe(true);
  });

  it("retains the receipt across a React death until a restarted projection catches up", async () => {
    const source = new ProjectionSource();
    const firstProcess = new AbortController();
    const firstAcknowledgement = vi.fn();
    const firstWait = waitForNativeVoiceReceiptProjection(
      receipt,
      source,
      firstProcess.signal,
    ).then(firstAcknowledgement);

    firstProcess.abort();
    await expect(firstWait).rejects.toThrow("cancelled");
    expect(firstAcknowledgement).not.toHaveBeenCalled();

    const restartedAcknowledgement = vi.fn();
    const restartedWait = waitForNativeVoiceReceiptProjection(receipt, source).then(
      restartedAcknowledgement,
    );
    source.publish([message("user-1", "turn-1"), message("assistant-1", "turn-1")]);
    await restartedWait;
    expect(restartedAcknowledgement).toHaveBeenCalledOnce();
  });
});

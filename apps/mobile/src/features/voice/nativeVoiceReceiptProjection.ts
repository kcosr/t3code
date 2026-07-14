import type { OrchestrationMessage, VoiceThreadTurnReceipt } from "@t3tools/contracts";

export interface NativeVoiceReceiptProjectionSource {
  readonly read: (receipt: VoiceThreadTurnReceipt) => ReadonlyArray<OrchestrationMessage>;
  readonly subscribe: (
    receipt: VoiceThreadTurnReceipt,
    listener: (messages: ReadonlyArray<OrchestrationMessage>) => void,
  ) => () => void;
}

export function isNativeVoiceReceiptProjected(
  receipt: VoiceThreadTurnReceipt,
  messages: ReadonlyArray<Pick<OrchestrationMessage, "id" | "turnId">>,
): boolean {
  const messageIds = new Set(messages.map((message) => message.id));
  if (receipt.userMessageId !== null && !messageIds.has(receipt.userMessageId)) return false;
  if (receipt.assistantMessageIds.some((messageId) => !messageIds.has(messageId))) return false;
  return receipt.turnId === null || messages.some((message) => message.turnId === receipt.turnId);
}

export async function waitForNativeVoiceReceiptProjection(
  receipt: VoiceThreadTurnReceipt,
  source: NativeVoiceReceiptProjectionSource,
  signal?: AbortSignal,
): Promise<void> {
  if (isNativeVoiceReceiptProjected(receipt, source.read(receipt))) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (cause?: Error) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const onAbort = () => finish(new Error("Native voice receipt projection wait was cancelled."));
    unsubscribe = source.subscribe(receipt, (messages) => {
      if (isNativeVoiceReceiptProjected(receipt, messages)) finish();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
    } else if (isNativeVoiceReceiptProjected(receipt, source.read(receipt))) {
      finish();
    }
  });
}

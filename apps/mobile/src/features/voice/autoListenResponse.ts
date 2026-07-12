export interface AutoListenThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly turnId: string | null;
  readonly streaming: boolean;
}

export function hasUserMessageAfter(
  messages: ReadonlyArray<AutoListenThreadMessage>,
  messageId: string,
): boolean {
  const submittedIndex = messages.findIndex((message) => message.id === messageId);
  return (
    submittedIndex >= 0 &&
    messages.some((message, index) => index > submittedIndex && message.role === "user")
  );
}

export function findCompletedAutoListenResponse(
  messages: ReadonlyArray<AutoListenThreadMessage>,
  submittedMessageId: string,
): AutoListenThreadMessage | null {
  const submittedIndex = messages.findIndex(
    (message) => message.id === submittedMessageId && message.role === "user",
  );
  if (submittedIndex < 0) return null;
  const submitted = messages[submittedIndex];
  if (submitted === undefined) return null;
  const nextUserIndex =
    submitted.turnId === null
      ? messages.findIndex((message, index) => index > submittedIndex && message.role === "user")
      : -1;
  const upperBound = nextUserIndex < 0 ? messages.length : nextUserIndex;
  for (let index = upperBound - 1; index > submittedIndex; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (submitted.turnId !== null && message.turnId !== submitted.turnId) continue;
    return message.streaming ? null : message;
  }
  return null;
}

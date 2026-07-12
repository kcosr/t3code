export interface AutoListenThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly turnId: string | null;
  readonly streaming: boolean;
}

export function findCompletedAutoListenResponse(
  messages: ReadonlyArray<AutoListenThreadMessage>,
  submittedMessageId: string,
): AutoListenThreadMessage | null {
  const submitted = messages.find(
    (message) => message.id === submittedMessageId && message.role === "user",
  );
  if (submitted?.turnId === null || submitted?.turnId === undefined) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.turnId === submitted.turnId &&
      !message.streaming
    ) {
      return message;
    }
  }
  return null;
}

const INITIAL_RETRY_DELAY_MILLIS = 250;
const MAX_RETRY_DELAY_MILLIS = 1_000;

export interface ClientActionAcknowledgementInput {
  readonly outcome: "succeeded" | "failed";
  readonly message?: string;
}

export const clientActionAcknowledgementInput = (
  outcome: ClientActionAcknowledgementInput["outcome"],
  message?: string,
): ClientActionAcknowledgementInput => {
  const trimmedMessage = message?.trim();
  return {
    outcome,
    ...(trimmedMessage ? { message: trimmedMessage.slice(0, 240) } : {}),
  };
};

export const acknowledgeClientActionWithRetry = async (options: {
  readonly expiresAtMillis: number;
  readonly acknowledge: (input: ClientActionAcknowledgementInput) => Promise<void>;
  readonly input: ClientActionAcknowledgementInput;
  readonly shouldContinue: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (delayMillis: number) => Promise<void>;
}): Promise<boolean> => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((delayMillis) => new Promise<void>((resolve) => setTimeout(resolve, delayMillis)));
  let retryDelayMillis = INITIAL_RETRY_DELAY_MILLIS;
  let attempted = false;

  while (options.shouldContinue() && (!attempted || now() < options.expiresAtMillis)) {
    attempted = true;
    try {
      await options.acknowledge(options.input);
      return true;
    } catch {
      const remainingMillis = options.expiresAtMillis - now();
      if (remainingMillis <= 0) return false;
      await sleep(Math.min(retryDelayMillis, remainingMillis));
      retryDelayMillis = Math.min(retryDelayMillis * 2, MAX_RETRY_DELAY_MILLIS);
    }
  }

  return false;
};

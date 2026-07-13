const INITIAL_RETRY_DELAY_MILLIS = 250;
const MAX_RETRY_DELAY_MILLIS = 1_000;

export interface ClientActionAcknowledgementInput {
  readonly action: "activate-thread";
  readonly outcome: "succeeded" | "failed";
  readonly message?: string;
}

export const clientActionAcknowledgementInput = (
  outcome: ClientActionAcknowledgementInput["outcome"],
  message?: string,
): ClientActionAcknowledgementInput => {
  const trimmedMessage = message?.trim();
  return {
    action: "activate-thread",
    outcome,
    ...(trimmedMessage ? { message: trimmedMessage.slice(0, 240) } : {}),
  };
};

export const executeThreadActivation = async (options: {
  readonly navigate: () => void;
  readonly updateFocus: () => Promise<void>;
  readonly acknowledge: (
    outcome: ClientActionAcknowledgementInput["outcome"],
    message?: string,
  ) => Promise<void>;
  readonly errorMessage: (cause: unknown) => string;
}): Promise<void> => {
  try {
    options.navigate();
  } catch (cause) {
    await options.acknowledge("failed", options.errorMessage(cause));
    return;
  }
  const focusUpdate = options.updateFocus().then(
    () => ({ success: true as const }),
    (cause: unknown) => ({ success: false as const, cause }),
  );
  await options.acknowledge("succeeded");
  const focusResult = await focusUpdate;
  if (!focusResult.success) throw focusResult.cause;
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

export const voiceErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const isNativeVoiceErrorCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

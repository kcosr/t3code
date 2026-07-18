/**
 * Classify Pi failure messages as interrupted vs hard failure.
 * Adapted from Synara's piTurnFailure helper (SDK path); applies equally to RPC.
 */

const PI_INTERRUPTION_MARKERS = [
  "request was aborted",
  "operation was aborted",
  "aborterror",
  "interrupted by user",
  "user aborted",
  "aborted",
] as const;

export interface PiTurnFailureClassification {
  readonly state: "failed" | "interrupted";
  readonly stopReason: "error" | "aborted";
}

export function isPiInterruptedMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return PI_INTERRUPTION_MARKERS.some((marker) => normalized.includes(marker));
}

export function classifyPiTurnFailure(message: string): PiTurnFailureClassification {
  if (isPiInterruptedMessage(message)) {
    return { state: "interrupted", stopReason: "aborted" };
  }
  return { state: "failed", stopReason: "error" };
}

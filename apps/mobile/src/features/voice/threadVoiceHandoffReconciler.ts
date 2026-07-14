import type { EnvironmentId } from "@t3tools/contracts";
import type { T3VoiceThreadVoiceHandoffEvent } from "@t3tools/mobile-voice-native";

export interface VoiceEnvironmentOriginCandidate {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
}

export type ThreadVoiceHandoffDecision =
  | { readonly type: "none" }
  | { readonly type: "hold" }
  | {
      readonly type: "accept";
      readonly environmentId: EnvironmentId;
      readonly handoff: T3VoiceThreadVoiceHandoffEvent;
    }
  | { readonly type: "settle-failed"; readonly actionId: string };

export function resolveVoiceEnvironmentIdByOrigin(
  candidates: ReadonlyArray<VoiceEnvironmentOriginCandidate>,
  environmentOrigin: string,
): EnvironmentId | null {
  const exact = candidates.filter((candidate) => candidate.httpBaseUrl === environmentOrigin);
  if (exact.length === 1) return exact[0]!.environmentId;

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(environmentOrigin).origin;
  } catch {
    return null;
  }
  const normalized = candidates.filter((candidate) => {
    try {
      return new URL(candidate.httpBaseUrl).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
  return normalized.length === 1 ? normalized[0]!.environmentId : null;
}

export function reconcileThreadVoiceHandoff(input: {
  readonly pending: T3VoiceThreadVoiceHandoffEvent | null;
  readonly candidates: ReadonlyArray<VoiceEnvironmentOriginCandidate>;
  readonly catalogReady: boolean;
  readonly settledActionId: string | null;
  readonly currentActionId: string | null;
}): ThreadVoiceHandoffDecision {
  const pending = input.pending;
  if (
    pending === null ||
    pending.actionId === input.settledActionId ||
    pending.actionId === input.currentActionId
  ) {
    return { type: "none" };
  }
  const environmentId = resolveVoiceEnvironmentIdByOrigin(
    input.candidates,
    pending.environmentOrigin,
  );
  if (environmentId !== null) return { type: "accept", environmentId, handoff: pending };
  return input.catalogReady
    ? { type: "settle-failed", actionId: pending.actionId }
    : { type: "hold" };
}

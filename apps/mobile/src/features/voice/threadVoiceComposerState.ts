import type { VoiceRuntimeSnapshot, VoiceThreadReviewToken } from "@t3tools/client-runtime/voice";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ThreadVoiceComposerTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface ThreadVoiceControlState {
  readonly active: boolean;
  readonly blockedByAnotherTarget: boolean;
}

export interface ThreadReviewHydrationState extends ThreadVoiceComposerTarget {
  readonly generation: number;
  readonly reviewId: number;
  readonly ownsDraft: boolean;
  readonly nativeTranscript: string;
}

export interface ThreadReviewHydrationInput {
  readonly snapshot: VoiceRuntimeSnapshot;
  readonly target: ThreadVoiceComposerTarget;
  readonly currentDraft: string;
  readonly hasAttachments: boolean;
}

export type ThreadReviewIdentity = VoiceThreadReviewToken;

export type ThreadTranscriptSubmissionDisposition = "submit-native" | "native-owned" | "ordinary";

export interface ThreadVoiceComposerCapabilities {
  readonly nativeReviewOwnsComposer: boolean;
  readonly richPayload: boolean;
  readonly configuration: boolean;
}

export function nativeThreadReviewIdentityForDraft(
  hydrated: ThreadReviewHydrationState | null,
): ThreadReviewIdentity | null {
  return hydrated?.ownsDraft === true
    ? { generation: hydrated.generation, reviewId: hydrated.reviewId }
    : null;
}

export function threadVoiceComposerCapabilities(
  snapshot: VoiceRuntimeSnapshot,
  target: ThreadVoiceComposerTarget,
  review: ThreadReviewIdentity | null,
): ThreadVoiceComposerCapabilities {
  const nativeReviewOwnsComposer =
    isThreadReviewForTarget(snapshot, target) &&
    review?.generation === snapshot.generation &&
    review.reviewId === snapshot.reviewId;
  return {
    nativeReviewOwnsComposer,
    richPayload: !nativeReviewOwnsComposer,
    configuration: !nativeReviewOwnsComposer,
  };
}

type VoiceThreadReviewSnapshot = Extract<VoiceRuntimeSnapshot, { readonly mode: "thread" }> & {
  readonly phase: "reviewing";
  readonly transcript: string;
  readonly reviewId: number;
};

const sameThreadTarget = (
  left: ThreadVoiceComposerTarget,
  right: ThreadVoiceComposerTarget,
): boolean => left.environmentId === right.environmentId && left.threadId === right.threadId;

const targetsThread = (
  snapshot: VoiceRuntimeSnapshot,
  target: ThreadVoiceComposerTarget,
): boolean =>
  (snapshot.mode === "thread" || snapshot.mode === "switching-to-thread") &&
  sameThreadTarget(snapshot.target, target);

export function threadVoiceControlState(
  snapshot: VoiceRuntimeSnapshot,
  target: ThreadVoiceComposerTarget,
): ThreadVoiceControlState {
  if (snapshot.mode === "realtime") {
    return {
      active: false,
      blockedByAnotherTarget: snapshot.target.environmentId !== target.environmentId,
    };
  }
  if (snapshot.mode !== "thread" && snapshot.mode !== "switching-to-thread") {
    return { active: false, blockedByAnotherTarget: false };
  }
  const active = targetsThread(snapshot, target);
  return { active, blockedByAnotherTarget: !active };
}

export function isThreadReviewForTarget(
  snapshot: VoiceRuntimeSnapshot,
  target: ThreadVoiceComposerTarget,
): snapshot is VoiceThreadReviewSnapshot {
  return (
    snapshot.mode === "thread" &&
    snapshot.phase === "reviewing" &&
    snapshot.transcript !== null &&
    snapshot.reviewId !== null &&
    targetsThread(snapshot, target)
  );
}

export function threadTranscriptSubmissionDisposition(
  snapshot: VoiceRuntimeSnapshot,
  target: ThreadVoiceComposerTarget,
  review: ThreadReviewIdentity | null,
): ThreadTranscriptSubmissionDisposition {
  if (!targetsThread(snapshot, target)) return "ordinary";
  if (
    isThreadReviewForTarget(snapshot, target) &&
    review?.generation === snapshot.generation &&
    review.reviewId === snapshot.reviewId
  ) {
    return "submit-native";
  }
  return "native-owned";
}

export function reconcileThreadReviewHydration(
  input: ThreadReviewHydrationInput & {
    readonly hydrated: ThreadReviewHydrationState | null;
  },
): {
  readonly hydrated: ThreadReviewHydrationState | null;
  readonly draftUpdate: string | null;
} {
  if (!isThreadReviewForTarget(input.snapshot, input.target)) {
    const tracksCurrentTarget =
      input.hydrated !== null && sameThreadTarget(input.hydrated, input.target);
    if (
      tracksCurrentTarget &&
      input.snapshot.mode === "thread" &&
      input.snapshot.phase === "submitting" &&
      targetsThread(input.snapshot, input.target)
    ) {
      return { hydrated: input.hydrated, draftUpdate: null };
    }
    if (
      tracksCurrentTarget &&
      input.snapshot.mode === "thread" &&
      targetsThread(input.snapshot, input.target) &&
      (input.snapshot.phase === "waiting" ||
        input.snapshot.phase === "playing" ||
        input.snapshot.phase === "rearming")
    ) {
      return {
        hydrated: null,
        draftUpdate: input.hydrated.ownsDraft && input.currentDraft.length > 0 ? "" : null,
      };
    }
    // Stop, failure, target replacement, or Idle relinquishes native ownership
    // without deleting the text. Only post-submission phases above prove the
    // reviewed turn was accepted.
    return { hydrated: null, draftUpdate: null };
  }

  const existingHydration = input.hydrated;
  const sameReview =
    existingHydration !== null &&
    existingHydration.generation === input.snapshot.generation &&
    existingHydration.reviewId === input.snapshot.reviewId &&
    sameThreadTarget(existingHydration, input.target);
  if (sameReview) {
    if (
      existingHydration.ownsDraft ||
      input.hasAttachments ||
      (input.currentDraft.trim().length > 0 &&
        input.currentDraft !== existingHydration.nativeTranscript)
    ) {
      return { hydrated: existingHydration, draftUpdate: null };
    }
    const claimed = { ...existingHydration, ownsDraft: true };
    return {
      hydrated: claimed,
      draftUpdate:
        input.currentDraft === existingHydration.nativeTranscript
          ? null
          : existingHydration.nativeTranscript,
    };
  }

  const transcript = input.snapshot.transcript;
  const continuesOwnedAutoRearm =
    existingHydration !== null &&
    existingHydration.ownsDraft &&
    existingHydration.generation === input.snapshot.generation &&
    existingHydration.reviewId !== input.snapshot.reviewId &&
    sameThreadTarget(existingHydration, input.target) &&
    !input.hasAttachments;
  const ownsDraft =
    continuesOwnedAutoRearm ||
    (input.currentDraft.trim().length === 0 && !input.hasAttachments) ||
    input.currentDraft === transcript;
  const hydrated: ThreadReviewHydrationState = {
    ...input.target,
    generation: input.snapshot.generation,
    reviewId: input.snapshot.reviewId,
    ownsDraft,
    nativeTranscript: transcript,
  };

  // Missing the submitting/waiting snapshots while detached must not leave an
  // accepted prior-cycle draft in the next auto-rearmed review. A new
  // generation has no such continuity and preserves unrelated draft text.
  return {
    hydrated,
    draftUpdate: ownsDraft && input.currentDraft !== transcript ? transcript : null,
  };
}

/** Retains native review-draft ownership across React composer remounts. */
export class ThreadReviewHydrationTracker {
  private state: ThreadReviewHydrationState | null = null;

  reconcile(input: ThreadReviewHydrationInput): ReturnType<typeof reconcileThreadReviewHydration> {
    const tracksInput = this.state !== null && sameThreadTarget(this.state, input.target);
    const result = reconcileThreadReviewHydration({
      ...input,
      hydrated: tracksInput ? this.state : null,
    });
    if (result.hydrated !== null) this.state = result.hydrated;
    else if (tracksInput) this.state = null;
    return result;
  }
}

export const threadReviewHydrationTracker = new ThreadReviewHydrationTracker();

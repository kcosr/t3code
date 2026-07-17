import type { VoiceRuntimeSnapshot } from "./runtime.ts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isThreadReviewForTarget,
  nativeThreadReviewIdentityForDraft,
  reconcileThreadReviewHydration,
  ThreadReviewHydrationTracker,
  threadTranscriptSubmissionDisposition,
  threadVoiceComposerCapabilities,
  threadVoiceControlState,
} from "./threadComposer.ts";

const environmentId = EnvironmentId.make("environment-one");
const target = {
  environmentId,
  threadId: ThreadId.make("thread-one"),
};
const otherTarget = {
  environmentId,
  threadId: ThreadId.make("thread-two"),
};

type ThreadSnapshot = Extract<VoiceRuntimeSnapshot, { readonly mode: "thread" }>;

const reviewingSnapshot = (transcript = "Native transcript"): ThreadSnapshot => ({
  mode: "thread",
  phase: "reviewing",
  generation: 3,
  sequence: 12,
  target: {
    environmentId,
    projectId: ProjectId.make("project-one"),
    threadId: target.threadId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  settings: {
    submission: "review",
    playResponses: false,
    autoRearm: true,
    endpointDetection: {
      endSilenceMs: 1_000,
      noSpeechTimeoutMs: 10_000,
      maximumUtteranceMs: 30_000,
    },
    rearmDelayMs: 500,
    transcriptionTimeoutMs: 30_000,
    submissionTimeoutMs: 30_000,
    responseTimeoutMs: 120_000,
  },
  transcript,
  reviewId: 7,
  attention: null,
});

type ReconcileInput = Parameters<typeof reconcileThreadReviewHydration>[0];
const reconcileReview = (
  input: Omit<ReconcileInput, "hasAttachments" | "draftsReady"> & {
    readonly hasAttachments?: boolean;
    readonly draftsReady?: boolean;
  },
) =>
  reconcileThreadReviewHydration({
    ...input,
    hasAttachments: input.hasAttachments ?? false,
    draftsReady: input.draftsReady ?? true,
  });

describe("Thread voice composer state", () => {
  it("blocks another Thread while preserving controls for the native owner", () => {
    const snapshot = reviewingSnapshot();
    expect(threadVoiceControlState(snapshot, target)).toEqual({
      active: true,
      blockedByAnotherTarget: false,
      command: "stop",
      accessibilityLabel: "Stop Thread voice",
    });
    expect(threadVoiceControlState(snapshot, otherTarget)).toEqual({
      active: false,
      blockedByAnotherTarget: true,
      command: "start",
      accessibilityLabel: "Start Auto Listen",
    });

    expect(
      threadVoiceControlState(
        { ...snapshot, phase: "recording", transcript: null, reviewId: null },
        target,
      ),
    ).toEqual({
      active: true,
      blockedByAnotherTarget: false,
      command: "finish-recording",
      accessibilityLabel: "Finish Thread voice recording",
    });
  });

  it("allows a Realtime switch only inside the active native environment", () => {
    const realtime: VoiceRuntimeSnapshot = {
      mode: "realtime",
      phase: "connected",
      generation: 2,
      sequence: 7,
      target: {
        environmentId,
        conversation: { type: "new", retention: "durable", title: "Voice" },
        focus: null,
        threadSwitch: null,
      },
      muted: false,
      audioRoutes: [],
      transcript: [],
      pendingConfirmations: [],
      pendingClientActions: [],
    };
    expect(threadVoiceControlState(realtime, target)).toEqual({
      active: false,
      blockedByAnotherTarget: false,
      command: "start",
      accessibilityLabel: "Start Auto Listen",
    });
    expect(
      threadVoiceControlState(realtime, {
        ...target,
        environmentId: EnvironmentId.make("environment-two"),
      }).blockedByAnotherTarget,
    ).toBe(true);
  });

  it("stops an admitted switch and offers a fresh start after failure", () => {
    const thread = reviewingSnapshot();
    const switching: VoiceRuntimeSnapshot = {
      mode: "switching-to-thread",
      phase: "closing-realtime",
      generation: thread.generation,
      sequence: thread.sequence,
      target: thread.target,
      settings: thread.settings,
    };
    expect(threadVoiceControlState(switching, target)).toMatchObject({
      active: true,
      command: "stop",
      accessibilityLabel: "Stop Thread voice",
    });

    const switchingToRealtime: VoiceRuntimeSnapshot = {
      mode: "switching-to-realtime",
      generation: thread.generation,
      sequence: thread.sequence + 1,
      source: thread.target,
      target: {
        environmentId,
        conversation: { type: "new", retention: "durable", title: "Voice" },
        focus: { projectId: thread.target.projectId, threadId: thread.target.threadId },
        threadSwitch: null,
      },
    };
    expect(threadVoiceControlState(switchingToRealtime, target)).toMatchObject({
      active: true,
      command: "stop",
      accessibilityLabel: "Stop Thread voice",
    });
    expect(threadVoiceControlState(switchingToRealtime, otherTarget)).toMatchObject({
      active: false,
      blockedByAnotherTarget: true,
    });

    const failed: VoiceRuntimeSnapshot = {
      mode: "failed",
      generation: thread.generation,
      sequence: thread.sequence + 1,
      environmentId,
      operation: "thread",
      failure: { code: "test", message: "failed", retryable: true },
    };
    expect(threadVoiceControlState(failed, target)).toEqual({
      active: false,
      blockedByAnotherTarget: false,
      command: "start",
      accessibilityLabel: "Start Auto Listen",
    });
  });

  it("correlates native review submission to the exact environment and Thread", () => {
    const snapshot = reviewingSnapshot();
    expect(isThreadReviewForTarget(snapshot, target)).toBe(true);
    expect(isThreadReviewForTarget(snapshot, otherTarget)).toBe(false);
    expect(
      isThreadReviewForTarget(snapshot, {
        ...target,
        environmentId: EnvironmentId.make("environment-two"),
      }),
    ).toBe(false);
  });

  it("hydrates a review once and never overwrites a subsequent user edit", () => {
    const snapshot = reviewingSnapshot();
    const initial = reconcileReview({
      snapshot,
      target,
      currentDraft: "",
      hydrated: null,
    });
    expect(initial.draftUpdate).toBe("Native transcript");

    expect(
      reconcileReview({
        snapshot,
        target,
        currentDraft: "Edited transcript",
        hydrated: initial.hydrated,
      }),
    ).toEqual({ hydrated: initial.hydrated, draftUpdate: null });
  });

  it("waits for persisted composer drafts before claiming or changing the review draft", () => {
    const pending = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "",
      hydrated: null,
      draftsReady: false,
    });
    expect(pending).toEqual({ hydrated: null, draftUpdate: null });

    const ready = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "Persisted draft",
      hydrated: pending.hydrated,
    });
    expect(ready.hydrated?.ownsDraft).toBe(false);
    expect(ready.draftUpdate).toBeNull();
  });

  it("does not overwrite a newer local edit when native echoes the same review", () => {
    const initial = reconcileReview({
      snapshot: reviewingSnapshot("Original transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const echoed = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Older native echo"),
        sequence: 13,
      },
      target,
      currentDraft: "Newer local edit",
      hydrated: initial.hydrated,
    });

    expect(echoed).toEqual({ hydrated: initial.hydrated, draftUpdate: null });
  });

  it("does not carry stale ownership into a later review on the same Thread", () => {
    const oldReview = reconcileReview({
      snapshot: reviewingSnapshot("Old native transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const nextReview = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("New native transcript"),
        generation: 4,
        sequence: 20,
        reviewId: 8,
      },
      target,
      currentDraft: "Unrelated current draft",
      hydrated: oldReview.hydrated,
    });

    expect(nextReview.hydrated?.ownsDraft).toBe(false);
    expect(nextReview.draftUpdate).toBeNull();
  });

  it("replaces an owned prior-cycle draft when detached React misses auto-rearm phases", () => {
    const oldReview = reconcileReview({
      snapshot: reviewingSnapshot("Old native transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const submitting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Edited and submitted old transcript"),
        phase: "submitting",
        sequence: 13,
      },
      target,
      currentDraft: "Edited and submitted old transcript",
      hydrated: oldReview.hydrated,
    });
    const nextReview = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("New native transcript"),
        sequence: 20,
        reviewId: 8,
      },
      target,
      currentDraft: "Edited and submitted old transcript",
      hydrated: submitting.hydrated,
    });

    expect(nextReview.hydrated?.ownsDraft).toBe(true);
    expect(nextReview.draftUpdate).toBe("New native transcript");
  });

  it("preserves a next-message draft when auto-rearm skips directly to the next review", () => {
    const oldReview = reconcileReview({
      snapshot: reviewingSnapshot("Old native transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const submitting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Submitted transcript"),
        phase: "submitting",
        sequence: 13,
      },
      target,
      currentDraft: "Submitted transcript",
      hydrated: oldReview.hydrated,
    });
    const nextReview = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("New native transcript"),
        sequence: 20,
        reviewId: 8,
      },
      target,
      currentDraft: "Next message",
      hydrated: submitting.hydrated,
    });

    expect(nextReview.hydrated?.ownsDraft).toBe(false);
    expect(nextReview.draftUpdate).toBeNull();
  });

  it("fences a prior auto-rearm review even when the operation generation is unchanged", () => {
    const oldReview = { generation: 3, reviewId: 7 };
    const nextCycle = { ...reviewingSnapshot("Next cycle"), sequence: 30, reviewId: 8 };

    expect(threadTranscriptSubmissionDisposition(nextCycle, target, oldReview)).toBe(
      "native-owned",
    );
    expect(
      threadTranscriptSubmissionDisposition(nextCycle, target, {
        generation: 3,
        reviewId: 8,
      }),
    ).toBe("submit-native");
  });

  it("does not confuse a preexisting composer draft with the native review", () => {
    const conflicted = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "Unrelated existing draft",
      hydrated: null,
    });
    expect(conflicted.hydrated?.ownsDraft).toBe(false);
    expect(conflicted.draftUpdate).toBeNull();
    expect(nativeThreadReviewIdentityForDraft(conflicted.hydrated)).toBeNull();

    const cleared = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "",
      hydrated: conflicted.hydrated,
    });
    expect(cleared.hydrated?.ownsDraft).toBe(true);
    expect(cleared.draftUpdate).toBe("Native transcript");

    const exactTranscript = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "Native transcript",
      hydrated: conflicted.hydrated,
    });
    expect(exactTranscript.hydrated?.ownsDraft).toBe(true);
    expect(exactTranscript.draftUpdate).toBeNull();
  });

  it("preserves a submitted review until waiting confirms dispatch, then hydrates the next cycle", () => {
    const first = reconcileReview({
      snapshot: reviewingSnapshot("First transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const submitting: VoiceRuntimeSnapshot = {
      ...reviewingSnapshot("Edited first transcript"),
      phase: "submitting",
      sequence: 13,
    };
    const betweenCycles = reconcileReview({
      snapshot: submitting,
      target,
      currentDraft: "Edited first transcript",
      hydrated: first.hydrated,
    });
    expect(betweenCycles.hydrated?.submittedTranscript).toBe("Edited first transcript");
    expect(betweenCycles.draftUpdate).toBeNull();

    const waiting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Edited first transcript"),
        phase: "waiting",
        sequence: 14,
      },
      target,
      currentDraft: "Edited first transcript",
      hydrated: betweenCycles.hydrated,
    });
    expect(waiting.hydrated).toBeNull();
    expect(waiting.draftUpdate).toBe("");

    const second = reconcileReview({
      snapshot: { ...reviewingSnapshot("Second transcript"), sequence: 20 },
      target,
      currentDraft: "",
      hydrated: waiting.hydrated,
    });
    expect(second.draftUpdate).toBe("Second transcript");
  });

  it("uses a waiting snapshot to clear the exact submitted edit when submitting was missed", () => {
    const review = reconcileReview({
      snapshot: reviewingSnapshot("Original transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const waiting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Edited and submitted transcript"),
        phase: "waiting",
        sequence: 14,
      },
      target,
      currentDraft: "Edited and submitted transcript",
      hydrated: review.hydrated,
    });

    expect(waiting).toEqual({ hydrated: null, draftUpdate: "" });
  });

  it("does not clear a next-message draft after the submitted review advances", () => {
    const review = reconcileReview({
      snapshot: reviewingSnapshot("Original transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const submitting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Submitted transcript"),
        phase: "submitting",
        sequence: 13,
      },
      target,
      currentDraft: "Submitted transcript",
      hydrated: review.hydrated,
    });
    const waiting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Submitted transcript"),
        phase: "waiting",
        sequence: 14,
      },
      target,
      currentDraft: "Next message",
      hydrated: submitting.hydrated,
    });

    expect(waiting).toEqual({ hydrated: null, draftUpdate: null });
  });

  it("does not clear submitted text after an attachment is added for the next message", () => {
    const review = reconcileReview({
      snapshot: reviewingSnapshot("Original transcript"),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const submitting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Submitted transcript"),
        phase: "submitting",
        sequence: 13,
      },
      target,
      currentDraft: "Submitted transcript",
      hydrated: review.hydrated,
    });
    const waiting = reconcileReview({
      snapshot: {
        ...reviewingSnapshot("Submitted transcript"),
        phase: "waiting",
        sequence: 14,
      },
      target,
      currentDraft: "Submitted transcript",
      hasAttachments: true,
      hydrated: submitting.hydrated,
    });

    expect(waiting).toEqual({ hydrated: null, draftUpdate: null });
  });

  it("retains review-draft ownership across a composer remount until submission succeeds", () => {
    const tracker = new ThreadReviewHydrationTracker();
    const initial = tracker.reconcile({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "",
      hasAttachments: false,
      draftsReady: true,
    });
    expect(initial.draftUpdate).toBe("Native transcript");

    const submitting = tracker.reconcile({
      snapshot: {
        ...reviewingSnapshot("Edited before remount"),
        phase: "submitting",
        sequence: 13,
      },
      target,
      currentDraft: "Edited before remount",
      hasAttachments: false,
      draftsReady: true,
    });
    expect(submitting.draftUpdate).toBeNull();
    const afterNotificationSubmit = tracker.reconcile({
      snapshot: {
        ...reviewingSnapshot("Edited before remount"),
        phase: "waiting",
        sequence: 14,
      },
      target,
      currentDraft: "Edited before remount",
      hasAttachments: false,
      draftsReady: true,
    });
    expect(afterNotificationSubmit.draftUpdate).toBe("");
  });

  it("evicts the previous target when tracking the sole native review operation", () => {
    const tracker = new ThreadReviewHydrationTracker();
    tracker.reconcile({
      snapshot: reviewingSnapshot("First target transcript"),
      target,
      currentDraft: "",
      hasAttachments: false,
      draftsReady: true,
    });
    tracker.reconcile({
      snapshot: {
        ...reviewingSnapshot("Second target transcript"),
        target: { ...reviewingSnapshot().target, threadId: otherTarget.threadId },
        reviewId: 8,
        sequence: 20,
      },
      target: otherTarget,
      currentDraft: "",
      hasAttachments: false,
      draftsReady: true,
    });

    const staleFirstTarget = tracker.reconcile({
      snapshot: reviewingSnapshot("First target transcript"),
      target,
      currentDraft: "Unrelated current draft",
      hasAttachments: false,
      draftsReady: true,
    });
    expect(staleFirstTarget.hydrated?.ownsDraft).toBe(false);
    expect(staleFirstTarget.draftUpdate).toBeNull();
  });

  it("preserves the reviewed draft through failure dismissal as an ordinary draft", () => {
    const first = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const submitting = reconcileReview({
      snapshot: { ...reviewingSnapshot(), phase: "submitting", sequence: 13 },
      target,
      currentDraft: "Edited transcript",
      hydrated: first.hydrated,
    });
    const failed = reconcileReview({
      snapshot: {
        mode: "failed",
        environmentId,
        operation: "thread",
        failure: { code: "dispatch-failed", message: "Dispatch failed", retryable: true },
        generation: 3,
        sequence: 14,
      },
      target,
      currentDraft: "Edited transcript",
      hydrated: submitting.hydrated,
    });

    expect(failed.hydrated).toBeNull();
    expect(failed.draftUpdate).toBeNull();

    const dismissed = reconcileReview({
      snapshot: { mode: "idle", generation: 3, sequence: 15 },
      target,
      currentDraft: "Edited transcript",
      hydrated: failed.hydrated,
    });
    expect(dismissed).toEqual({ hydrated: null, draftUpdate: null });
  });

  it("preserves an edited review as an ordinary draft when native voice stops", () => {
    const review = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "",
      hydrated: null,
    });
    const stopping = reconcileReview({
      snapshot: { ...reviewingSnapshot(), phase: "stopping", sequence: 13 },
      target,
      currentDraft: "Edited transcript",
      hydrated: review.hydrated,
    });
    expect(stopping).toEqual({ hydrated: null, draftUpdate: null });
    expect(
      reconcileReview({
        snapshot: { mode: "idle", generation: 3, sequence: 14 },
        target,
        currentDraft: "Edited transcript",
        hydrated: stopping.hydrated,
      }),
    ).toEqual({ hydrated: null, draftUpdate: null });
  });

  it("never admits attachments into a text-only native review submission", () => {
    const hydrated = reconcileReview({
      snapshot: reviewingSnapshot(),
      target,
      currentDraft: "",
      hydrated: null,
      hasAttachments: true,
    });

    expect(hydrated.hydrated?.ownsDraft).toBe(false);
    expect(nativeThreadReviewIdentityForDraft(hydrated.hydrated)).toBeNull();
    expect(threadTranscriptSubmissionDisposition(reviewingSnapshot(), target, null)).toBe(
      "native-owned",
    );
  });

  it("keeps native Thread configuration immutable while allowing next-message payloads", () => {
    const reviewing = reviewingSnapshot();
    expect(
      threadVoiceComposerCapabilities(reviewing, target, {
        generation: 3,
        reviewId: 7,
      }),
    ).toEqual({
      nativeReviewOwnsComposer: true,
      richPayload: false,
      configuration: false,
    });
    expect(threadVoiceComposerCapabilities(reviewing, target, null)).toEqual({
      nativeReviewOwnsComposer: false,
      richPayload: true,
      configuration: false,
    });
    expect(
      threadVoiceComposerCapabilities(
        { ...reviewing, phase: "waiting", sequence: 13 },
        target,
        null,
      ),
    ).toEqual({
      nativeReviewOwnsComposer: false,
      richPayload: true,
      configuration: false,
    });
    expect(
      threadVoiceComposerCapabilities(
        {
          mode: "switching-to-thread",
          phase: "closing-realtime",
          generation: reviewing.generation,
          sequence: 11,
          target: reviewing.target,
          settings: reviewing.settings,
        },
        target,
        null,
      ).configuration,
    ).toBe(false);
    expect(threadVoiceComposerCapabilities(reviewing, otherTarget, null).configuration).toBe(true);
  });

  it("never falls back to ordinary send while the native Thread owns the cycle", () => {
    const review = { generation: 3, reviewId: 7 };
    expect(threadTranscriptSubmissionDisposition(reviewingSnapshot(), target, review)).toBe(
      "submit-native",
    );
    expect(
      threadTranscriptSubmissionDisposition(
        { ...reviewingSnapshot(), phase: "submitting", sequence: 13 },
        target,
        review,
      ),
    ).toBe("native-owned");
    expect(
      threadTranscriptSubmissionDisposition(
        { ...reviewingSnapshot(), phase: "waiting", sequence: 14 },
        target,
        review,
      ),
    ).toBe("native-owned");
    expect(threadTranscriptSubmissionDisposition(reviewingSnapshot(), otherTarget, review)).toBe(
      "ordinary",
    );
  });
});

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceDraftArtifactId,
  VoiceModeSessionId,
  VoiceRuntimeId,
  VoiceRuntimeInstanceId,
  VoiceTurnClientOperationId,
  type VoiceDraftArtifact,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  applyVoiceArtifactToState,
  decodePersistedComposerDraftsState,
  encodePersistedComposerDraftsState,
  type ComposerDraftsPersistenceState,
} from "../../state/use-composer-drafts";
import { consumeAndroidVoiceDraftArtifact } from "./androidVoiceDraftArtifactController";

const now = Date.parse("2026-07-14T12:00:00.000Z");
const draftKey = "environment-1:thread-1";

function artifact(): VoiceDraftArtifact {
  return {
    handle: {
      artifactId: VoiceDraftArtifactId.make("artifact-1"),
      runtimeId: VoiceRuntimeId.make("runtime-1"),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-instance-1"),
      runtimeGeneration: 1,
      modeSessionId: VoiceModeSessionId.make("mode-session-1"),
      turnClientOperationId: VoiceTurnClientOperationId.make("turn-operation-1"),
      target: {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
      },
      composerRevision: "composer-revision-1",
      expiresAt: "2026-07-15T12:00:00.000Z",
    },
    transcript: "voice text",
  };
}

describe("consumeAndroidVoiceDraftArtifact", () => {
  it("does not append twice when acknowledgement fails and the artifact is re-offered", async () => {
    let persisted: ComposerDraftsPersistenceState = {
      drafts: { [draftKey]: { text: "existing", attachments: [] } },
      appliedVoiceArtifacts: {},
    };
    const apply = vi.fn(async (input) => {
      const applied = applyVoiceArtifactToState(persisted, input);
      persisted = decodePersistedComposerDraftsState(
        encodePersistedComposerDraftsState(applied.state, now),
        now,
      );
      return applied.result;
    });
    const acknowledge = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const input = {
      artifact: artifact(),
      draftKey,
      now,
      dependencies: { apply, acknowledge },
    };

    await expect(consumeAndroidVoiceDraftArtifact(input)).rejects.toThrow(
      "released before acknowledgement",
    );
    await expect(
      consumeAndroidVoiceDraftArtifact({ ...input, now: now + 1 }),
    ).resolves.toMatchObject({ outcome: "already-applied" });

    expect(persisted.drafts[draftKey]?.text).toBe("existing voice text");
    expect(apply).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it("retries once after a persistence failure and a process reload loses the uncommitted append", async () => {
    const initial: ComposerDraftsPersistenceState = {
      drafts: { [draftKey]: { text: "existing", attachments: [] } },
      appliedVoiceArtifacts: {},
    };
    let durableDocument = encodePersistedComposerDraftsState(initial, now);
    let processState = decodePersistedComposerDraftsState(durableDocument, now);
    let failNextWrite = true;
    const apply = vi.fn(async (input) => {
      const applied = applyVoiceArtifactToState(processState, input);
      processState = applied.state;
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("disk full");
      }
      durableDocument = encodePersistedComposerDraftsState(processState, now);
      return applied.result;
    });
    const acknowledge = vi.fn(() => true);
    const input = {
      artifact: artifact(),
      draftKey,
      now,
      dependencies: { apply, acknowledge },
    };

    await expect(consumeAndroidVoiceDraftArtifact(input)).rejects.toThrow("disk full");
    expect(processState.drafts[draftKey]?.text).toBe("existing voice text");
    expect(acknowledge).not.toHaveBeenCalled();

    processState = decodePersistedComposerDraftsState(durableDocument, now + 1);
    expect(processState.drafts[draftKey]?.text).toBe("existing");
    await expect(
      consumeAndroidVoiceDraftArtifact({ ...input, now: now + 1 }),
    ).resolves.toMatchObject({ outcome: "appended" });

    const reloaded = decodePersistedComposerDraftsState(durableDocument, now + 2);
    expect(reloaded.drafts[draftKey]?.text).toBe("existing voice text");
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});

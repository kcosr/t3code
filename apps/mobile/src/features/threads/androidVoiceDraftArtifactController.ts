import type { VoiceDraftArtifact } from "@t3tools/contracts";

import type {
  ApplyVoiceArtifactInput,
  ApplyVoiceArtifactResult,
} from "../../state/use-composer-drafts";

export interface AndroidVoiceDraftArtifactControllerDependencies {
  readonly apply: (input: ApplyVoiceArtifactInput) => Promise<ApplyVoiceArtifactResult>;
  readonly acknowledge: (
    artifactId: VoiceDraftArtifact["handle"]["artifactId"],
    outcome: "appended",
  ) => boolean;
}

export async function consumeAndroidVoiceDraftArtifact(input: {
  readonly artifact: VoiceDraftArtifact;
  readonly draftKey: string;
  readonly now: number;
  readonly dependencies: AndroidVoiceDraftArtifactControllerDependencies;
}): Promise<ApplyVoiceArtifactResult> {
  const result = await input.dependencies.apply({
    draftKey: input.draftKey,
    artifactId: input.artifact.handle.artifactId,
    transcript: input.artifact.transcript,
    appliedAtEpochMillis: input.now,
    expiresAtEpochMillis: Date.parse(input.artifact.handle.expiresAt),
  });
  if (!input.dependencies.acknowledge(input.artifact.handle.artifactId, "appended")) {
    throw new Error("The voice draft artifact was released before acknowledgement.");
  }
  return result;
}

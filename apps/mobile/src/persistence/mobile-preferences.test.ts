import { describe, expect, it } from "vite-plus/test";

import { sanitizeVoiceBackgroundThreadTarget } from "./voiceBackgroundPreferences";

const valid = {
  environmentId: "environment-a",
  projectId: "project-a",
  threadId: "thread-a",
  title: "Active Thread",
};

describe("sanitizeVoiceBackgroundThreadTarget", () => {
  it("reconstructs the exact canonical target", () => {
    expect(sanitizeVoiceBackgroundThreadTarget(valid)).toEqual(valid);
    expect(sanitizeVoiceBackgroundThreadTarget(valid)).not.toBe(valid);
  });

  it("rejects whitespace, missing fields, arrays, and alias or extra keys", () => {
    expect(sanitizeVoiceBackgroundThreadTarget({ ...valid, threadId: " thread-a" })).toBeNull();
    expect(sanitizeVoiceBackgroundThreadTarget({ ...valid, title: "" })).toBeNull();
    expect(
      sanitizeVoiceBackgroundThreadTarget({
        environmentId: valid.environmentId,
        projectId: valid.projectId,
        id: valid.threadId,
        title: valid.title,
      }),
    ).toBeNull();
    expect(sanitizeVoiceBackgroundThreadTarget({ ...valid, threadID: valid.threadId })).toBeNull();
    expect(sanitizeVoiceBackgroundThreadTarget([valid])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { shouldShowAutoListenPauseAlert } from "./autoListenPausePresentation";

describe("shouldShowAutoListenPauseAlert", () => {
  it("keeps expected playback cancellation silent", () => {
    expect(shouldShowAutoListenPauseAlert("playback-cancelled")).toBe(false);
  });

  it("still reports playback failures", () => {
    expect(shouldShowAutoListenPauseAlert("playback-failed")).toBe(true);
  });
});

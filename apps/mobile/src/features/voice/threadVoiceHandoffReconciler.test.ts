import { EnvironmentId } from "@t3tools/contracts";
import type { T3VoiceThreadVoiceHandoffEvent } from "@t3tools/mobile-voice-native";
import { describe, expect, it } from "vitest";
import {
  reconcileThreadVoiceHandoff,
  resolveVoiceEnvironmentIdByOrigin,
} from "./threadVoiceHandoffReconciler";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const pending = (overrides: Partial<T3VoiceThreadVoiceHandoffEvent> = {}) => ({
  actionId: "action-1",
  projectId: "project-1",
  threadId: "thread-1",
  recordingId: "recording-1",
  autoRearm: true,
  environmentOrigin: "https://environment.example.test/base-path",
  expiresAtEpochMillis: 2_000,
  ...overrides,
});

describe("thread voice handoff environment resolution", () => {
  it.each([
    "https://environment.example.test/",
    "https://environment.example.test/base-path",
    "https://ENVIRONMENT.example.test:443",
  ])("normalizes origin-shaped and path-bearing URLs: %s", (environmentOrigin) => {
    expect(
      resolveVoiceEnvironmentIdByOrigin(
        [{ environmentId: environmentB, httpBaseUrl: "https://environment.example.test/api" }],
        environmentOrigin,
      ),
    ).toBe(environmentB);
  });

  it("prefers an exact base URL when environments share an origin", () => {
    expect(
      resolveVoiceEnvironmentIdByOrigin(
        [
          { environmentId: environmentA, httpBaseUrl: "https://environment.example.test/a" },
          { environmentId: environmentB, httpBaseUrl: "https://environment.example.test/b" },
        ],
        "https://environment.example.test/b",
      ),
    ).toBe(environmentB);
  });

  it("rejects ambiguous and invalid origins", () => {
    const candidates = [
      { environmentId: environmentA, httpBaseUrl: "https://environment.example.test/a" },
      { environmentId: environmentB, httpBaseUrl: "https://environment.example.test/b" },
    ];
    expect(
      resolveVoiceEnvironmentIdByOrigin(candidates, "https://environment.example.test/c"),
    ).toBeNull();
    expect(resolveVoiceEnvironmentIdByOrigin(candidates, "not a URL")).toBeNull();
  });
});

describe("thread voice handoff reconciliation", () => {
  const candidates = [
    { environmentId: environmentB, httpBaseUrl: "https://environment.example.test/api" },
  ];

  it("accepts from the handoff origin without a controller identity", () => {
    expect(
      reconcileThreadVoiceHandoff({
        pending: pending(),
        candidates,
        catalogReady: true,
        settledActionId: null,
        currentActionId: null,
      }),
    ).toMatchObject({ type: "accept", environmentId: environmentB });
  });

  it("holds unresolved events while loading and fails them once the catalog is ready", () => {
    const input = {
      pending: pending({ environmentOrigin: "https://missing.example.test" }),
      candidates,
      settledActionId: null,
      currentActionId: null,
    };
    expect(reconcileThreadVoiceHandoff({ ...input, catalogReady: false })).toEqual({
      type: "hold",
    });
    expect(reconcileThreadVoiceHandoff({ ...input, catalogReady: true })).toEqual({
      type: "settle-failed",
      actionId: "action-1",
    });
  });

  it.each([
    { settledActionId: "action-1", currentActionId: null },
    { settledActionId: null, currentActionId: "action-1" },
  ])("ignores completed and current handoffs", (state) => {
    expect(
      reconcileThreadVoiceHandoff({
        pending: pending(),
        candidates,
        catalogReady: true,
        ...state,
      }),
    ).toEqual({ type: "none" });
  });

  it("trusts native to return an adopted handoff after its original deadline", () => {
    expect(
      reconcileThreadVoiceHandoff({
        pending: pending({ expiresAtEpochMillis: 1 }),
        candidates,
        catalogReady: true,
        settledActionId: null,
        currentActionId: null,
      }),
    ).toMatchObject({ type: "accept", environmentId: environmentB });
  });
});

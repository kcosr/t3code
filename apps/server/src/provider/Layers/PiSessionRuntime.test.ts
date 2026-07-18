import { describe, expect, it } from "vitest";

import { buildPiEnvironment, buildPiRpcArgv } from "./PiSessionRuntime.ts";

describe("PiSessionRuntime spawn helpers", () => {
  it("builds RPC argv for new sessions", () => {
    expect(
      buildPiRpcArgv({
        binaryPath: "pi",
        cwd: "/tmp",
        environment: {},
        sessionId: "thread-1",
        provider: "anthropic",
        model: "claude-sonnet-4",
        projectTrust: "deny",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-id",
      "thread-1",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4",
      "--no-approve",
    ]);
  });

  it("builds RPC argv for resume and utility probes", () => {
    expect(
      buildPiRpcArgv({
        binaryPath: "pi",
        cwd: "/tmp",
        environment: {},
        sessionPath: "/tmp/session.jsonl",
        sessionDir: "/tmp/sessions",
        noSession: true,
        noTools: true,
        projectTrust: "approve",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-tools",
      "--session",
      "/tmp/session.jsonl",
      "--session-dir",
      "/tmp/sessions",
      "--approve",
    ]);
  });

  it("exports agent/session dirs without rewriting HOME", () => {
    const env = buildPiEnvironment(
      { agentDir: "/custom/agent", sessionDir: "/custom/sessions" },
      { HOME: "/home/user", PATH: "/usr/bin", EXISTING: "1" },
    );
    expect(env.HOME).toBe("/home/user");
    expect(env.PI_CODING_AGENT_DIR).toBe("/custom/agent");
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe("/custom/sessions");
    expect(env.EXISTING).toBe("1");
    expect(env.PI_OFFLINE).toBe("1");
  });
});

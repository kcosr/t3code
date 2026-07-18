# Pi provider

T3 integrates **stock Pi** (`pi --mode rpc`) as the first-party `piAgent` driver.

## Requirements

- Install a compatible Pi CLI (`pi --version` in the **0.75.x–0.80.x** range).
- Authenticate models through Pi’s own agent directory / env (OAuth tokens under
  `PI_CODING_AGENT_DIR`, or API keys already in the process environment). T3 does
  not invent a second OpenAI/Anthropic credential UI for Pi.

## Configuration

Provider instance settings (`settings.providers.piAgent` or an explicit
`providerInstances` entry with `driver: "piAgent"`):

| Field          | Default   | Meaning                                                                    |
| -------------- | --------- | -------------------------------------------------------------------------- |
| `binaryPath`   | `pi`      | Executable or resolvable command                                           |
| `agentDir`     | _(empty)_ | Optional config dir → `PI_CODING_AGENT_DIR` (does **not** rewrite `HOME`)  |
| `sessionDir`   | _(empty)_ | Optional session storage → `--session-dir` + `PI_CODING_AGENT_SESSION_DIR` |
| `projectTrust` | `inherit` | `inherit` / `approve` / `deny` for project-local Pi resources only         |

`projectTrust` controls whether project-local extensions, prompts, skills, and
themes load in noninteractive mode. It is **not** bash/file-tool approval.

## Runtime mode

Pi only supports T3 **`full-access`**. `approval-required` and
`auto-accept-edits` are rejected before spawn. Pi has no Codex-equivalent
sandbox; treat the process as shell-equivalent authority.

## Models and thinking

- Catalog comes from a bounded RPC `get_available_models` probe.
- Slugs are `provider/modelId` (e.g. `anthropic/claude-sonnet-4-20250514`).
- Models that advertise reasoning get a `thinkingLevel` option. Allowed values
  are filtered from each model's `thinkingLevelMap` the same way stock Pi does
  (`null` disables a level; `xhigh` only when present).
- **In-session** model and thinking changes use RPC `set_model` /
  `set_thinking_level` on the existing process while the session is idle, then
  verify with `get_state`. Active turns reject model/thinking changes.

## Session lifecycle

- One `pi --mode rpc` process per active T3 thread (Codex-like ownership).
- New sessions use `--session-id` (deterministic when the T3 thread id is
  Pi-valid).
- Resume spawns a **new** process with `--session <path>` from the typed
  resume cursor `{ version: 1, sessionId, sessionPath, cwd }`.
- Stop closes stdin, SIGTERMs the process group (Unix detached spawn), then
  SIGKILLs if needed so tool children do not outlive the session.
- Do not open the same Pi session file in interactive Pi and T3 at the same
  time (no shared cross-process writer lease).

## Extension UI

Supported dialog methods: `select`, `confirm`, `input`, `editor`.  
`notify` / `setStatus` map to bounded warnings or plugin progress.  
TUI-only methods (`setWidget`, `setTitle`, `set_editor_text`, …) emit a one-shot
unsupported warning. Project-trust `approve` also warns once about the limited
UI bridge.

## `pi-threads`

Not a dependency. A future Pi-RPC-compatible proxy may be selected only via
`binaryPath` if it speaks stock Pi RPC JSONL.

## Reference

Design: agent-context `specs/pi-provider.md`  
Stock protocol: Pi repo `packages/coding-agent/docs/rpc.md`

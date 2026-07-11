# Pi Provider Integration

## Status

Design specification for a future first-party T3 provider. This document fixes the integration
boundary and lifecycle before implementation. It does not describe an installed feature yet.

## Decision Summary

T3 integrates directly with the stock Pi executable through Pi's native RPC mode:

```text
T3 ProviderService
  -> PiDriver
    -> PiAdapter
      -> one PiSessionRuntime per active T3 thread
        -> `pi --mode rpc`
```

The runtime follows the same ownership model as the Codex integration:

- one persistent provider process for each active T3 provider session;
- all turns for that active session reuse the same process and RPC connection;
- T3 closes the process when the session is stopped or reaped;
- Pi's JSONL session is durable, while the process is replaceable;
- resuming starts a new RPC process against the saved Pi session;
- different active T3 threads may run in parallel through separate processes.

T3 does not implement a Pi worker pool, Pi daemon, global Pi session catalog, or remote Pi
transport. `pi-threads` is a reference for protocol and lifecycle edge cases, not a dependency.

## Context

Pi is both an interactive coding agent and a programmatically embeddable agent. `pi --mode rpc`
uses the same agent engine, model configuration, tools, extensions, skills, compaction, and durable
session format as interactive Pi. RPC replaces the terminal UI with strict LF-delimited JSONL over
stdin and stdout.

This gives T3 the required provider-native boundary without requiring a fork, extension, personal
daemon, or CLI-output parser. A user may stop the T3-owned RPC process, resume the same session in
interactive Pi, stop interactive Pi, and later resume it through T3. The same Pi session must never
be opened by both interfaces concurrently because Pi does not provide a shared cross-process writer
lease.

Pi RPC is not wire-compatible with Codex app-server, ACP, or the current `pi-threads` daemon API.
The `PiAdapter` normalizes Pi commands and events into T3's existing provider contracts.

## Goals

- Add Pi as a first-party `ProviderDriverKind` using an installed stock Pi binary.
- Match the active-session process lifecycle already used by Codex.
- Preserve native Pi session history and allow safe process replacement and resume.
- Stream assistant text, reasoning, tools, retries, compaction, and failures into canonical T3
  runtime events.
- Support Pi extension dialog requests through T3's existing request and user-input surfaces.
- Respect T3 provider-instance configuration, model selection, session ownership, and reaping.
- Keep web, mobile, desktop, voice, and automation clients independent of Pi's native protocol.
- Leave a narrow future path for a Pi-RPC-compatible `pi-threads` proxy without adding unused
  configuration now.

## Non-goals

- Pooling, prewarming, or switching one Pi worker between multiple active T3 sessions.
- Depending on, launching, configuring, or administering `pi-threads`.
- Reimplementing Pi's session catalog or copying its JSONL transcript into a second provider-native
  store.
- Making native Pi sessions interchangeable with Codex, Claude, or other provider session formats.
- Claiming that Pi project trust is equivalent to command approval or filesystem sandboxing.
- Bundling a personal Pi extension or policy configuration as a prerequisite for basic Pi support.
- Exposing raw Pi events or Pi RPC directly to T3 clients.
- Adding a speculative `pi-threads` transport discriminator, fallback, or compatibility mode.

## Component Boundaries

### PiDriver

`PiDriver` is a built-in provider driver registered alongside Codex, Claude, Cursor, Grok, and
OpenCode. It owns provider-instance construction and produces:

- a managed `ServerProviderShape` snapshot;
- a `ProviderAdapterShape<ProviderAdapterError>` implemented by `PiAdapter`;
- a Pi-backed `TextGeneration` service for T3 utility generation.

Each provider instance captures its own decoded configuration and environment. Multiple Pi
instances are allowed when they have intentionally distinct configuration, credentials, model
providers, or session directories. Their mutable process/session maps are never shared.

### PiAdapter

`PiAdapter` implements T3's canonical provider operations:

- `startSession`
- `sendTurn`
- `interruptTurn`
- `respondToRequest`
- `respondToUserInput`
- `stopSession`
- `listSessions`
- `hasSession`
- `readThread`
- `rollbackThread`
- `stopAll`
- `streamEvents`

It owns a map from T3 `ThreadId` to active `PiAdapterSessionContext`. The context contains exactly
one `PiSessionRuntime`, its scope, event fiber, request correlations, and stopped flag. Starting a
second session for the same T3 thread closes the previous context before replacing it.

The adapter does not know HTTP, WebSocket, mobile, voice, or UI protocols. It emits canonical
`ProviderRuntimeEvent` values and accepts canonical T3 inputs.

### PiSessionRuntime

`PiSessionRuntime` owns one child process and the native Pi protocol for one active T3 session. It
is responsible for:

- resolving and spawning the configured executable;
- strict JSONL framing;
- command ID generation and response correlation;
- response deadlines and process-exit propagation;
- Pi event decoding and delivery;
- native session start/resume verification;
- active-turn state;
- pending extension UI requests;
- graceful abort and shutdown;
- the current typed resume cursor.

The runtime exposes typed operations to `PiAdapter`; provider-native JSON remains inside this
module. A small runtime factory seam exists for deterministic tests. It is not a general transport
plugin system.

### Existing T3 ownership

The following remain owned by existing T3 layers:

- provider-instance routing and configuration reload;
- logical T3 thread persistence;
- active provider-session directory and idle reaping;
- client authentication and authorization;
- attachment storage and access validation;
- canonical event persistence and fanout;
- voice-agent tool dispatch;
- remote T3 environment connectivity.

Pi code must not recreate any of these facilities.

## Configuration

Add a first-party `PiSettings` schema and a `pi` built-in driver. The initial provider-instance
payload is intentionally direct-process-only:

```json
{
  "driver": "pi",
  "displayName": "Pi",
  "enabled": true,
  "config": {
    "binaryPath": "pi",
    "agentDir": "",
    "sessionDir": "",
    "projectTrust": "inherit"
  }
}
```

Fields:

- `binaryPath`: executable or resolvable command, default `pi`;
- `agentDir`: optional Pi configuration directory, exported as `PI_CODING_AGENT_DIR` when set;
- `sessionDir`: optional Pi session directory passed with `--session-dir` and exported consistently
  for probes and utility commands;
- `projectTrust`: `inherit`, `approve`, or `deny`, mapped only to Pi's project-resource trust
  behavior.

Provider-instance environment variables continue through T3's existing environment and secret
handling. API keys are not duplicated into Pi-specific settings.

`projectTrust` controls whether project-local Pi resources such as extensions, prompts, skills,
and themes are loaded in noninteractive mode. It does not control approval of bash, edit, write, or
other tool calls. The UI and documentation must label it accordingly.

No `runtime`, `transport`, `pool`, `daemon`, `endpoint`, or `piThreads` field is introduced in the
initial schema.

## Provider Identity and Continuation

The driver kind is `pi`. A provider instance has the usual T3 `ProviderInstanceId` and a
continuation identity derived from the normalized effective Pi configuration and session-storage
identity. Instances pointing at the same effective agent/session layout may share a continuation
group only when T3 can safely resume the same native Pi sessions through either instance.

The provider-native Pi session ID is not the T3 provider-instance ID. The canonical T3 `ThreadId`
remains the routing identity presented to clients.

Switching a T3 thread from Pi to another provider is not native resume. A future cross-provider
handoff must create a new provider session from normalized context. It must not place a Codex or
Claude identifier into a Pi resume cursor or silently reinterpret Pi JSONL.

## Process Lifecycle

### Starting a new session

For a T3 thread without a Pi resume cursor:

1. Validate the selected provider instance, CWD, runtime mode, model selection, and attachments.
2. Create a child scope owned by the adapter session.
3. Resolve `binaryPath` using the same executable-resolution discipline as other CLI providers.
4. Spawn Pi in the requested CWD with:

   ```text
   pi --mode rpc --session-id <T3 ThreadId>
   ```

   Add `--session-dir`, `--provider`, `--model`, and project-trust flags only when explicitly
   configured or selected.

5. Attach the strict stdout decoder before sending commands.
6. Issue `get_state` with a bounded deadline as the readiness probe.
7. Verify that Pi reports a nonempty session ID and session file.
8. Construct and persist a typed resume cursor.
9. Emit canonical session-ready and thread-started events.

Using `--session-id` makes creation deterministic and prevents an accepted prompt from racing the
discovery of a newly generated native identity. Pi must reject an accidental collision rather than
silently attach to an unrelated existing session.

### Resuming a session

For a valid Pi resume cursor:

1. Validate the cursor schema and ownership constraints before using its path.
2. Spawn `pi --mode rpc --session <sessionPath>` in the persisted CWD.
3. Call `get_state` before accepting a turn.
4. Require the returned Pi session ID and canonical session file to match the cursor.
5. Refresh mutable state such as current model, thinking level, message count, and compaction state.
6. Emit canonical resume/ready events.

There is no attempt to reconnect to an old process. Process identity is never part of durable
continuation.

### Active turns

The same child process handles every turn while the T3 session remains active. `sendTurn` creates a
new T3 `TurnId`, records it as active, and sends one correlated Pi `prompt` command. Pi's successful
command response means the prompt was accepted; streaming completion arrives through native events.

One Pi runtime accepts at most one active T3 turn. A second ordinary `sendTurn` while running is
rejected as a canonical busy/request error. Pi-native steering and follow-up queues are not exposed
by overloading `sendTurn`; they require explicit T3 operations if added later.

Different T3 threads may run concurrently because each active adapter session owns a distinct Pi
process. T3's existing provider-session controls and operating-system limits bound total process
count. The Pi driver adds no global capacity scheduler.

### Stopping

`stopSession` is idempotent:

1. Mark the context stopped and remove it from the adapter map.
2. If a turn is active, send `abort` and wait for a short bounded acknowledgement.
3. Resolve or cancel every pending extension UI request.
4. Close stdin or otherwise request graceful process shutdown.
5. Wait for exit, then send `SIGTERM` and finally `SIGKILL` after bounded deadlines if required.
6. Close the child scope, interrupt the event fiber, and emit one canonical closed event.

Pi's durable session file remains. `stopAll` performs the same operation for every active context
with bounded concurrency.

### Reaping and server restart

T3's existing provider-session reaper decides when an inactive logical session should stop. The Pi
adapter does not implement its own idle timer. A T3 server restart loses active processes but not
Pi session JSONL or the persisted resume cursor. The next activation follows the normal resume path.

## Resume Cursor

Define a provider-private, strictly decoded cursor:

```ts
interface PiResumeCursorV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly cwd: string;
}
```

Rules:

- no alternate field names or legacy shapes;
- `sessionPath` and `cwd` are absolute canonical paths;
- the session file must be a regular Pi JSONL session file;
- the cursor-reported session ID must match `get_state` after startup;
- a configured `sessionDir` constrains the resolved session path to that directory;
- a client-supplied cursor is never trusted merely because it passed structural decoding;
- cursor updates caused by rollback are persisted before T3 reports the operation complete.

The cursor may later gain a new explicit version. The initial implementation does not accept
unversioned cursors.

## Native RPC Transport

### Framing

Pi RPC uses one JSON object per LF byte. The decoder must:

- split only on `\n`;
- accept an optional trailing `\r` immediately before `\n`;
- preserve Unicode `U+2028` and `U+2029` inside JSON strings;
- bound the unterminated receive buffer and individual record size;
- reject malformed JSON and invalid top-level shapes as protocol errors;
- never use Node's generic `readline` record splitting.

stdin writes are serialized and honor backpressure. Unexpected stdout text is a protocol failure,
not user-visible assistant content. stderr is captured through the native provider logger with
secrets redacted and bounded tails attached to process errors.

### Command correlation

Every T3-issued Pi command carries an adapter-generated opaque request ID. The runtime keeps a map
of pending IDs to deferred responses and command-specific decoders.

- duplicate response IDs are protocol errors;
- unknown response IDs are logged and ignored after validation;
- an event never satisfies a pending command;
- a successful prompt response means accepted, not completed;
- command timeouts remove their pending entries;
- process exit fails all pending commands exactly once;
- timeout does not imply that Pi failed to perform the operation, so non-idempotent retries are not
  automatic.

### Protocol decoding

Create narrow schemas for only the Pi commands and events T3 consumes. Do not decode native data as
an unbounded `Record<string, unknown>` throughout the adapter. Unknown event types are retained only
in redacted native diagnostics and ignored by canonical mapping.

The implementation pins and tests a supported Pi version range. Health snapshots distinguish:

- executable missing;
- version unsupported;
- RPC startup failed;
- configuration/model provider unavailable;
- ready.

## Turn and Event Normalization

Pi events do not carry T3 identifiers. The adapter correlates them to the single active turn in the
owning runtime and generates T3 event/item IDs. Native IDs such as `toolCallId` are retained only in
`providerRefs` and native logs where useful.

Initial mapping:

| Pi event                        | Canonical T3 behavior                                                       |
| ------------------------------- | --------------------------------------------------------------------------- |
| `agent_start`                   | mark the T3 turn running                                                    |
| `turn_start`                    | emit a task/run-step start when it adds information                         |
| `message_start`                 | create an assistant or reasoning item                                       |
| `message_update.text_delta`     | emit assistant `content.delta`                                              |
| `message_update.thinking_delta` | emit reasoning `content.delta`                                              |
| `message_end`                   | complete the corresponding message/reasoning item                           |
| `tool_execution_start`          | start a canonical tool item                                                 |
| `tool_execution_update`         | replace/append bounded tool progress without duplicating accumulated output |
| `tool_execution_end`            | complete or fail the tool item                                              |
| `turn_end`                      | complete the current model/tool step                                        |
| `agent_end`                     | complete the T3 turn and clear active state                                 |
| `queue_update`                  | emit queue/task state only after T3 exposes matching queue operations       |
| `compaction_start`              | start a context-compaction item                                             |
| `compaction_end`                | complete/fail compaction and refresh token usage                            |
| `auto_retry_start`              | emit retry progress and a recoverable runtime warning                       |
| `auto_retry_end`                | resolve retry state or fail the turn after final failure                    |
| `extension_error`               | emit a bounded provider runtime error                                       |
| process exit                    | emit session exit; fail an active turn if one exists                        |

Tool item types are derived from the native tool name using an explicit mapping:

- `bash` -> command execution;
- `read`, `grep`, `find`, and `ls` -> file/search tool activity;
- `edit` and `write` -> file change;
- registered MCP/custom tools -> MCP or dynamic tool call when native metadata proves the type;
- unknown names -> generic dynamic tool call.

Arguments and results are size-bounded and secret-redacted before entering canonical event payloads.
Accumulated Pi progress results must not be repeatedly appended as deltas.

### Completion and failure

`agent_end` is the authoritative normal completion boundary. `message_end` and `turn_end` do not
independently complete the outer T3 turn. An abort-related Pi error maps to interrupted/cancelled,
not a generic provider failure. A final model error, failed retry, process crash, or invalid protocol
record completes the active T3 turn once with a failed state.

Late native events after stop, replacement, or a new generation are fenced and ignored.

## Extension UI and Requests

Pi RPC converts supported extension UI calls into `extension_ui_request` events. T3 supports them
without requiring any particular extension.

Dialog mappings:

- `confirm` -> canonical request opened; `respondToRequest` sends `extension_ui_response` with the
  selected boolean or cancellation;
- `select` -> canonical structured user-input request with enumerated options;
- `input` -> canonical structured text input;
- `editor` -> canonical multiline text input.

Fire-and-forget methods such as notification, status, title, widget, and editor-text updates do not
create pending requests. T3 maps supported meaning to bounded notifications/status events and
ignores presentation-only methods that have no canonical representation.

The adapter maintains both T3 request IDs and native extension request IDs. It enforces:

- exactly one response per pending native request;
- ownership by the active T3 thread/session generation;
- bounded pending-request count;
- cancellation on stop, process exit, or replacement;
- race-safe handling when Pi's native timeout resolves before the client responds;
- validation that submitted answers match the original method and option set.

## Runtime Modes, Trust, and Security

Stock Pi does not provide Codex-equivalent sandbox and per-tool approval semantics. Pi's
`--approve` and `--no-approve` flags govern trust in project-local Pi resources; they do not make
bash or file mutation safe.

The initial adapter therefore supports T3 `full-access` runtime mode only. It rejects
`approval-required` and `auto-accept-edits` with a clear validation error instead of silently
running with broader authority than the UI claims. Likewise, unsupported combinations of explicit
`approvalPolicy` and `sandboxMode` fail at session start.

An installed Pi extension may independently request confirmation through the extension UI
subprotocol, and T3 will display it. That does not change the declared T3 runtime-mode guarantee.

Future support for stricter modes requires an enforceable, testable Pi policy boundary. It may be
implemented upstream in Pi or as a separately designed T3-managed integration, but it must not make
a user's personal policy extension mandatory for baseline Pi support.

Additional safeguards:

- never interpolate prompt or configuration into a shell command;
- pass executable arguments as an argv vector;
- use T3's existing provider-instance environment secret handling;
- redact credentials from native logs and errors;
- validate resume paths and attachment reads;
- treat Pi and its tools as shell-equivalent authority in `full-access` mode;
- show the effective runtime mode and project-trust policy in provider/session status.

## Models and Thinking

Pi model selection has a provider name, model ID, and thinking level. T3's selected model string
must map deterministically to Pi startup and RPC operations.

- New session: pass selected provider/model at startup, then verify with `get_state`.
- Existing idle session: use `set_model` when T3 requests an in-session change.
- Active turn: reject a model change until the current turn completes.
- Thinking level: map the canonical Pi model option to `set_thinking_level` and validate Pi's
  supported levels.
- Model discovery: use a bounded no-session RPC probe and `get_available_models`, not human table
  parsing.

The adapter advertises `sessionModelSwitch: "in-session"` only after tests prove that model and
thinking changes are applied atomically and reported correctly. Provider model metadata is
normalized into T3's existing model catalog; Pi-specific raw model objects remain internal.

## Attachments

Pi RPC accepts inline image content. T3 resolves each image attachment through the existing
attachment store, validates ownership and size, reads it with bounded concurrency, and sends base64
data plus its validated MIME type.

The initial adapter rejects provider-native attachment types that Pi RPC cannot represent directly.
It does not silently paste arbitrary binary files into prompts or expose server filesystem paths.
Support for additional text/file inputs requires an explicit canonical mapping and tests.

## Reading and Rolling Back Threads

### Read

`readThread` operates on an active adapter session and uses Pi `get_entries`, `get_tree`, or
`get_messages` through typed decoders. It reconstructs the active branch into canonical turns and
items without parsing the JSONL file independently. Branch metadata remains provider-native unless
T3 adds a canonical branch surface.

### Rollback

Rollback is allowed only while the session is idle and has no pending extension request.

1. Read the active branch entries.
2. Identify the first user-message entry belonging to the last `numTurns` canonical turns.
3. Issue Pi `fork` at that user entry, which creates a new Pi session from the state before the
   selected message.
4. Reject cancellation or a mismatched branch result.
5. Read and verify the new `get_state` identity and session path.
6. Atomically replace the T3 thread's Pi resume cursor.
7. Return the rebuilt canonical snapshot.

The prior Pi session file remains as native history, but the T3 thread continues from the new
cursor. Tests must pin the exact upstream `fork` semantics before enabling rollback; T3 must not
approximate rollback by editing Pi JSONL.

## Text Generation

T3 requires each provider instance to expose a utility `TextGeneration` service for tasks such as
titles, commit messages, and summaries. Pi implements this separately from durable coding sessions,
matching the way Codex uses a transient execution path for utility generation.

Each request starts a bounded no-session, no-tools Pi invocation using the provider instance's
environment and selected model. It does not create or reuse a durable Pi coding session, load
project-local mutable tools, or enter the adapter's active-session map. Cancellation terminates the
utility process. Output is size-bounded and decoded as text rather than terminal presentation.

## Failure Handling

### Startup failure

Executable resolution, spawn, early exit, readiness timeout, invalid `get_state`, unsupported
version, and resume mismatch are distinct adapter errors. A partially started process and scope are
always closed before `startSession` fails.

### Mid-turn process exit

The runtime:

1. atomically records the exit;
2. fails every pending command;
3. cancels pending UI requests;
4. fails the active turn once;
5. emits a canonical session-exited event with recoverability;
6. removes the active adapter context.

T3 does not automatically replay the accepted prompt because Pi may have persisted tool effects or
partial messages before the crash. The user explicitly resumes and decides whether to retry.

### Protocol failure

Malformed stdout, oversized frames, impossible response shapes, duplicate response IDs, or invalid
state transitions close the runtime. Continuing after protocol desynchronization risks attaching
events or responses to the wrong turn.

### Temporary provider errors

Pi owns its native automatic retry policy and reports retry events. T3 displays normalized retry
state but does not add a second retry loop around accepted prompts.

## Observability

Record structured metrics and traces for:

- executable/version probe outcome and latency;
- session start versus resume and readiness latency;
- active Pi processes by provider instance;
- command latency by native command type;
- turn time to first content and completion;
- tool and compaction counts;
- retry attempts and final outcomes;
- pending extension request count and response latency;
- graceful versus forced shutdown;
- process exit code/signal and protocol failures.

Native NDJSON logging uses the existing provider logger and is disabled or redacted according to T3
settings. Prompts, model output, tool results, environment values, and session file contents are not
added to general operational logs.

## Relationship to Voice

The voice broker does not call Pi RPC. Realtime voice tools dispatch canonical T3 commands through
`ClientCommandDispatcher`. When a target thread belongs to a Pi provider instance, normal provider
routing reaches `PiAdapter`.

Consequences:

- voice can create or message Pi-backed T3 threads once normal provider selection supports Pi;
- Pi credentials and native events never enter the Realtime model or mobile client;
- confirmation policy for voice mutations remains in the voice tool layer;
- Pi tool execution inside the resulting coding thread follows that thread's declared runtime mode
  and provider configuration.

## Future `pi-threads` Compatibility

The current `pi-threads` daemon exposes a higher-level JSON-RPC API and is not a native Pi RPC
drop-in. T3 does not integrate that protocol in the initial implementation.

The preferred upstream evolution is a `pi-threads` proxy executable that:

- accepts the Pi RPC startup arguments T3 uses;
- presents strict native Pi RPC JSONL on stdin/stdout;
- preserves command, response, event, session, cancellation, and shutdown semantics;
- hides any daemon connection or pooling behind that compatible process boundary.

If that exists, a user can select it through `binaryPath` and `PiSessionRuntime` remains unchanged.
Compatibility must be verified against the same conformance suite as stock Pi.

If future `pi-threads` intentionally retains a different protocol, adding it requires a new explicit
design and a discriminated Pi runtime configuration. It must not be introduced as an automatic
fallback, guessed from the executable name, or supported through dual-shape parsing.

## Source Layout

Target layout, following existing provider conventions:

```text
packages/contracts/src/settings.ts
apps/server/src/provider/Drivers/PiDriver.ts
apps/server/src/provider/Layers/PiAdapter.ts
apps/server/src/provider/Layers/PiProvider.ts
apps/server/src/provider/Layers/PiSessionRuntime.ts
apps/server/src/provider/Services/PiAdapter.ts
apps/server/src/textGeneration/PiTextGeneration.ts
```

Protocol schemas may live under `apps/server/src/provider/pi/` when separating framing, native
types, and event normalization materially reduces file size. The contracts package contains only
shared settings and canonical schemas; Pi native protocol types stay server-side.

## Testing Strategy

### Protocol unit tests

- fragmented and coalesced LF records;
- CRLF tolerance without generic Unicode line splitting;
- `U+2028` and `U+2029` inside JSON strings;
- oversized and malformed records;
- concurrent correlated commands and out-of-order responses;
- unknown, duplicate, late, and timed-out response IDs;
- stdout close with pending commands;
- stdin backpressure and write failure.

### Runtime tests

Use a deterministic fake Pi executable/process harness to verify:

- new session startup and readiness;
- resume cursor verification and path rejection;
- multiple turns reuse one process;
- one active turn per runtime;
- abort and graceful stop;
- forced termination after deadline;
- process crash before readiness, while idle, and during a turn;
- no prompt replay after ambiguous failure;
- pending extension UI cancellation;
- model and thinking changes;
- event fencing after replacement.

### Adapter tests

- provider-instance isolation;
- session replacement for the same T3 thread;
- concurrent independent T3 threads use independent processes;
- canonical text, reasoning, tool, retry, compaction, and error events;
- accumulated tool progress is not duplicated;
- extension confirm/select/input/editor round trips;
- read snapshot reconstruction;
- rollback creates and persists the new cursor;
- unsupported runtime modes fail before spawn;
- image attachment validation and unsupported attachment rejection;
- `stopAll` closes every runtime.

### Driver tests

- default settings decoding;
- environment and agent/session directory resolution;
- continuation identity;
- missing and unsupported binary snapshots;
- version and model discovery;
- provider-instance config reload closes old resources;
- utility text generation uses no session and no tools.

### Live gated tests

An opt-in suite against an installed compatible Pi verifies:

- start a real session in a temporary CWD and session directory;
- complete two turns through one process;
- stop and resume through a new process;
- read the same transcript in interactive/native Pi tooling;
- stream one real tool execution;
- abort a long turn;
- compact and report usage;
- complete an extension UI request with a fixture extension;
- roll back one turn and continue from the new cursor;
- confirm no concurrent writer remains after shutdown.

Live tests use isolated Pi configuration/session directories and never touch personal Pi or
`pi-threads` sessions.

## Implementation Plan

### 1. Contracts and catalog

- Add `PiSettings` and defaults.
- Add Pi display/model metadata and built-in driver registration.
- Add the strict versioned Pi resume cursor server schema.
- Add settings, provider-instance, and routing tests.

### 2. Native runtime

- Implement strict JSONL framing and correlated commands.
- Implement process resolution, startup, readiness, state, abort, and shutdown.
- Decode the required Pi commands/events with bounded schemas.
- Add the fake-process conformance suite.

### 3. Canonical adapter

- Implement active session ownership and lifecycle.
- Normalize turns, messages, reasoning, tools, retries, compaction, usage, and errors.
- Implement extension UI request correlation.
- Implement read and rollback.
- Add native event logging and redaction.

### 4. Driver and utility generation

- Implement health/version/model snapshots.
- Implement provider-instance environment and continuation identity.
- Implement no-session, no-tools text generation.
- Register `PiDriver` in the built-in catalog and runtime environment union.

### 5. Product integration

- Expose Pi provider configuration and status in existing settings UI.
- Verify project/thread creation, model selection, transcript rendering, interruption, and resume.
- Verify canonical dispatcher and Realtime voice tools against a Pi-backed thread.
- Document installation, project trust, full-access semantics, and interactive handoff safety.

### 6. Hardening

- Run full T3 checks and provider regression suites.
- Run the gated stock-Pi lifecycle test.
- Exercise server restart, session reaping, config reload, and corrupted cursor cases.
- Confirm no Pi process, pending request, or event fiber leaks after every terminal path.

## Acceptance Criteria

The initial Pi provider is complete when:

- a stock installed Pi executable is the only Pi-specific runtime dependency;
- two messages in one active T3 thread use the same Pi RPC PID;
- stopping and resuming uses a new PID and the same verified Pi history;
- two active T3 Pi threads run independently without a T3 pooling layer;
- all supported native events render through canonical T3 event contracts;
- interruption, extension UI, compaction, read, and rollback work through typed RPC;
- unsupported runtime modes fail clearly before Pi gains broader authority than advertised;
- T3 server restart and provider-instance reload leave no orphaned Pi process;
- voice messaging reaches a Pi-backed thread through the normal dispatcher;
- no T3 configuration or code path requires `pi-threads`.

## References

- Pi RPC documentation: `packages/coding-agent/docs/rpc.md` in the Pi repository.
- Pi SDK and native engine documentation: `packages/coding-agent/docs/sdk.md` in the Pi repository.
- `pi-threads` worker/process reference: `src/worker/` in the `pi-threads` repository.
- T3 canonical provider contract: `apps/server/src/provider/Services/ProviderAdapter.ts`.
- T3 Codex lifecycle reference: `apps/server/src/provider/Layers/CodexSessionRuntime.ts` and
  `apps/server/src/provider/Layers/CodexAdapter.ts`.

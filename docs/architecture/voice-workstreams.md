# Voice And Pi Workstream Execution Plan

## Status

Active execution plan for the stacked work following
`feature/master-voice-orchestrator` at commit `40c43d1e5`.

This plan covers the agreed Realtime voice tools plus workstreams 1 through 9. Each workstream is
implemented on a branch stacked from the reviewed commit immediately before it. A branch is not
considered complete until implementation, verification, adversarial review, Keel review, commit,
and push are complete.

## Decisions

- History search reads both ordinary coding-thread messages and durable voice-conversation entries,
  but `search_history` and `read_history` are tools only for the OpenAI Realtime voice agent.
- Codex, Claude, Pi, and ordinary T3 coding sessions do not receive the special voice-agent tools.
- `send_thread_message` continues to dispatch immediately. Its receipt gains stable correlation
  identifiers, and a separate bounded `wait_for_thread_turn` tool waits for completion.
- The initial completion design does not inject a synthetic user or system message into an active
  Realtime conversation. No background completion watcher is included.
- Pi is a normal T3 coding-agent provider implemented through Pi's native `pi --mode rpc` JSONL
  protocol. It does not use ACP and does not introduce another broker.
- Long-context pruning changes only the compiled provider view. The durable voice journal remains
  authoritative and complete.
- Hands-free mode composes bounded STT, ordinary T3 thread turns, and streaming TTS. It is distinct
  from the Realtime master voice agent.
- Screen-off controls are opt-in. After Android process death, native capture remains unavailable
  until the authenticated React controller reattaches; the first implementation does not add a
  native credential-bearing control client.

## Stacked Branches

| Order | Branch                                  | Workstream                                                              |
| ----- | --------------------------------------- | ----------------------------------------------------------------------- |
| 0     | `feature/voice-thread-followup-tools`   | Prerequisite Realtime thread history and bounded wait tools             |
| 1     | `feature/voice-conversation-management` | Voice transcript browsing and conversation administration               |
| 2     | `feature/voice-history-search`          | Unified thread/voice history search and exact reads for Realtime voice  |
| 3     | `feature/pi-provider`                   | Pi coding-agent provider through native RPC                             |
| 4     | `feature/android-voice-hardening`       | Native lifecycle, route, WebRTC, diagnostics, and device-test hardening |
| 5     | `feature/voice-long-context`            | Deterministic context compilation, truncation, and call rotation        |
| 6     | `feature/voice-media-limits`            | Trusted media validation, quotas, and adversarial limits                |
| 7     | `feature/voice-observability`           | Privacy-safe server and Android voice diagnostics                       |
| 8     | `feature/voice-hands-free`              | Hands-free bounded conversation for ordinary threads                    |
| 9     | `feature/voice-headset-controls`        | Screen-off headset and persistent notification controls                 |

Branches remain stacked until the complete series is ready for integration. Routine fixes found
during a workstream stay on that workstream's branch rather than creating additional branches.

## Review And Delivery Loop

Every branch uses the same caller-driven review loop:

1. Confirm the current branch is clean except for explicitly preserved pre-existing files.
2. Create the next branch from the reviewed predecessor commit.
3. Implement the complete workstream without transitional compatibility shapes.
4. Run focused unit, integration, native, and device checks appropriate to the change.
5. Launch adversarial read-only subagents outside Keel. They report concrete defects, missing tests,
   unclear contracts, security failures, and lifecycle risks; they do not edit files.
6. Apply only findings that are technically correct and rerun affected checks.
7. Run the saved Keel `iterative-review` workflow against the checkout with:
   - profile `claude-default`;
   - Claude Opus 4.8 with `xhigh` reasoning;
   - read-only tool policy;
   - `stopWhenClean: true`;
   - no caller-specified iteration limit.
8. For valid findings, edit in the caller session, verify, and signal the same durable run with
   `review-cycle` and a concise summary. Repeat until the reviewer returns no findings.
9. Run `vp check` and `vp run typecheck`. Native mobile changes also run `vp run lint:mobile`, clean
   Expo prebuild, release APK assembly, artifact inspection, in-place device installation, and
   connected-device smoke checks.
10. Commit only the workstream's files, push the branch to `kcosr/t3code`, and create the next branch
    from that reviewed commit.

The Keel invocation shape is:

```bash
KEEL_ADMIN_TOKEN=token keel workflow run iterative-review \
  --target /home/kevin/worktrees/t3code \
  --input '{
    "repository":"/home/kevin/worktrees/t3code",
    "task":"<workstream task and acceptance criteria>",
    "profile":"claude-default",
    "stopWhenClean":true
  }' \
  --output json
```

If a follow-up cycle is needed:

```bash
KEEL_ADMIN_TOKEN=token keel signal <run-id> review-cycle \
  '{"summary":"<implemented fixes and verification>"}'
KEEL_ADMIN_TOKEN=token keel watch <run-id> --output text
```

Keel review turns may be slow and are not interrupted unless the user requests it.

## 0. Realtime Thread Follow-Up Tools

### Scope

- Add bounded `get_thread_messages` pagination over authoritative normalized messages.
- Preserve immediate `send_thread_message` dispatch while returning `sequence`, `threadId`,
  `commandId`, and deterministic `messageId`.
- Add cancellable `wait_for_thread_turn` correlated to the dispatched message rather than whichever
  turn happens to be latest.
- Persist the exact message-to-turn handoff as a monotonic `pending`, `submitting`, `accepted`,
  `failed`, or `ambiguous` state machine. A provider submission is never repeated after its outcome
  becomes uncertain.
- Return typed pending, running, completed, interrupted, failed, approval-required, and
  user-input-required states with the final assistant message when available.
- Refactor the voice tool permission classification into an exhaustive policy map before expanding
  the allowlist.

### Constraints

- No asynchronous watcher and no synthetic Realtime message injection.
- Waits are bounded, initially no longer than 25 seconds per call, and leave no fiber after session
  cancellation.
- Message reads remain bounded and clearly identify partial or streaming state.
- A completed result is not exposed until its final assistant output has settled. Failure and
  interruption remain authoritative even when a partial assistant message is still streaming.

### Acceptance

- Retry/idempotency returns the same receipt identifiers.
- Delayed turn-ID materialization resolves against the exact dispatched message.
- Restart and exhausted-correlation recovery either preserves the known turn correlation or reports
  explicit ambiguity without submitting the provider turn a second time.
- Timeout returns typed running or pending state rather than failing the tool.
- The timeout bounds every projection read, including the terminal snapshot returned to the model.
- Page byte limits never advance a cursor past messages omitted by that limit.
- Approval, user-input, interruption, failure, and completed output are covered by deterministic
  tests.
- The OpenAI tool schemas, contracts, authorization, journal, and executor remain exhaustive.

## 1. Voice Conversation Management

### Scope

- Add a branded `VoiceConversationEntryId` and a bounded public transcript projection.
- Add cursor-based durable transcript reads without starting a provider call.
- Add rename/update-title support through repository, service, HTTP, and client runtime.
- Make Resume and New explicit actions.
- Add Rename, Clear model context, and Delete actions with appropriate confirmation.

### Constraints

- Public transcript DTOs never expose raw journal payloads, provider IDs, tool arguments, SDP, or
  internal errors.
- Normal transcript browsing is bounded and has explicit epoch semantics. Clear Context must not
  accidentally make old entries model-visible again.
- Clearing or deleting an active conversation terminates its active lease safely.

### Acceptance

- History can be inspected without WebRTC negotiation or provider activity.
- Paging remains stable while new entries are appended.
- Rename persists across restart and updates list ordering.
- Clear and Delete both end and fence active provider/native media.
- Pre-clear transcript remains inspectable across bounded transcript pages while being excluded
  from future model replay.
- Schema/redaction tests prove raw unknown journal payloads and provider/tool internals cannot cross
  the public endpoint.

## 2. Unified Voice-Agent History Search

### Scope

- Add shared typed history references, search/read inputs, bounded results, opaque cursors, and
  public errors.
- Add authenticated `POST /api/history/search` and `POST /api/history/read` endpoints plus client
  runtime methods.
- Add transactional SQLite FTS5 indexes and restart-safe backfills for completed ordinary thread
  messages and searchable durable voice entries.
- Add a `HistorySearchService` that validates, authorizes, ranks, merges, paginates, and bounds
  source-specific results.
- Add `search_history` and `read_history` only to the Realtime voice tool allowlist.

### Constraints

- Ordinary text is escaped into controlled FTS terms; agents never receive raw FTS syntax, SQL,
  regex, or filesystem access.
- Voice results are limited by durable retention and permitted epoch. Direct IDs must validate the
  owning container and authorization.
- Combined searches fail rather than silently returning partial source results.
- Logs and traces contain counts, timing, filter presence, and outcome only, never query or content.

### Acceptance

- Backfill and transactional index maintenance cover create, completion, revert, deletion,
  retention, Clear Context, and hard delete.
- Exact reads and neighboring context never cross thread, conversation, or epoch boundaries.
- Ranking and pagination are deterministic across both sources.
- Prompt-injection fixtures cannot expand tools, authorization, or confirmation policy.

## 3. Pi Provider

### Scope

- Add a built-in `pi` provider-instance driver using `pi --mode rpc`.
- Add a strict LF-delimited JSONL RPC runtime with correlated requests, bounded shutdown, process
  failure handling, and durable session resumption.
- Map Pi prompt, steering, abort, model selection, thinking level, text/reasoning deltas, tool
  lifecycle, compaction, usage, and terminal events into existing T3 provider runtime contracts.
- Add health/model discovery, provider settings surfaces, web/mobile identity, and text-generation
  support.
- Add a small trusted T3 Pi extension that maps Pi extension UI/tool interception to T3 approvals
  and structured user input.

### Constraints

- No ACP adapter and no new agent broker.
- Pi is configured only through `providerInstances`; do not add a legacy `providers.pi` shape.
- A versioned opaque resume cursor contains the Pi session ID, never an absolute session path.
- One Pi RPC process represents one live T3 thread session.
- Unsupported rollback fails explicitly until Pi exposes a safe headless equivalent.
- `workspace-write` must use real T3 policy or OS containment; prompt-only path rules are not a
  sandbox.

### Acceptance

- Multiple Pi instances have isolated configuration, auth, processes, and sessions.
- New and resumed threads stream canonical text, reasoning, tool, usage, and lifecycle events.
- Interrupt and shutdown leave no orphan process.
- Model/thinking changes and steering work in-session.
- Approval-required tools cannot execute before T3 resolves the request.
- Accept-once, accept-for-session, decline/cancel, generic extension input, and late/unknown approval
  responses map deterministically; denied tools never execute.
- Read-only, workspace-write, and danger-full-access are tested, including absolute-path, symlink,
  and shell escape attempts. Workspace-write fails closed if containment cannot initialize.
- One prompt acknowledgement returns immediately with one stable T3 turn. Pi's internal model/tool
  cycles remain within it, and completion or error is emitted exactly once.
- Restarted T3 sessions resume Pi history through the opaque cursor and pass an end-to-end earlier
  fact recall test; no absolute path is persisted.
- Provider-qualified model slugs, discovery, in-session model/thinking changes, missing binary,
  unhealthy, and unknown-auth states are deterministic.
- Text generation covers valid structured output plus invalid, empty, and timeout failures.
- Correlated concurrent commands, LF/CRLF framing, response timeout, stderr isolation, oversized or
  malformed records, late responses, cancellation, and process exit are tested.
- Web and mobile can create/select Pi instances with per-instance environment, auth, and session
  directory isolation.

## 4. Long Context And Call Rotation

This workstream executes after Android hardening even though it retains the approved workstream
number. Automatic rotation depends on the lifecycle and replacement-session fencing established by
workstream 5.

### Scope

- Compile atomic conversation units rather than independently selecting journal entries.
- Preserve user/assistant continuity and tool request/result pairs.
- Compact obsolete or verbose tool interactions before omitting ordinary dialogue.
- Preserve the newest contiguous verbatim units and pinned continuity state.
- Raise the OpenAI persisted replay policy only with a conservative provider-specific reserve.
- Configure OpenAI active-call retention-ratio truncation while keeping replay acknowledgement
  failure fatal.
- Rotate duration-limited calls by reconnecting mobile to the same durable conversation with one
  fenced lease.

### Constraints

- Provider truncation never deletes journal history.
- Model-generated durable summaries remain deferred until deterministic compaction is proven.
- Rotation may have a short audible reconnect gap but cannot duplicate tools or create a new
  durable conversation.

### Acceptance

- Continued calls recall facts before 16,000 and around 50,000 tokens.
- Compiled context contains complete tool pairs only.
- A live call remains usable past the configured active-context threshold.
- Restart after provider truncation recovers older journal facts.
- Automatic duration rotation preserves conversation identity and one live media lease.

## 5. Android Voice Hardening

### Scope

- Extract testable native reducers/seams and add JVM plus instrumentation test infrastructure.
- Cover recorder/player ordering, binder timeout/disconnect, permissions, audio focus, routes,
  service/notification lifecycle, activity recreation, late SDP, network loss, and cleanup.
- Implement coherent focus-loss and route-change behavior before adding automatic listening.
- Add the minimal bounded native state/route/error diagnostic log needed to diagnose the connected
  device matrix; workstream 7 expands its metrics and retrieval surface.
- Run the connected Pixel matrix across speaker, wired, Bluetooth, background/recreation,
  permission revocation, network handoff/loss, and long calls.

### Acceptance

- Clean Expo prebuild preserves the module, permissions, and service manifest.
- No stale answer/event can attach to a replacement session.
- Transient and permanent audio-focus loss, wired/Bluetooth removal, and stale selected routes have
  explicit fallback behavior and propagate sanitized state changes.
- Notification denial and microphone revocation while active reach a coherent idle state.
- Network loss during both negotiation and an active peer converges server lease and native peer
  state rather than leaving either side active alone.
- Every stop, failure, permission loss, and process transition releases microphone, playback,
  WebRTC, audio focus, and foreground-service ownership.
- The matrix has no uncaught exception, FATAL, React `TypeError`, or unexpected runtime error;
  expected typed failures leave a coherent idle state.

## 6. Media Validation And Limits

### Scope

- Inspect bounded media before provider dispatch and do not trust multipart MIME declarations.
- Validate actual container, codec, duration, truncation, and supported format.
- Add explicit utterance-duration, request-rate, and concurrency settings and guards.
- Add real device-generated fixtures plus malformed, spoofed, truncated, and adversarial fixtures.

### Constraints

- Prefer a maintained in-process parser over handwritten MP4 parsing.
- Do not add an external `ffprobe` operational dependency without an explicit decision.
- Cancellation and all failures release quota reservations.
- Multipart processing rejects oversized content during transport/parsing before full
  materialization, including chunked input without `Content-Length`.
- Quotas combine per-principal and per-environment limits with a global ceiling, deterministic
  retry guidance, and fairness that prevents one client from starving voice use.

### Acceptance

- Invalid or over-limit media never reaches the provider fake or production adapter.
- MIME spoofing, malformed atoms, excessive duration, upload limit, cancellation, and concurrency
  are covered.
- Validation errors are typed, bounded, and content-free in logs.

## 7. Voice Observability

### Scope

- Add server metrics and spans for STT bytes/duration/provider latency, TTS first byte/bytes/cancel,
  signaling, sideband, session duration, replay, rotation, tool outcomes, and failures.
- Add controller timing for speech-to-first-audio and control failures.
- Add a bounded rotating Android app-private diagnostic log for state transitions, routes, numeric
  media counters, and sanitized error codes.
- Provide a controlled diagnostic retrieval path for device debugging.

### Constraints

- Never record transcripts, search queries, returned history, raw audio, SDP, provider credentials,
  tool arguments/results, or device-identifying route data.
- Realtime first-audio timing requires a sanitized native remote-audio-started event and monotonic
  clock correlation. Bounded TTS separately records provider first byte and native playback start.

### Acceptance

- Metric snapshot and redaction tests cover successful and failed paths.
- Native diagnostic storage is bounded and rotation-tested.
- Diagnostic retrieval is authorized, size-bounded, and redaction-tested.
- Intentional device failures can be diagnosed using only sanitized telemetry.

## 8. Hands-Free Bounded Thread Conversation

### Scope

- Add a pure TypeScript state machine with virtual-clock tests for arming, listening, endpointing,
  transcription, submission/review, waiting, streaming speech, rearming, recovery, and pause.
- Keep audio-energy/VAD endpoint detection and foreground capture in the Android service.
- Add an explicit bounded endpoint detector using tested amplitude polling or an `AudioRecord`
  capture path; the current compressed recorder does not expose energy frames.
- Reuse hardened bounded STT and streaming TTS primitives through extracted controllers.
- Add explicit review and auto-submit modes and a safe composer enqueue path.
- Keep barge-in disabled until echo rejection is verified.

### Constraints

- Stop speech, stop thread, and pause listening are independent actions.
- The microphone cannot rearm during TTS or its post-playback guard interval.
- Environment/thread changes, permission loss, repeated empty transcripts, and repeated provider
  errors pause rather than retry forever.
- Starting hands-free explicitly ends/fences an active master Realtime call.
- Approval-required and user-input-required ordinary turns pause the loop and cannot rearm the
  microphone until the interaction is resolved explicitly.

### Acceptance

- Start-of-speech, no-speech, end-silence, maximum-utterance, transcription, response, playback,
  rearm-guard, cancellation, retry, network-loss, and missing-playback-completion paths are tested
  with a virtual clock.
- Review mode cannot overwrite a changed draft or target.
- Auto-submit cannot race or duplicate an ordinary composer send.
- Speaker, wired, and Bluetooth tests show no self-transcription.
- Background/recreation and notification Stop leave the loop paused and resources released.

## 9. Screen-Off Headset Controls

### Scope

- Add an opt-in persistent voice foreground-service mode and Android `MediaSession`.
- Handle eligible initial media-button down events while ignoring repeats and key-up.
- Map idle presses to the configured bounded, hands-free, or Realtime action and active presses to
  stop that interaction.
- Add dynamic notification enable/disable/stop actions and coherent media playback state.
- Persist only non-secret readiness configuration.
- Require a generation-fenced readiness handshake proving an authenticated React controller is
  registered for the current environment, thread, and mode before a start press is accepted.
- Scope CPU and optional Wi-Fi locks to active work, not the idle readiness period.

### Constraints

- The persistent service is first started while the activity is visible, satisfying modern Android
  microphone foreground-service restrictions.
- After process restart, the service may restore visible readiness but cannot capture or contact T3
  until the authenticated React controller rebinds.
- Stale queued media events and controllers from a prior environment, thread, auth session, or mode
  generation are rejected.
- Disabling the feature releases the media session and persistent service when no other voice mode
  owns them.

### Acceptance

- Wired, classic Bluetooth, and BLE controls work with screen off and activity backgrounded.
- Bounded mode uses first press to start capture and second press to finish/submit; hands-free uses
  pause/resume semantics; Realtime uses start/hangup semantics. No stop gesture silently discards a
  completed bounded utterance.
- Doze, removal from recents, recreation, permission revocation, and process restart are safe.
- Environment/thread switch, controller disconnect, auth revocation, and stale generations cannot
  start capture.
- Android 14/15 device tests verify visible prestart and later microphone-service promotion at the
  current target SDK without foreground-service start or security exceptions.
- Wake/Wi-Fi-lock manifest permissions are present, and no lock is held during idle readiness.
- Competing media apps regain controls and audio focus after T3 releases its session.
- Notification actions and all wake/network locks are released deterministically.

## Preserved Working-Tree Documents

At plan creation, `docs/architecture/voice.md` is modified and
`docs/architecture/agent-history-search.md` is untracked from earlier design work. They are not
silently staged with unrelated implementation. Their content must be reconciled deliberately:

- replace the proposed asynchronous completion watcher with immediate receipt plus bounded wait;
- remove coding-agent/Pi exposure of special history tools;
- retain provider-neutral backend service boundaries where they improve server design;
- incorporate accepted long-context and lifecycle decisions in their corresponding branches.

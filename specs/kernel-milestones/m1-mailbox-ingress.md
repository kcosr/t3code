# M1 — Mailbox Ingress

First kernel milestone of `specs/native-voice-runtime-kernel.md` (Migration M1). Introduces
the kernel thread and mailbox; routes every ingress source through it; deletes the binder
INTERRUPT lane and stop-tombstone dispatcher. Behavior-neutral: the message handler still
takes `operationLock` internally and runs the exact code the entry points run today. All
line references are against the post-M0 tree (HEAD at or after `df7640988`).

## Context

No Kotlin toolchain on this host; mirror existing idioms; expect a pc-gate fix round. The
W0c types are the vocabulary: `VoiceKernelMessage` (`VoiceKernelMessages.kt:23-45`),
`VoiceKernelHostIntentAction` (8 values, post-M0), `VoiceKernel.kt` reducer contract (NOT
implemented this milestone — the mailbox executes legacy closures, not a reducer).

Stale-spec note: the kernel spec's M1 text predates M0 — "worker intents" no longer exist
(refresh worker deleted), `RefreshConfirm` is gone from the effect catalog, and the module
line citations moved. This packet's numbers are authoritative.

## Design

### 1. `VoiceKernelMailbox` (new file)

A service-owned single `HandlerThread("t3-voice-kernel")` + `Handler` wrapping a totally
ordered queue of entries `{message: VoiceKernelMessage, body: () -> Unit}`. For M1 the
`message` is diagnostic metadata (kind + origin recorded in the diagnostic ring); `body` is
the legacy closure. API: `submit(message, body)`, `submitDelayed(message, delayMillis,
body)` returning a cancellation token (replaces `mainHandler.postDelayed` ONLY where M1
moves an ingress path — the 51 broad mainHandler sites move in M2, not now), `assertKernelThread()`,
`drainAndQuit()` for `onDestroy`. Add a watchdog: log a diagnostic-ring entry when a body
runs > 250 ms (evidence for M3's driver extraction; no behavior change).

### 2. Binder ingress

Every `VoiceBinder` method that acquires `operationLock` (the ~33 `L`-marked methods and
the two piecewise dispatchers `dispatchVoiceRuntime` :872 and
`acknowledgeVoiceRuntimePresentationAction` :1018) wraps its existing body in
`mailbox.submit(...)`. Completion callbacks settle exactly as today (the bodies already
settle via callback/return plumbing — pure reads that take no lock, e.g. flow getters
:137-155, `acknowledgeRecordingTermination` :454, `enqueuePlaybackChunk` :566, stay
direct). The two piecewise dispatchers become ONE mailbox submission each — their
interleaved unlocked engine calls run inside the single body (the engine's own admission
is nonblocking; see Safety).

### 3. Host ingress

- `onStartCommand` (:2061-2101): each action arm becomes `mailbox.submit(HostIntent(...))`
  with the arm's existing locked body; the sticky/return computation stays synchronous
  using the current readiness snapshot (Android requires an immediate return — read the
  cached policy answer, do not wait on the mailbox).
- MediaSession callbacks (:5318-5357) and the `onMediaButtonEvent` mainHandler hop (:5335):
  submit `HostIntent` messages instead of posting/locking directly.
- Notification actions already arrive via `onStartCommand` — no separate path.

### 4. Module lane collapse (`T3VoiceModule.kt`)

Delete: the INTERRUPT thread/handler (:33-34), its teardown (:251-253), the lane enum +
ordering types + lane policy (:1371-1421), and the stop-tombstone machinery inside
`T3VoiceBinderOperationDispatcher` (:1424-1595 — the class shrinks to single-lane
registration/settlement; keep `T3VoiceBinderOperationAdmission` :1390-1392, keep
binder-generation stamps and reconnect replay :56-102, :1137-1179 — those are
connection-epoch fencing, deleted in M4, not now). All AsyncFunctions route through the
single ordered path; `stopRealtimeSessionAsync` / `drainAndStopRealtimeSessionAsync`
(:913-932) and `dispatchVoiceRuntimeAsync` (:421-431) lose their lane/ordering arguments.

### Safety argument (why deleting INTERRUPT is sound NOW — verify, don't assume)

The INTERRUPT lane existed so a stop could preempt a start blocked inside the ordered
lane. Post-`02fa14e2b` the canonical realtime start is admission-based: `engine.start`
records the command and returns; network/ICE work runs on the engine IO executors, not in
the binder body. VERIFY this by reading the current `dispatchVoiceRuntime` StartRealtime
path and `VoiceRuntimeRealtimeEngine.start` — confirm no network call, no `.get()`, no
latch-wait executes inside the submitted body. The legacy ui-attached
`prepareRealtimeSession` (:598) DOES perform ICE-complete offer creation in its body; it
is production-unreachable on Android (autonomous execution model) and its stop
(`stopRealtimeSession` :657) rides the same FIFO — acceptable and documented, deleted at
M5. If verification finds ANY canonical-path blocking in a submitted body, STOP and
report rather than shipping a stop-latency regression.

## Forbidden

- Implementing the reducer, KernelState, effects, epoch checking, or driver extraction
  (M2-M4). The mailbox executes legacy closures, period.
- Removing `operationLock` or changing any locked body's logic beyond wrapping it.
- Touching the 51 broad `mainHandler` post sites, the 8 executors, engine internals,
  stores, or any TS beyond nothing (no TS changes this milestone; `nativeRevision` stays
  15 — no bridge shape changes).
- Deleting binder-generation stamps or reconnect replay (M4).

## Verification

1. `grep -rn "binderInterruptThread\|binderInterruptHandler\|T3VoiceBinderOperationLane\b\|StopTombstone\|stopSequences\|pruneStopRegistrations\|coversEarlierActivation" apps/mobile/modules/t3-voice` → zero.
2. `grep -rn "synchronized(operationLock)" T3VoiceRuntimeService.kt | wc -l` unchanged ±0
   from base for non-ingress sites; every binder/host ingress body now enters via
   `mailbox.submit` (list the submission count in the commit message).
3. `pnpm run typecheck` + `pnpm run lint:mobile` green (TS untouched — prove it).
4. New unit tests: mailbox FIFO ordering under concurrent submit; submitDelayed
   cancellation; watchdog threshold entry; onStartCommand arms produce the right
   HostIntent kinds (pure mapping test); module dispatcher single-lane
   registration/settlement/replay still covered by the surviving
   `T3VoiceBinderOperationDispatcherTest` cases (rewrite the lane/tombstone cases as
   deletions, keep generation/replay cases).
5. Commit message: the Safety-argument verification result (what you read, what you
   found), submission-site count, deletion inventory.

## Done criteria

One or two commits, subject `feat(voice): route runtime ingress through kernel mailbox`;
tree clean; then orchestrator-owned pc gate (module tests + androidTest compile) — note
`T3VoiceRuntimeServiceInstrumentedTest` exercises binder start/stop across rebind and must
still pass unmodified (it is a consumer of the reshaped module surface only if lanes leak
into its API — they must not).

# M1 — Mailbox Ingress (rev 2, review-integrated)

First kernel milestone of `specs/native-voice-runtime-kernel.md`. Introduces the kernel
thread and mailbox, routes ingress through it, deletes the module INTERRUPT lane and stop
tombstones — WITH a mandatory offload pre-step, because the original safety assumption was
disproven: `engine.start` blocks on `server.start` HTTP inline (engine :543 → gateway →
`execute()`, 5s connect + 30s read timeouts). Commit `02fa14e2b` moved only `peer.prepare`.
Line refs are against the post-M0 tree.

## Step 0 — offload pre-step (do FIRST, separate commit)

Mirror the pattern `startCanonicalRealtimeLocked` already uses
(`T3VoiceRuntimeService.kt:4864`, `voiceRuntimeRealtimeStartIo.submit { engine.start }`) at
the binder arms that currently call blocking engine methods inline:

- `dispatchVoiceRuntime.StartRealtime` (~:909): compute admission synchronously
  (ledger/fence — no network), then offload the `engine.start` call to
  `voiceRuntimeRealtimeStartIo`. The command receipt is the admission result; the start
  outcome already flows through engine state events (exactly as the notification path
  behaves today).
- `dispatchVoiceRuntime.UpdateRealtimeFocus` (~:955-961) and
  `DecideRealtimeConfirmation` (~:982-991): offload their `engine.*` bodies (which call
  `server.updateFocus`/`server.acknowledgeAction`) to `voiceRuntimeRealtimeControlIo`.
- `acknowledgeVoiceRuntimePresentationAction` (~:1018-1055): same offload for its
  `engine.acknowledgePresentationAction` call; the binder return value must not depend on
  the offloaded network result (verify what it returns; if it currently returns a value
  derived from the server call, return the locally-known acknowledgement state — the
  server result reconciles via events).

Verified nonblocking already (no offload needed): thread-mode Start/Resume/Finish/Cancel
via `voiceRuntimeController.dispatch`, realtime `StopMode` (`engine.stop` marks shutdown,
defers `server.close` to `remoteDispatcher`).

## Step 1 — `VoiceKernelMailbox` (new file)

Single `HandlerThread("t3-voice-kernel")` + ordered queue. API:

- `submit(message: VoiceKernelMessage, body: () -> Unit)`
- `submitAndAwait(message, body: () -> T): T` — for value-returning binder methods
  (receipt/lease/snapshot/read results consumed synchronously by the module, e.g.
  `dispatchVoiceRuntime`'s receipt read at `T3VoiceModule.kt:430`). Binder handler threads
  may block awaiting; assert the kernel thread itself never calls it.
- `submitDelayed(message, delayMillis, body)` returning a cancellation token.
- `assertKernelThread()`, `drainAndQuit()` for `onDestroy`.
- Watchdog: diagnostic-ring entry when a body exceeds 250 ms (post-Step-0, sustained
  entries indicate a missed blocking path — investigate, don't ignore).
  The `message` is diagnostic metadata for M1; bodies are legacy closures still taking
  `operationLock` internally. No reducer, no KernelState, no effects.

## Step 2 — binder ingress

Lock-taking `VoiceBinder` methods (the ~33 `synchronized(operationLock)` bodies plus the
two piecewise dispatchers `dispatchVoiceRuntime` :872 and
`acknowledgeVoiceRuntimePresentationAction` :1018) route through the mailbox:
value-returning ones via `submitAndAwait`, fire-and-forget ones via `submit`. Pure reads
that take no lock (flow getters :137-155, `acknowledgeRecordingTermination` :454,
`enqueuePlaybackChunk` :566, etc.) stay direct. Each piecewise dispatcher becomes ONE
submission; after Step 0 their bodies contain no blocking network work.

## Step 3 — host ingress

`onStartCommand` (:2061-2101): six arms become `mailbox.submit(HostIntent(...))`. TWO
EXCEPTIONS run synchronously in place because the sticky return depends on state they
mutate: `ACTION_DISABLE_READINESS` (mutates `readinessConfig` via
`disableReadinessLocked` :1665-region) and `ACTION_READINESS` (reassigns it in
`reconcileReadinessLocked`), plus the `else` branch (`stopSelf` decision). The
`START_STICKY` computation (:2097-2101) reads `readinessConfig` — it must see those arms'
mutations. MediaSession callbacks (:5318-5357) including the `onMediaButtonEvent`
mainHandler hop (:5335): submit `HostIntent` instead of posting/locking directly.

## Step 4 — module lane collapse (`T3VoiceModule.kt`)

DELETE precisely:

- INTERRUPT thread/handler decls :33-34; teardown lines :251 and :253 ONLY (:252 is the
  ORDERED thread's `quitSafely` — KEEP).
- Lane enum + ordering types + policy: :1371-1388 and :1394-1421 (this includes
  `T3VoiceBinderOrderingRetention` :1394-1397). KEEP `T3VoiceBinderOperationAdmission`
  :1390-1392.
- Tombstone machinery inside `T3VoiceBinderOperationDispatcher` (:1424-1595):
  `StopPostingState`, `StopTombstone`, `stopSequences`, the INTERRUPT post branch, Stop
  register/admit arms, `finishActivation` cancellation eval, `coversEarlierActivation`,
  `pruneStopRegistrations`, `markAccepted` Stop logic, `rollback` Stop arm, and the test
  hook `retainedOrderingCounts` (:1589-1594). The class shrinks to single-lane
  registration/settlement.
- `PendingBinderOperation.lane`/.`ordering` fields (:56-57); KEEP :64-102 (ticket,
  binderGeneration, connected/replay). Update `withBinder`/`withBinderAdmission`
  signatures (:1056-1077, drop lane/ordering params), `scheduleBinderOperation`
  (:1127-1169, drop the :1133-1134 lane/ordering reads), the dispatcher constructor
  (:35-39, drop `interruptPost`), and the lane arguments at `stopRealtimeSessionAsync`
  :913-921, `drainAndStopRealtimeSessionAsync` :923-932, `dispatchVoiceRuntimeAsync`
  :421-431.
- Binder-generation stamps and reconnect replay are KEPT (M4 territory).

## Forbidden

Reducer/KernelState/effects/epoch implementation; removing `operationLock`; touching the
51 broad mainHandler sites, the 8 executors beyond Step 0's submissions, stores, engine
internals beyond the offload seams; any TS change (`nativeRevision` stays 15).

## Verification

1. `grep -rn "binderInterruptThread\|binderInterruptHandler\|T3VoiceBinderOperationLane\b\|T3VoiceBinderOperationOrdering\|T3VoiceBinderOperationLanePolicy\|T3VoiceBinderOperationFence\|T3VoiceBinderOrderingRetention\|retainedOrderingCounts\|StopTombstone\|stopSequences\|pruneStopRegistrations\|coversEarlierActivation\|interruptPost" apps/mobile/modules/t3-voice` → zero.
2. Every submitted binder/host body enters via mailbox (count submissions in commit
   message); non-ingress `synchronized(operationLock)` sites unchanged.
3. `pnpm run typecheck` + `pnpm run lint:mobile` green (no TS changes — prove it).
4. Tests: mailbox FIFO/submitAndAwait/delayed-cancel/watchdog units; HostIntent mapping;
   Step-0 offload — receipt independent of network result (fake engine/server per existing
   idioms). `T3VoiceBinderOperationDispatcherTest`: its 14 cases are ALL lane/tombstone
   cases — delete/rewrite; only `ordinaryOperationsRemainOrdered` survives (single-lane);
   generation/replay coverage lives in `T3VoiceBinderOperationRegistryTest` (unaffected —
   verify it still compiles against the reshaped `PendingBinderOperation`).
5. Commit message: offload seams changed, submission count, deletion inventory.

## Done criteria

Two commits (Step 0; Steps 1-4), subjects `fix(voice): offload blocking engine calls from
binder arms` and `feat(voice): route runtime ingress through kernel mailbox`; tree clean;
orchestrator-owned pc gate after park (module tests + androidTest compile —
`T3VoiceRuntimeServiceInstrumentedTest` must pass unmodified).

# M2 — State Capture (operationLock deletion)

Riskiest milestone of `specs/native-voice-runtime-kernel.md`. Moves every remaining
callback onto the `VoiceKernelMailbox`, then deletes `operationLock`,
`T3VoiceForegroundReleaseCoordinator`, and `serviceDestroyed`. After this milestone one
thread owns all runtime state. Line refs against `feature/voice-kernel-m1` HEAD
`6a711e6c8` (service = 5730 lines; 116 lock sites, ~55 already on the kernel thread via
M1's ingress routing).

## Step 0 — foreground fast path + cached stickiness (separate commit, do FIRST)

M1 put `reconcileStartCommand` → `startForeground` behind the mailbox; under congestion
that risks Android's 5s `startForegroundService` deadline. Fix:

- In `onStartCommand`'s `ACTION_START_*` arms, perform foreground promotion
  SYNCHRONOUSLY on the main thread (the `startRuntimeForeground` :2304 /
  `ensureRuntimeForeground` :2339 fast path, using the intent's own operation identity)
  BEFORE submitting the rest of the arm's body to the mailbox. Drop the
  `Thread.holdsLock` assert at :2340 (replaced in Step 3).
- Replace the main-thread `synchronized` stickiness read (:2236-2242) with a
  `@Volatile` cached stickiness value published by the kernel whenever
  `readinessConfig` changes; `onStartCommand` returns from the cache. Route the
  remaining synchronous arms (`ACTION_DISABLE_READINESS` :2192, `ACTION_READINESS`
  :2193, else :2232) through the mailbox now that the return no longer needs their
  synchronous effect (the cache updates when their bodies run; a one-intent stale
  stickiness window is acceptable — document it).

## Step 1 — move the direct-lock callback entries (the work list)

Every entry below wraps its existing locked body in `mailbox.submit` (drop the inner
`synchronized` at the same time — Step 3 deletes the lock; keeping both briefly is fine
if it simplifies review, but the final tree has no lock). Foreign-thread preludes
(`serviceDestroyed` checks) become nothing — teardown is ordered by `drainAndQuit`.

- Recorder termination :1918 (constructed with `terminalLock = operationLock` :1917 —
  the recorder's coordinator param becomes unnecessary; adjust construction).
- PCM player onFinished :1998, onError :2036; playback focus :2047/:2055/:2063.
- WebRTC onStateChanged :1253 and onTerminated :1297 (drop their mainHandler hops).
- Cue completions :1366, :1382, :1425, :1468, :1536.
- Thread-mode IO completions and retries (all currently `mainHandler` hops):
  :2583, :2620, :2658, :2856, :2880, :2945, :2960, :3012, :3022, :3178, :3206, :3247,
  :3269, :3307, :3341, :3361, :3461, :3558, :3601, :3799, :3820, :3837.
- Realtime periodic tasks: :4783, :4801, :4811, :4821, :4837, :4560, :4568, :4103 —
  `postDelayed` sites use `submitDelayed`; the `removeCallbacks` sites (:3636, :4854-56,
  :4863) use the returned cancellation tokens.
- M1 offload completions: :985 (start-complete), :1081 (onAcknowledged).
- Handoff coordinator: prepare :4245 / rollback :4257 become
  inline-if-kernel-else-`submitAndAwait` (they return values synchronously to the
  engine); activate :4345 keeps its bounded await but waits on a mailbox submission
  token instead of `mainHandler` + `CountDownLatch` (:4332-4365); expiry :552 →
  `submitDelayed`.
- Handoff protect-window expiry :550-552.

Engine sinks (:3947-4014) — the discriminator changes from `Thread.holdsLock` to
"on kernel thread":

- `presentationSink.publish/retract` (:3951/:3962, synchronous return values):
  inline-if-kernel-thread, else `submitAndAwait`.
- `stateSink` (:3971) / `terminalSink` (:3994): inline-if-kernel-thread, else `submit`.
- `finalizationSink` (:4004): always `submit` (preserves the never-re-enter-engine rule,
  comment :4012).

## Step 2 — relocate the three lock-free mutations

- `T3VoiceStateStore.setRealtime` :1245 (WebRTC thread): move inside the submitted
  onStateChanged body. The store slot claim shifts a few ms later; acceptable and
  documented (end-state-first).
- `nextCueGeneration` :4205/:4213 (`realtimeCuePort.ready/ended`, engine threads): the
  port bodies submit to the mailbox; generation bumps happen only on the kernel thread.
- `keepServiceStarted` :4157 (`realtimePeerPort.prepare`, engine thread): submit.

## Step 3 — delete the lock, the flag, the coordinator; add the assertion

- Delete `operationLock` (:1221), every remaining `synchronized(operationLock)` block
  wrapper (bodies stay, braces go), `T3VoiceForegroundReleaseCoordinator` (the service
  keeps its idle-only release RULE as plain kernel-thread code; the class + embedded
  lock + `Thread.holdsLock` asserts :37/:43/:2340/:2391 die).
- Delete `serviceDestroyed` (:1204), all ~57 read sites, and the :2247-2248 teardown
  write — `onDestroy` orders shutdown via `mailbox.drainAndQuit()` FIRST (already the
  case), then executor shutdowns.
- Add the ownership assertion: `mailbox.assertKernelThread()` at the top of every
  formerly-`*Locked` state-mutating function that survives as a plain function (pick the
  ~15 highest-traffic ones: ensureRuntimeForeground, startRuntimeThreadLocked,
  terminateRecording/Playback paths, applyRuntimeEvent, engine install/finalization,
  readiness reconcile, notification surface update). Debug-only cost is fine; keep them
  permanent.
- Bonus deletion (verified dead): `VoiceRuntimeControlHeartbeat` class in
  `VoiceRuntimeControl.kt:257` region + its `VoiceRuntimeControlTest` heartbeat cases —
  zero references outside its own file. Delete class + tests; keep the file's surviving
  lease/policy types.

## Forbidden

Reducer/effects/epoch implementation (M3/M4); touching the 8 IO executors' existence
(their completions merely re-enter via mailbox now); any TS change; deleting
`T3VoiceSessionIdTombstones` (M3+); weakening the instrumented test.

## Verification

1. `grep -rn "operationLock\|foregroundReleaseCoordinator\|T3VoiceForegroundReleaseCoordinator\|serviceDestroyed\|holdsLock" apps/mobile/modules/t3-voice` → zero.
2. `grep -rn "mainHandler" T3VoiceRuntimeService.kt` → zero dispatch sites (delete the
   field if nothing needs the main thread; if MediaSession creation genuinely requires
   it, list the survivors with one-line reasons — expected: none or one).
3. `grep -rn "synchronized(" apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/T3VoiceRuntimeService.kt` → zero.
4. `grep -c "assertKernelThread" T3VoiceRuntimeService.kt` ≥ 15.
5. `grep -rn "VoiceRuntimeControlHeartbeat" apps/mobile/modules/t3-voice` → zero.
6. `pnpm run typecheck` + `pnpm run lint:mobile` green (no TS).
7. Tests: existing unit tests must compile (recorder coordinator construction change
   touches `T3VoiceRecordingTerminalPolicyTest` fixtures — adjust mechanically);
   mailbox-token cancellation replaces removeCallbacks coverage; cached-stickiness unit
   test (readiness change → cache update); sink discriminator tests (kernel-thread
   inline vs foreign-thread submit) using the mailbox with a test looper per existing
   idioms.
8. Commit message: per-step inventory, the count of moved callbacks (expect ~45+ sites),
   survivors with reasons.

## Done criteria

Commits: Step 0 (`fix(voice): promote foreground synchronously with cached stickiness`),
Steps 1-2 (`feat(voice): capture all runtime state onto the kernel thread`), Step 3
(`feat(voice): delete operationLock and serviceDestroyed`). Tree clean; pc gate follows
(module tests + androidTest compile; `T3VoiceRuntimeServiceInstrumentedTest` unmodified
and passing).

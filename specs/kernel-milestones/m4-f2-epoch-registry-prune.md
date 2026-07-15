# M4-F2 — Epoch Registry Prune (boundedness fix)

Fix round for M4 adjudication finding F2 (LOW, boundedness): `VoiceKernelEpochRegistry.entries`
grew one entry per distinct rootOperationId and was never pruned — unbounded over a
long-running foreground service (one entry per thread turn, cue, timer schedule, recording,
playback, realtime session). Base: `5a765febf` on `feature/voice-kernel-m1`. Implemented
directly by the orchestrator (Kevin's call: small fix, no codex run); adversarially reviewed
post-hoc like every milestone. The seam analysis that produced this design found the
originally-signaled fix ("retire after terminal admission") would have been BOTH unsafe and
ineffective; the record of why is kept here because M5/M6 touch the same seams.

## Why the naive design was wrong (seam-map findings)

1. **Ordinal-reset hole.** `arm()` continued `attemptOrdinal` per-root. Deleting an entry
   and re-arming the same root would restart at 1, so a late result stamped by the retired
   life could pass all four `admit` equality checks — reintroducing the race class M4
   closed. Fix: a registry-global monotonic `nextAttemptOrdinal` makes every armed life
   globally unique. No test asserts literal/dense ordinals; `attemptOrdinal` doubles as the
   cue-coordinator generation, which requires only >0 and strictly-increasing — both hold.
2. **Retire-after-terminal is a no-op at the sites that matter.** The teardown paths
   already fence-bump re-arm the same roots (recording/playback teardowns, thread stop,
   drain, mode cancel) purely to stale-out late results. The entry that leaks is the
   RE-ARMED one. So retire must REPLACE those fence re-arms, not follow the terminal:
   deletion fences identically (late results drop `ROOT_OPERATION`-stale at admission,
   diagnostic dimension changes from ATTEMPT) and reclaims the entry.
3. **Two leaks beyond the registry.** (a) Cancelled timers never produce a result, so no
   result-driven retire can reclaim them — the schedule wrapper must retire on cancel.
   (b) `VoiceMediaDriver`'s `recordingEpochs`/`playbackEpochs`/`realtimeEpochs` maps were
   never pruned either.
4. **Key collision.** REALTIME_MODE and the canonical REALTIME_PEER share one registry key
   (`modeSessionId`) because entries are keyed by rootOperationId alone; `Entry.kind` flips
   per arm. Peer terminals must therefore never retire that key; it is reclaimed only when
   the checkpoint's modeSessionId transitions.
5. **Non-terminals that look terminal.** Seven thread receipt-failure sites null
   `runtimeThreadAttempt` and schedule a restore that re-arms the SAME clientOperationId —
   retiring there would drop in-flight results that are admitted today. Only the six
   genuine terminal sites retire. SERVICE roots don't leak at all (one per process;
   `runtimeInstanceId` never changes within a controller's life).

## As-built changes

**`VoiceKernelEpoch.kt` — registry:**

- `nextAttemptOrdinal` (starts 1, `++` per arm) replaces per-root continuation; `nextOrdinal` deleted.
- `retire(epoch)` — compare-and-delete: removes the root's entry only if it still holds
  exactly that epoch. Order-independent w.r.t. continuations that re-arm the same root.
- `size()` for tests.

**`VoiceMediaDriver.kt`:**

- `epochFor` is nullable; an unarmed/disarmed id's callback is dropped at the driver
  boundary with a KERNEL/STALE_DRIVER_RESULT diagnostic (ROOT_OPERATION encoding) instead
  of the previous `checkNotNull` crash-on-miss.
- `disarmRecording/disarmPlayback/disarmRealtime` (plain key removal; `playbackFocusEpoch`
  stays — single bounded slot).

**`T3VoiceRuntimeService.kt` retire sites:**

- RECORDING/PLAYBACK: `releaseRecordingLocked`/`terminateRecordingLocked`/
  `releasePlaybackLocked`/`terminatePlaybackLocked` — fence re-arm replaced by
  retire-current + media disarm. Start-site arms (recording start, playback start) unchanged.
- THREAD_TURN: `retireThreadTurnEpoch` helper at the six genuine terminals: revocation
  acknowledge clearDerived, finish-if-drained, fence-for-reconciliation, clean stop
  (post-fence re-arm), cancel COMPLETE, canonical-recovery-required. The seven
  restore-path null sites deliberately untouched.
- TIMER: `scheduleTick` retires the tick epoch after the fired continuation
  (compare-and-delete makes re-scheduling loops like heartbeat/actions a no-op) and on
  successful `cancel()` (kernel-thread-guarded; all five current cancel sites are
  kernel-thread).
- CUE: retired in `handleDriverResult` after an admitted `CueCompleted` dispatch. The
  `admitCueTerminal` once-latch stays (unchanged exactly-once); post-retire duplicates now
  drop as `STALE_DRIVER_RESULT(ROOT_OPERATION)` rather than `DUPLICATE_CUE_TERMINAL`
  (nothing asserts the latter).
- REALTIME legacy (nativeSessionId roots): retired at the end of the non-canonical
  `handleRealtimeTerminatedLocked` branch and in `drainRealtimeForStopLocked`'s
  drain-completed continuation + throw path (all + media disarm). This surface is
  Android-unreachable and dies in M5; retires keep the interim bounded.
- REALTIME mode/canonical-peer (modeSessionId shared key): retired in
  `applyRealtimeReduction` when the applied reduction changes the checkpoint's
  modeSessionId (the single funnel every mode-session end passes through), before effect/
  output dispatch — ambient `driverEpoch()` can no longer resurrect the old root because
  the checkpoint is already gone/replaced.

## Invariants preserved

- One admission point (`VoiceKernelEpochPolicy.admit` in `handleDriverResult`); no new
  fencing state anywhere; policy and epoch data class untouched.
- A retired root's late results drop exactly like an unknown root's
  (`DropStale(ROOT_OPERATION)` → STALE_DRIVER_RESULT).
- Registry touched only on the kernel thread (cancel wrapper checks `isKernelThread()`).
- Known residuals (accepted): a continuation that throws mid-dispatch can strand its
  entry (kernel-thread exceptions are fatal today, so moot); a foreign-thread timer cancel
  leaves the entry until the same timerId re-arms (no such caller exists).

## Tests (`VoiceKernelEpochPolicyTest`)

CAS-retire semantics; re-armed root never reuses a retired life's ordinal (the hole in the
naive design); retire unknown root no-op; multi-kind no-growth over repeated rounds;
cue latch never admits after retirement. Existing suites unchanged — none assert literal
ordinals (verified by grep and by the seam-map).

## Done criteria

- Registry bounded by LIVE roots; media-driver maps bounded by live recordings/playbacks/
  realtime sessions.
- Adversarial Opus review of the full diff; pc gate green
  (module unit tests + androidTest compile + assembleRelease).

# M3 Run 1 — Driver Extraction

First of two M3 runs (`specs/native-voice-runtime-kernel.md` M3; run 2 converts the
realtime engine to a sub-reducer). READ `specs/kernel-milestones/m3-seam-map.md` FIRST —
it is the authoritative inventory with current line refs. This run extracts the four
drivers and deletes the eight executor fields. M2 already placed every callback body on
the mailbox; this run replaces the TRANSPORT (ad-hoc submits and executor hops) with typed
drivers and DriverResult dispatch — the bodies' logic is MOVED, not rewritten.

## Deliverables

### 1. `VoiceNetDriver` (new file)

Two lanes as the kernel spec prescribes:

- **thread-turn lane**: single thread; absorbs every `runtimeRealtimeIo` submission (8
  sites, seam map) and `runtimeThreadCancellationIo` (:3851).
- **realtime lane**: bounded pool of 3; absorbs heartbeatIo/actionIo/startIo/cleanupIo
  submissions and the two binder-offload posts. The controlIo NOTIFICATION re-entries
  (:1276, :1328, :4924, :4296) are ELIMINATED — they become plain `submitCallback`
  messages to the kernel with no intermediate executor; controlIo's genuine work
  (`setMuted` :5145, `stop` :5162) rides the realtime lane.
  API: `execute(label, lane, epochMeta) { blockingBody } -> posts result via provided
kernel callback`; long-poll support = the existing loop bodies resubmitted per B8's
  token-managed pattern (the loops themselves stay in the service for this run). All
  executors constructed/owned/shutdown by the driver; the eight service fields and their
  :2343-2350 shutdowns die.

### 2. `VoiceMediaDriver` (new file)

Owns construction and lifecycle of recorder, PCM player, playback focus, cue coordinator,
audio router, and the `T3VoiceWebRtcSession` facade (`realtime` field). The service's
onCreate constructs the driver (inside the existing B3 submitAndAwait); the driver's
callback wiring posts to the kernel exactly as the current `mailbox.submit` bodies do —
move those bodies into named kernel functions and have the driver reference them via a
narrow listener interface (NOT lambdas capturing service internals; the driver must be
constructible in tests with a fake listener). Release order in onDestroy unchanged, but
via `driver.release()`.

### 3. `VoiceStoreDriver` (new file, thin)

Owns a single store lane (one thread) for the EXPENSIVE Keystore writes only: authority
prepareTransition/configure/clear (:4326, :5059-5064, :5036) and session-credential
writes become `persist(label) { body } -> Persisted callback` submissions; their kernel
callers are refactored to the commit-point shape (persist -> on-Persisted continuation)
per the spec rule. Cheap SharedPreferences stores (readiness, threadOperation,
realtimeRepository, cueSettings) stay direct in kernel bodies THIS run (they are
single-digit ms; the watchdog will confirm). Stores remain internally synchronized and
WorkManager-shared — the driver adds a lane, not exclusivity.

### 4. `VoiceHostDriver` (new file)

Main-thread handler executing host effects: `setForeground(types, snapshot)` (absorbs
promoteForegroundOnMainThread as the template + startRuntimeForeground's startForeground
call), `notify(snapshot)`, `setWakeLock(on)`, `setMediaSession(model)` /
`releaseMediaSession`, `keepStarted(action, operationId)`, `stopSelfIfIdle(startId?)`.
Kernel-side decision functions keep their current names/policies and now emit host calls
through the driver. The onStartCommand main-thread fast path calls the driver directly
(same synchronous semantics as today, cold-start guard preserved).

### 5. Dispatch formalization

Introduce a service-level `handleDriverResult(result: VoiceKernelMessage.DriverResult)`
entry: drivers post results with `driver` + `resultKind` + a payload object; the handler
`when`s to the existing named kernel functions. Bind the effect/result payload types in
`VoiceKernelEffects.kt`/`VoiceKernelMessages.kt` ONLY for the shapes actually used this
run (no speculative payloads). Epoch fields may carry placeholder identity values this
run (M4 wires real epochs) — but the plumbing must thread them.

## Forbidden

- Touching `VoiceRuntimeRealtimeEngine.kt` beyond mechanical call-site updates (run 2).
- Changing any store's internal synchronization or the WorkManager sharing.
- Weakening B9: no new `submitAndAwait` paths; `runOnKernelThreadOrAwait` sinks unchanged.
- Behavioral changes to retry/backoff/long-poll timing; TS changes; nativeRevision.

## Verification

1. `grep -rn "voiceRuntimeRealtimeHeartbeatIo\|voiceRuntimeRealtimeActionIo\|voiceRuntimeRealtimeOfferIo\|voiceRuntimeRealtimeStartIo\|voiceRuntimeRealtimeCleanupIo\|voiceRuntimeRealtimeControlIo\|runtimeRealtimeIo\|runtimeThreadCancellationIo" apps/mobile/modules/t3-voice` → zero (fields and all hops gone).
2. `grep -c "Executors.newCachedThreadPool\|newSingleThreadExecutor" T3VoiceRuntimeService.kt` → zero (executors live only in drivers).
3. `pnpm run typecheck` + `pnpm run lint:mobile` green (no TS).
4. Driver unit tests with fake listeners/fakes per module idioms: net lane ordering +
   bounded concurrency; media driver constructible with fake listener; store lane
   persist→Persisted ordering; host driver effect recording (fake main handler).
5. Commit message: executor→lane mapping table, eliminated-hop list, moved-body count.

## Done criteria

Commits: `feat(voice): extract net and store drivers`, `feat(voice): extract media and
host drivers` (or one combined if cleaner); tree clean; pc gate follows.

## Review amendments (BINDING — supersede conflicting text above)

C1. **Hop reclassification**: eliminate to a direct kernel message ONLY the controlIo
:1276 hop (onPeerConnected — pure fact, no server call). The hops at :1328, :4924, :4296
and the offer callback (:4257) reach `completeShutdown → reconcileFinalization`
(synchronous `server.commitHandoff`/`handoff.activate`/`server.close`) or
`onOfferReady → server.offer` — synchronous network under the engine monitor. They MUST
ride the NetDriver realtime lane, never the kernel thread. offerIo is lane-absorbed, not
eliminated. Also: even for :1276, note that running engine entry on the kernel thread
flips stateSink to inline-under-monitor delivery — wrap the sink dispatch so deliveries
remain deferred via submitCallback regardless of calling thread (preserve today's
behavior).

C2. **NetDriver lanes revised**: thread-turn lane (sequential, unchanged) + realtime lane
bound **4** (action 25s long-poll + heartbeat + start/offer + cleanup) + a DEDICATED
control sub-lane of 1 (absorbs today's controlIo single thread: setMuted/stop/
peer-terminated/drain-deadline/cue-complete/controlPost) so stop latency and control FIFO
ordering are preserved exactly. Document the lane→consumer table in the driver kdoc.

C3. **StoreDriver scope narrowed**: convert to persist→Persisted ONLY the
fire-and-continue authority writes (the clear() sites NOT embedded in value-returning
awaits, e.g. :1692, :2184, :3739, :4721, :4810, :5523 — verify each caller shape before
converting). Authority writes embedded in `submitAndAwait`/`runOnKernelThreadOrAwait`
bodies that return values synchronously (:906, :4326, :4341, :5036-in-:5030-runCatching,
:5059-5064 controller configure, restoreCanonicalAuthorityLocked) STAY INLINE this run —
their conversion requires the engine/binder contract changes owned by run 2/M4. The
exception scoping of :5030's runCatching and the :5039 check() ordering must not change.

C4. **MediaDriver construction order**: construct the driver at the TOP of onCreate's B3
submitAndAwait body, BEFORE restoreCanonicalAuthorityLocked (:1930) — the engine ports
(:4000-4002) and the async cleanupIo recovery (:4160) dereference driver-owned objects.
Preserve the `realtime` lazy(SYNCHRONIZED) delegate semantics inside the driver (no eager
WebRTC/PeerConnectionFactory init). The resulting construction reorder (cueCoordinator/
recorder/player onto the kernel thread ahead of auth restore) is accepted; note it in the
commit message.

C5. **Token loops**: the heartbeat/action reschedule token dance
(`VoiceKernelReschedulePolicy.owns` at :4855/:4890/:4900) moves intact into the
`handleDriverResult` continuations — token captured at schedule, ownership-checked at
result, new token stored on reschedule. `VoiceRuntimeRealtimeBinderOffload`
(:1211-1214) is rewired to the driver lanes, not orphaned.

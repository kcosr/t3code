# Native Voice Runtime Kernel

Status: Proposed design specification.

This specification restructures the internal implementation of the Android voice runtime. It
amends the "Internal Android structure" section of `specs/native-voice-runtime-ownership.md`
(spec lines 290-324) and completes the direction that spec already states: "All release/start
sequences run on one serialized native command queue" and a pure `VoiceRuntimeReducer` owns
transitions and admission. Every externally visible contract is preserved unchanged: the
`packages/contracts/src/voiceRuntime.ts` schemas, protocol major 1, the server HTTP surface,
the `VoiceRuntime` client-runtime facade, the conformance fixtures, and the durable store
formats. This is an internal re-architecture, not a protocol change.

## Decision

Replace the lock-and-thread-pool implementation of `T3VoiceRuntimeService` with:

1. **One kernel.** A single-threaded runtime kernel owns every piece of mutable voice state.
   It consumes a totally ordered mailbox of messages and produces state transitions plus
   effect descriptions. No other code reads or writes runtime state.
2. **One mailbox.** Every input — binder commands, notification and media-button intents,
   WorkManager signals, WebRTC observer callbacks, HTTP completions, media terminals, audio
   focus and route changes, timer ticks — enters the kernel as a message. Ordering is queue
   arrival. There are no locks, no interrupt lane, and no direct callback mutation.
3. **Effects at the edges.** Blocking and platform work (media, network, durable stores, the
   Android host surface) runs in four drivers that execute effect descriptions and post
   results back as messages. Drivers never touch kernel state.
4. **One local staleness check.** The ~12 in-process generation/latch/tombstone families are
   replaced by a single per-attempt epoch stamped onto every effect and checked once at
   mailbox re-entry. Distributed and protocol-level fences (authority generations, command
   fence tuples, consumer leases, idempotency ledgers, persisted terminal fences, journal
   cursors) are retained exactly as contracted.
5. **A thin process host.** The Android `Service` shrinks to lifecycle ingress and host-effect
   execution: `startForeground`, notification rendering, wake lock, MediaSession, and
   self-start. It holds no policy and no runtime state.
6. **A reduced bridge.** The Expo module surface drops from 64 functions and 11 events to the
   canonical `VoiceRuntime` protocol plus bounded media, permissions, and diagnostics —
   roughly 36 functions and 6 events — by deleting the Android-unreachable ui-attached
   surface and converting the remaining sticky pending/ack pairs to the canonical retained
   record and completion-handle mechanisms the ownership spec already mandates.

## Motivation

The current implementation is empirically past its complexity budget:

- `T3VoiceRuntimeService.kt` is 6,293 lines with ~35 mutable fields and 114
  `synchronized(operationLock)` sections spanning twelve distinct concerns (binder command
  admission, device-callback re-entry, thread-mode IO completions, realtime engine sinks,
  handoff, lifecycle, notification routing, and more).
- Work is distributed across eight executors plus the main handler plus the heartbeat's own
  scheduled executor, all of which re-enter the same global lock at unpredictable points.
- The branch that unified runtime ownership required roughly 25 consecutive `fix(voice)`
  commits (`close native runtime recovery races`, `admit stop tombstones atomically`,
  `preserve runtime recovery fences`, `fence realtime shutdown callbacks`, ...). Each fix is
  the discovery of one more interleaving between a pool callback and the lock.
- The dominant pattern is already "blocking IO off-thread, then
  `mainHandler.post { synchronized(operationLock) { ... } }`" — a de facto partial mailbox.
  The races live in the exceptions: callbacks that take the lock directly on foreign threads
  (recorder at service:2158, player at :2238/:2276, presentation sink at :4181, handoff
  coordinator at :4475, MediaSession at :6078, every binder thread), three lock-free
  mutations (`T3VoiceStateStore.setRealtime` from the WebRTC thread at :1510,
  `nextCueGeneration` from engine threads at :4435/:4443, `keepServiceStarted` from an engine
  thread at :4387), and deliberate piecewise lock re-entry around engine calls
  (`dispatchVoiceRuntime` at :1227, presentation-action acknowledgement at :1373, the
  re-entrancy hazard documented at :4242).
- The recovery choreography in `onCreate` (service:1836-2325) is seventeen ordered live steps
  across five durable stores, covered by six tests, while the extracted realtime engine has
  forty. The highest-risk code has the thinnest coverage because it is structurally untestable.
- Dead weight has already accumulated: `executeRealtimeHandoff` (service:5489) and the
  `completionLock` it guards have no callers; `setReadinessSnapshotAsync` and both Bluetooth
  permission functions have no JS callers; the entire ui-attached bridge surface is
  unreachable on Android (see Bridge below).

Serializing the runtime does not remove any required behavior. It makes the ordering that the
lock was approximating a structural property, so the bug class this branch spent its tail
fixing cannot be expressed.

## Goals

- One thread owns all voice-runtime state; data races are impossible by construction.
- Recovery is a pure function with a fixture matrix, not seventeen live steps.
- The ~12 local fencing families are deleted and replaced by one epoch check.
- The `VoiceRuntime` conformance fixtures, contract round-trips, and all externally visible
  behavior (including notification/headset semantics and durable-record retention) pass
  unchanged.
- The kernel/driver decomposition is mirrorable by the future iOS adapter.
- Migration is a sequence of independently shippable milestones, each leaving exactly one
  enabled execution owner per operation path (ownership spec migration rule).

## Non-goals

- No change to server contracts, `voiceRuntime.ts` schemas, protocol major, grant/refresh
  semantics, or durable store schemas (Keystore ciphertext formats included).
- No change to the OpenAI provider, tools, or server-side session management.
- No new product behavior; Auto Listen, realtime, handoff, readiness, and dictation semantics
  are preserved.
- No iOS implementation in this workstream.
- No removal of the ui-attached TypeScript path in this workstream (it is dead only against
  the Android module; retiring the JS code is a separate cleanup).
- No coroutine-vs-thread religion: the kernel thread is a plain `HandlerThread`; Kotlin
  coroutines may be used inside drivers but the kernel loop itself is a message pump.

## Terminology

- **Kernel**: the single-threaded owner of all runtime state; runs the runtime reducer.
- **Mailbox**: the kernel's totally ordered message queue.
- **Message**: any input to the kernel (command, host intent, driver result, tick, recover).
- **Effect**: a data description of work the kernel wants performed (media, network, store,
  host, emit). Effects are values; they carry the issuing attempt's epoch.
- **Driver**: an executor of one effect family. Drivers own platform objects and threads,
  never state.
- **Attempt epoch**: the local staleness token `(runtimeInstanceId, authorityGeneration,
rootOperationId, attemptOrdinal)` stamped on effects and echoed by results.
- **Host**: the Android `Service` acting as process container and host-effect executor.

## Architecture

```text
 binder (Expo)      notification / media button      WorkManager       process start
      │                        │                          │                  │
      ▼                        ▼                          ▼                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                        MAILBOX (total order, unbounded*)                     │
 └───────────────────────────────────┬──────────────────────────────────────────┘
                                     ▼  one thread: "t3-voice-kernel"
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ VoiceRuntimeKernel                                                           │
 │   state  = KernelState (all former service fields)                          │
 │   reduce = (KernelState, Message) -> (KernelState, [Effect])                 │
 │   composed of: admission policy · media arbiter · thread-turn reducer        │
 │                · realtime reducer · readiness/authority reconciler           │
 └───────┬───────────────┬────────────────┬─────────────────┬───────────────────┘
         ▼               ▼                ▼                 ▼
   MediaDriver       NetDriver       StoreDriver        HostDriver
   recorder,         thread-turn     authority,         startForeground,
   PCM player,       lane +          readiness,         notification,
   cue player,       realtime        checkpoint,        wake lock,
   audio router,     lane,           operation,         MediaSession,
   WebRTC peer       long-polls      drafts, journal    keepServiceStarted
         │               │                │                 │
         └───────────────┴───── results as messages ────────┘
```

\* The mailbox is unbounded in type but bounded in practice by driver concurrency; see
Backpressure.

## The kernel

### State

`KernelState` is one immutable value (updated by copy on the kernel thread) aggregating every
mutable field the service holds today. Field-to-component mapping:

| Current service state (file:line)                                                                                                                                                             | Kernel component                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `recordingOwner`, `playbackOwner`, `pendingRecordingStart`, cue pairs, `nextCueGeneration`, `realtimeStopDrainSessionId` (service:1462-1478)                                                  | `MediaArbiterState` — single owner per resource, pending cue gates                                                       |
| `runtimeThreadAttempt` and its ~20 vars (VoiceRuntimeThreadExecution.kt:240-314), `voiceRuntimeThreadRearmTask`, `detachedThreadContinuationAdmission`, `runtimeSnapshot` (service:1439-1451) | `ThreadModeState` — the existing `VoiceRuntimeExecutionSnapshot` plus attempt bookkeeping as plain fields                |
| engine slot + checkpoint mirrors, heartbeat/action/drain/finalization task handles, handoff activation, finalization transition authority (service:1422-1450)                                 | `RealtimeState` — the engine state machine inlined as a reducer (see below); timer handles become tick registrations     |
| `readinessConfig`, `canonicalPreparedAuthority`, `cueSettings` (service:1440-1442)                                                                                                            | `AuthorityReadinessState`                                                                                                |
| `mediaSession`, `foregroundServiceTypes`, `wakeLock` presence (service:1453-1455)                                                                                                             | `HostState` — the kernel's _desired_ host posture; actual objects live in HostDriver                                     |
| `handoffInProgress` + legacy eligibility flags (service:1464-1468)                                                                                                                            | deleted with the legacy surface (Bridge below)                                                                           |
| `T3VoiceStateStore` singleton (T3VoiceState.kt:195)                                                                                                                                           | becomes a kernel-published read model (see Events)                                                                       |
| consumer registry, journal, presentation/draft stores inside `VoiceRuntimeActiveThreadController`                                                                                             | retained as kernel-owned components; the controller's public semantics (leases, election, cursors, rebase) are unchanged |

The `@Volatile serviceDestroyed` flag and every `=== attempt` / engine-identity re-check
disappear: destruction and replacement are themselves messages, so nothing can observe state
"after" teardown on another thread.

### Messages

```text
Command        — a bridge call: canonical VoiceRuntimeCommand dispatch, media call,
                 authority/readiness call, consumer attach/read/ack. Carries the caller's
                 completion handle (promise settle) and the command fence from contracts.
HostIntent     — onStartCommand actions (PRIMARY, STOP, TOGGLE_MUTE, DISABLE_READINESS,
                 READINESS, AUTHORITY_REFRESH_*, START_*), MediaSession button, boot recover.
DriverResult   — completion/progress/terminal from a driver, stamped with the issuing epoch:
                 net responses, long-poll deliveries, recorder terminal, playback drained,
                 cue done, focus change, route change, peer state change, playout drained.
Tick           — a scheduled timer firing: (timerId, epoch). Replaces every postDelayed
                 runnable-identity check (service:5020-5111, retry backoffs, rearm).
Recover        — synthesized once at kernel start from StoreDriver's loaded snapshot set.
```

Rules:

- Every message is processed to completion before the next; a reducer step performs no IO and
  no blocking call. Budget: steps are O(state size), microseconds to low milliseconds.
- Commands are admitted or rejected synchronously within their message: the receipt
  (`accepted | rejected | rebase-required`, `replayed`, cursor) is computed in-step and the
  binder promise settled via a completion effect. This preserves the contract requirement
  that `dispatch` returns a prompt admission receipt (contracts:721-741) — admission latency
  is queue latency, which the no-blocking rule bounds.
- The binder INTERRUPT lane (T3VoiceModule.kt:33-35) is deleted. It exists so `StopMode` can
  preempt a start blocked inside the ordered lane; in the kernel no message ever blocks, so a
  stop admits immediately and preemption becomes cancellation of the start's in-flight
  effects (see Cancellation). The stop-tombstone ordering machinery
  (T3VoiceModule.kt:1549-1719) collapses into mailbox ordering.
- OS-replayed inputs (sticky `ACTION_START_*` redelivery, stale media buttons) remain
  validated against current state at admission — the OS is a distributed peer and its
  messages can be stale (T3VoiceStartCommandPolicy semantics are kept as a reducer rule).

### Effects

Effects are pure data, stamped with the attempt epoch, executed by exactly one driver:

```text
Media:  StartRecording, StopRecording(reason), StartPlayback, EnqueuePcm, FinishPlayback,
        CancelPlayback, PlayCue(kind), PreparePeer, ApplyAnswer, SetMicEnabled, SetMuted,
        DrainPlayout, StopPeer, SetRoute, ObserveTimeout(kind, deadline)
Net:    ThreadTurnCall(kind, request), RealtimeCall(kind, request), StartLongPoll(kind),
        StopLongPoll(kind), Heartbeat, RefreshConfirm, CancelAll(scope)
Store:  Persist(record), Load(kind), Clear(fence)
Host:   SetForeground(types), RenderNotification(model), SetWakeLock(on/off),
        SetMediaSession(model), KeepStarted(action), StopSelfIfIdle
Local:  EmitEvent(journal append + consumer wake), SettleCommand(handle, receipt),
        ScheduleTick(timerId, delay), CancelTick(timerId)
```

Ordering guarantees:

- Effects emitted by one reducer step are dispatched in emission order; drivers within a lane
  execute their effects FIFO. Cross-driver ordering is not guaranteed and must not be relied
  on — where a durable write must precede an externally visible action, the reducer sequences
  it as two steps: `Persist` → (on `Persisted` result) → the action. This preserves the
  ownership spec's write-before-effect obligations: `highestStartedSegment` persisted before
  audible playback (spec:429-431) and the Keystore refresh candidate stored before the
  refresh request (spec:255-257). These persists are SharedPreferences/Keystore writes
  (single-digit milliseconds); the extra hop is acceptable and makes the ordering testable.
- `SetMicEnabled(false)` is additionally executed by MediaDriver on its fast path (a direct
  track toggle, no queue behind long media work) so "every terminal path disables the
  microphone track immediately" (spec:338) holds even if the media lane is mid-effect.

### Reducer composition

The kernel reducer is a composition of the machines that already exist:

- **Thread-turn**: `VoiceRuntimeExecutionReducer` (VoiceRuntimeExecutionReducer.kt) is used
  as-is; the ~25 pure policies in VoiceRuntimeThreadExecution.kt become reducer subroutines.
  The imperative glue in the service's 22 IO-completion lock sites becomes result-message
  handling.
- **Realtime**: `VoiceRuntimeRealtimeEngine` (VoiceRuntimeRealtimeEngine.kt:437) is refactored
  from a monitor-guarded object called from five thread pools into a pure sub-reducer over
  `RealtimeState`. Its ports (`VoiceRuntimeRealtimeServer`, `VoiceRuntimeRealtimePeer`, cue,
  sinks) become effect emissions; its existing admission ledger, pendingStart dedupe, and
  finalization gates are kept verbatim as reducer rules. The engine slot's staged
  install/deferred-refresh-swap (VoiceRuntimeRealtimeEngineSlot.kt) is kept as reducer logic;
  its slot-version CAS is deleted (single thread), while `requireForwardRefresh` /
  `validateReplacement` monotonicity — which encode distributed authority rules — are kept.
- **Media arbiter**: the owner-domain admission currently spread across
  `T3VoiceStateStore` phase claims, `T3VoiceOperationOwner` checks, and the interruption
  matrix (ownership spec:539-557) becomes one arbiter table in the reducer.
- **Authority/readiness**: the reconciliation policies (`T3VoiceCanonicalReadinessPolicy`,
  `VoiceRuntimeCommittedReadinessPolicy`, `T3VoiceStartupAuthorityFencePolicy`, refresh
  admission) are already pure; they become subroutines of `Recover` and the
  `AUTHORITY_REFRESH_*` / readiness message handlers.
- **Idempotency**: the command ledgers (VoiceRuntimeJournal.kt:76-104, engine ledger,
  controller ledger, authority provisioning ledger) are retained unchanged. Epochs cannot
  replace them: a JS retry of the same `commandId` within one epoch must return the stored
  outcome, and a same-ID-different-fingerprint call must return `idempotency-conflict`
  (fake:105-118 semantics).

## Drivers

### MediaDriver

Owns the recorder, PCM player, cue player, audio router, and `T3VoiceWebRtcSession`, plus
their internal threads (endpoint HandlerThread, AudioTrack write worker, WebRTC signaling
threads — these are library-owned and cannot be removed). The driver's job is to translate
effects into calls on those objects and translate their callbacks into `DriverResult`
messages. Rules:

- Callbacks never mutate runtime state and never take a lock shared with the kernel; they
  post messages. The recorder terminal coordinator, player identity checks, ADM audio-owner
  policy, router generations, cue generation admission, timeout owner tokens, session-ID
  single-active guards, and the terminal latch (fencing inventory #6, #8-#14, #27, #28) are
  all deleted: their job — "did the world change while I was away?" — is done once by the
  kernel's epoch check on the resulting message.
- Live-object check-then-act (reading `peerConnection.connectionState()` inside a timeout
  decision, verifying track state after set — T3VoiceWebRtcSession.kt:799-811, :994-1002)
  stays inside the driver as part of effect execution: the kernel asks for
  `ObserveTimeout(connecting, deadline)`, the driver evaluates the live object when the
  deadline fires and posts the fact. Kernel state never mirrors live WebRTC internals; it
  reacts to reported facts. Disposal ordering relative to in-flight observer callbacks is the
  driver's responsibility (dispose on its own thread after detaching observers), which is the
  same discipline `T3VoiceWebRtcSession` applies today, minus the cross-layer fences.
- The session-ID tombstone check (T3VoiceSessionIdTombstones.kt) survives only as bridge
  input validation on the legacy-free surface: native session IDs are kernel-minted after
  this redesign, so reuse cannot occur; the check becomes an assertion.

### NetDriver

Replaces the five cached realtime pools, `voiceRuntimeRealtimeControlIo`,
`runtimeRealtimeIo`, `runtimeThreadCancellationIo`, and the heartbeat's private scheduler
(service:1429-1446, VoiceRuntimeControl.kt:286) with two lanes:

- **Thread-turn lane** (sequential): create, upload, disposition, events long-poll, ack,
  draft fetch/consume, cancel, speech segment streaming. Sequential execution preserves the
  current single-thread ordering of `runtimeRealtimeIo`.
- **Realtime lane** (small bounded concurrency): start, offer, heartbeat, action long-poll,
  focus, handoff exchange/commit, close, cleanup retries. Bounded at the number of
  legitimately concurrent calls (heartbeat + action poll + one control call), not "cached".

All calls run on the existing `VoiceRuntimeHttpTransport` and remain cancellable via
`HttpsURLConnection.disconnect` (VoiceRuntimeHttp.kt:237-240). Long-polls are persistent
effects: `StartLongPoll(actions)` emits a result message per delivery and terminates on
`StopLongPoll` or epoch cancellation. Speech segment streaming pipes directly from the HTTP
response into MediaDriver's playback queue under the existing bounded-buffer limits — bulk
PCM does not transit the mailbox; only progress/terminal facts do.

### StoreDriver

Owns `VoiceRuntimeAuthorityStore`, `T3VoiceReadinessStore`, the checkpoint repository, the
thread-operation store, draft/journal durable repositories, and the recording cache sweep.
Two properties are deliberate:

- Stores remain internally `@Synchronized` and are **not** kernel-exclusive, because
  `VoiceRuntimeAuthorityRefreshWorker` reads and writes the authority and readiness stores
  from the WorkManager process context while the service may be dead
  (VoiceRuntimeAuthorityRefreshWorker.kt:20-139). The worker's admission re-checks, unique
  work, rotation counters, and wire fence echo (fencing inventory #18, #19, #30) are
  distributed mechanisms and are retained unchanged. The worker communicates with a live
  kernel exactly as today: `ACTION_AUTHORITY_REFRESH_*` intents, which become messages.
- Commit-point writes (checkpoint promotion, authority activation, operation claims, segment
  counters) are `Persist` effects sequenced before dependent actions as described under
  Effects. Persisted fences that dedupe terminals across process death
  (VoiceRuntimeRealtimeEngine.kt:185-198 clear/installFinalization semantics,
  cancelled-start finalization at :559-563) are retained: the in-memory latch dies, the
  durable fence does not.

### HostDriver

Runs on the main thread (Android requires it) and executes host effects only:
`startForeground` with the kernel-computed type set, notification render from a kernel-built
model, wake-lock set/clear, MediaSession activation and playback-state mirror,
`keepServiceStarted`, `stopSelfIfIdle`. All decisions stay in the reducer using the existing
pure policies (`T3VoiceForegroundLifecyclePolicy`, `VoiceRuntimeWakeLockPolicy`,
`T3VoiceForegroundReleaseCoordinator`'s idle-only rule becomes a reducer invariant). The
coordinator class and its embedded lock are deleted.

### Cancellation and preemption

Replaces the interrupt lane and the stop-tombstone dispatcher (hard case A):

1. A stop/replace command admits in its message step (never blocked).
2. The reducer bumps the attempt epoch for the affected root operation and emits
   `CancelAll(scope)` — drivers abort in-flight work for that epoch (`disconnect()` for HTTP,
   recorder/player cancel, peer close), plus the immediate `SetMicEnabled(false)` fast path.
3. Results from the cancelled attempt still arrive but carry the old epoch and are dropped at
   admission — in one place, with one diagnostic code, instead of thirty call-site checks.
4. Where the ownership spec requires converting a cancelled start into a server-side
   finalization instead of leaking a session (engine :552-567), that rule is a reducer
   transition on the stale result, not a discard: staleness handling is a reducer decision,
   and "drop" is merely the default.

### Backpressure

Replaces the blocking producer semantics of `enqueuePcmBlocking` (hard case D). Today a
binder lane blocks in `lock.wait` when the PCM queue is full (T3VoicePcmPlayer.kt:146-151).
In the kernel model no binder call may block on media, so:

- `EnqueuePcm` admits against the existing bounded queue limits (`T3VoicePcmLimits`) and
  returns `accepted` or `queue-full` in the receipt; JS already paces on
  `playbackChunkConsumed` credits, so a full queue is a protocol error today and remains one.
- Server-driven speech (thread-turn segments) never crosses the bridge; NetDriver→MediaDriver
  piping applies the same bounded buffer with pull-based reads, preserving the "bounded
  backpressure, no unbounded buffering" requirement (ownership spec:454-455).

## Fencing model

### Retained (distributed / protocol)

These are contracted behavior or fence real distributed peers and survive unchanged:

| Mechanism                                                                                                                                                                                               | Why it stays                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Command fence tuple `(commandId, runtimeId, runtimeInstanceId, authorityGeneration)` with distinct rejection reasons and rebase reasons (contracts:586-612, 707-719)                                    | Externally visible protocol; conformance asserts the distinct outcomes                 |
| Idempotency ledgers + canonical fingerprints (journal:76-104, engine:459, controller, authority provisioning)                                                                                           | JS retries within one epoch must replay stored outcomes                                |
| Consumer leases, attach ordinals, election, ack lease+cursor fencing (VoiceRuntimeConsumers.kt, contracts:136-161)                                                                                      | Fences consumers, not operations; part of the contract                                 |
| Authority generation CAS, floor, rotation counters, Locked fail-closed state, refresh wire echo (VoiceRuntimeAuthority.kt:31-91, VoiceRuntimeAuthorityStore.kt, VoiceRuntimeAuthorityRefresh.kt:73-105) | Cross-device/server authority epoch; the WorkManager worker runs with the service dead |
| Persisted checkpoint/finalization fences and terminal dedupe across process death (VoiceRuntimeRealtimeEngine.kt:185-198, checkpoint store)                                                             | Process death is a distributed event                                                   |
| Journal cursor monotonicity and rebase (VoiceRuntimeJournal.kt:55-71, contracts:593-605)                                                                                                                | Contracted consumer protocol                                                           |
| Realtime child-session lease fences and heartbeat response echo validation (contracts:802-812, VoiceRuntimeControl.kt:74-127)                                                                           | Server-side protocol                                                                   |
| Stale `ACTION_START_*` validation (T3VoiceStartCommandPolicy) and media-button state derivation                                                                                                         | The OS replays stale inputs                                                            |
| Handoff transition capability with old-generation close-only validity (ownership spec:368-380)                                                                                                          | Mid-operation generation rotation is a protocol state, not a local race                |

### Deleted (local), replaced by the attempt epoch

Binder generation stamps and the operation registry's isActive re-checks; the binding
realtime-owner policy; the ORDERED/INTERRUPT lanes and stop tombstones; the realtime terminal
latch; connection-timeout owner tokens; the ADM audio-owner policy; audio-router owner
generations; the recording terminal policy and its coordinator; cue generation admission and
terminal CAS; PCM player identity/timeout-generation/release CAS (chunk-index validation
stays as input validation); state-store phase claims and owner guards; engine-slot version
CAS; runnable-identity task fencing; every `=== attempt` / engine-identity re-check;
`T3VoiceWebRtcSession`'s single-active identity guards and one-shot flags (absorbed by driver
ownership); `serviceDestroyed`. Roughly twelve mechanism families and their tests are
replaced by: _every effect carries an epoch; every result is checked once at admission_.

The epoch is `(runtimeInstanceId, authorityGeneration, rootOperationId, attemptOrdinal)`.
Including `runtimeInstanceId` satisfies the ownership spec's requirement that instance
replacement rejects stale cursors and late callbacks (spec:190-191, :711). Keying by
`rootOperationId` preserves the two-level mode/turn identity (contracts:246-259): a mode-stop
bumps the mode attempt, a turn retry bumps only the turn attempt.

## The process host

`T3VoiceRuntimeService` shrinks to approximately 300 lines:

- `onCreate`: start the kernel thread, hand StoreDriver the store handles, enqueue `Recover`.
- `onBind` / `onUnbind`: expose the binder facade (below); binding state is a message.
- `onStartCommand`: translate the intent action to a `HostIntent` message; return the
  stickiness the kernel last published (the kernel decides `START_STICKY` via the existing
  readiness policy and the host caches the answer — `onStartCommand` cannot wait).
- `onDestroy`: enqueue `Shutdown`, join the kernel briefly, drivers release their objects.
- Execute host effects delivered by HostDriver.

It retains no Activity, React context, module, or promise references (ownership spec:311-313
unchanged), and it contains no `synchronized` block.

## Bridge surface

### Evidence

The execution-model split (`voiceExecutionComposition.ts:3-5`) makes Android always
autonomous, and the native module exists only on Android (`expo-module.config.json`
platforms: android). Therefore every function whose only callers live in the ui-attached path
has **dead reachability in production** today. Audit results:

- Zero JS callers anywhere: `setReadinessSnapshotAsync`, `getBluetoothPermissionAsync`,
  `requestBluetoothPermissionAsync`.
- Unreachable on Android (ui-attached-only callers): all five legacy realtime functions
  (`prepareRealtimeSessionAsync`, `applyRealtimeAnswerAsync`, `stopRealtimeSessionAsync`,
  `drainAndStopRealtimeSessionAsync`, `setRealtimeMutedAsync`), the five handoff functions
  (`armThreadVoiceHandoffAsync`, `getPendingThreadVoiceHandoffAsync`,
  `acknowledgeThreadVoiceHandoffAsync`, `beginThreadVoiceHandoffAdoptionAsync`,
  `recordThreadVoiceHandoffClientStageAsync`), the voice-command pair
  (`getPendingVoiceCommandAsync`, `completeVoiceCommandAsync`),
  `registerVoiceControllerAsync`/`unregisterVoiceControllerAsync`, `setAudioRouteAsync`,
  `setVoiceCuesEnabledAsync`, `getMediaCapabilitiesAsync`; events `stateChanged`,
  `audioRouteChanged`, `realtimeTerminated`, `threadVoiceHandoff`, `voiceCommand`.

### Target surface

- **Keep — canonical protocol (19)**: describe, snapshot, prepare/inspect/configure/clear(+IfIdle)
  authority, disable readiness, attach/updateAttachment/detach, read/acknowledge,
  acknowledgeRetainedRecord, dispatch, draft read/ack, presentation action claim/ack,
  ownership. Event: `voiceRuntimeWake`.
- **Keep — media (9)**: recording start/stop/cancel/delete, playback
  start/enqueue/finish/cancel, `getAudioRoutesAsync`. Route _selection_ and cue enablement on
  the autonomous path are runtime commands (`set-audio-route` exists in the command union;
  cue preference travels with readiness/target configuration — open question below). Events:
  `playbackChunkConsumed`, `recordingTerminated`, `playbackTerminated`, `runtimeError`.
- **Keep — permissions/diagnostics (6)**: mic and notification get/request, `getStateAsync`,
  `getDiagnosticsAsync`.
- **Convert**: the two termination pending/ack groups. Composer-recording and
  manual-playback terminations become per-operation bridge completion handles (already
  required by ownership spec:318-324 — the sticky global slots are explicitly removed
  there). [M5 deviation, 2026-07-15] The readiness-disabled and authority-revocation
  notices are NOT converted: the retained-record protocol is a closed contracts-typed
  server-journal surface (the acknowledgement union and rebase struct enumerate exactly
  `thread-receipt` and `realtime-terminal`; the sections previously cited here model no
  generic notice mechanism), and the notices are native-origin facts that already carry
  the durable get/acknowledge model the conversion was after. They keep their existing
  SharedPreferences-backed bridge surface (`readinessDisabled` event included); only the
  caller-less dedicated revocation acknowledge is deleted as dead code. Unifying notices
  onto a retained-record abstraction is deferred past M7 and would require contracts
  changes designed on their own terms.
- **Delete**: everything listed under Evidence, plus `executeRealtimeHandoff` and
  `completionLock` (dead code), the interrupt lane, and the sticky termination StateFlows.

Net: ~36 functions (from 64), ~6 events (from 11). `nativeRevision` stays an equality gate
through the cutover (the ownership spec forbids dual shapes during migration) and becomes a
minimum-compatible check in the release after the surface stabilizes.

Transcripts, tokens, and draft text never enter the journal or events (ownership
spec:462-463, :655-656): draft delivery remains a lease-gated pull with opaque handles, and
`configureAuthority` continues to carry the raw token memory-only.

## Recovery

Recovery becomes data-in, plan-out:

1. StoreDriver loads the persisted set: readiness config, prepared/attached authority,
   canonical authority, realtime checkpoint, finalization record, thread operation claim,
   execution snapshot, completed-recording registry, cue settings, retirement fences.
2. The kernel receives one `Recover(loaded)` message.
3. `recover: (LoadedState, Permissions, Clock) -> (KernelState, [Effect])` runs the existing
   pure policies (`startup fence resolution`, committed-readiness reconcile, thread-operation
   NONE/RESTORE/CANCEL/REVOKE decision, realtime recovered-engine vs canonical install) and
   returns the initial state plus effects (resume long-poll, schedule refresh recovery,
   restore foreground posture, arm restored thread turn).

The seventeen live steps in `onCreate` (service:1836-2325) reduce to the loader plus this
function. The fixture matrix required by the ownership spec's verification section (process
death in every phase, corrupt-store Locked handling, discard-preparation, mismatch
revocation) becomes a table of `LoadedState` fixtures asserted against `(KernelState,
[Effect])` — the same shape as the forty realtime engine tests, applied to the code that
currently has six.

## Concurrency invariants

1. Exactly one thread ever reads or writes `KernelState`.
2. A reducer step performs no IO, no blocking call, and no platform call.
3. Drivers never read or write kernel state; they receive effects and post messages.
4. Every effect carries the issuing attempt epoch; every result echoes it; the kernel checks
   it exactly once at admission.
5. Ordering between two effects is guaranteed only within one driver lane; cross-driver
   ordering is expressed as reducer step sequencing on result messages.
6. Time enters only as `Tick` messages from kernel-scheduled timers; no component reads the
   wall clock to make a state decision.
7. Durable commit points precede their dependent externally visible actions via step
   sequencing, never via blocking.
8. The host executes host effects verbatim and holds no decision logic.
9. All existing external fences (Retained table) are enforced in the reducer, unchanged.
10. No compatibility path: at any milestone, exactly one implementation owns a given
    operation path (ownership spec migration rule).

## Migration

Each milestone is independently shippable, keeps the full existing test suite green
(including `verifyVoiceRuntimeConformance` against the Android adapter and the shared JSON
fixtures decoded by Kotlin), and ends with deletions, not flags.

1. **M1 — Ingress.** Introduce the kernel thread and mailbox. Route binder operations,
   `onStartCommand`, MediaSession callbacks, and worker intents through it; the message
   handler still takes `operationLock` internally, so behavior is unchanged. Delete the
   interrupt lane and stop tombstones (mailbox ordering now provides their guarantee).
   Add a debug assertion that `operationLock` is only ever acquired from the kernel thread.
2. **M2 — State capture.** Move the direct-lock callback entries (recorder, player, focus,
   presentation sink, handoff coordinator, heartbeat termination, WebRTC state hops) and the
   three lock-free mutations onto the mailbox. The assertion from M1 now holds; delete
   `operationLock` and `serviceDestroyed`. This is the highest-risk milestone; it ships alone
   after an instrumented soak of the connected-device matrix.
3. **M3 — Drivers.** Extract MediaDriver and NetDriver from the anonymous port
   implementations and the eight executors; convert the realtime engine to a sub-reducer
   (its tests port mechanically — same transitions, effects instead of port calls). Delete
   the executor fields and the engine monitor.
4. **M4 — Epoch consolidation.** Introduce the attempt epoch; migrate call sites; delete the
   twelve local fencing families and their tests, replacing them with epoch admission tests
   and reducer fixtures. Delete `executeRealtimeHandoff` and `completionLock` (can land any
   time; listed here for accounting).
5. **M5 — Bridge cutover.** Delete the dead-reachability surface and the zero-caller
   functions; convert the four live pending/ack groups to completion handles and retained
   records; bump `nativeRevision`; update `androidVoiceRuntime.ts` and the two live hooks
   (`useComposerDictation`, `useThreadSpeech`) in the same change. One vertical switch, no
   aliases.
6. **M6 — Recovery function.** Replace the `onCreate` choreography with `Recover` and land
   the fixture matrix. Shrink the service to the host.
7. **M7 — Package split.** `host/`, `kernel/`, `media/`, `net/`, `store/`, `bridge/` along
   the now-real seams. Mechanical, last, no behavior change.

## Testing

- **Reducer fixtures**: every phase/reason combination the ownership spec already requires,
  plus the interruption matrix (spec:539-555) as a table test over the arbiter, plus the
  recovery matrix. All virtual-clock, no Robolectric.
- **Epoch admission**: stale-result fixtures per message kind (the deleted mechanisms' test
  intent, expressed once).
- **Driver contract tests**: each driver against a fake counterpart (fake recorder/player/
  peer; the existing `MemoryRuntimeStorage`; an HTTP fake over `VoiceRuntimeHttpTransport`),
  asserting effect-to-call translation, cancellation on epoch bump, and result posting.
- **Message-order properties**: with one thread, interleavings are message orderings —
  enumerable. Property tests shuffle DriverResult arrival orders around command sequences and
  assert invariants (single media owner, no dispatch after stop admission, receipts stable
  under replay).
- **Unchanged**: contract round-trips, shared TS/Kotlin JSON fixtures, conformance harness,
  store tests (formats untouched), WorkManager refresh tests, instrumented service tests, and
  the connected-device matrix from the ownership spec (which gates M2 and M5).
- **Test migration accounting**: pure-policy and store tests survive as-is; engine tests port
  to the sub-reducer; the ~10 test files covering deleted fencing mechanisms are replaced by
  the epoch and ordering suites; `T3VoiceRuntimeServiceRecoveryTest`'s six scenarios become
  rows in the recovery matrix.

## Risks

- **M2 is a cliff.** Removing the lock in one milestone is deliberate (a half-locked kernel
  is worse than either extreme), which concentrates risk. Mitigations: the M1 assertion
  proves single-threaded acquisition before deletion; the soak gate; keeping M2 free of any
  other change.
- **Mailbox latency for safety actions.** Mic disable and stop admission tolerate only
  milliseconds. The no-blocking rule bounds queue delay, and `SetMicEnabled(false)` has a
  driver fast path; a watchdog diagnostic records any reducer step over 5 ms.
- **Callback flood.** WebRTC playout-sample callbacks fire per-buffer; they stay inside
  MediaDriver's playout monitor (as today) and only drain/level _facts_ become messages.
- **Long-poll cancellation.** A bumped epoch must abort a parked 25 s poll promptly;
  `disconnect()` provides this today and NetDriver owns verifying it (existing
  VoiceRuntimeHttpTest coverage extends to the driver).
- **Hidden consumers of `T3VoiceStateStore`.** The module's flow collectors re-emit it to JS.
  During M1-M4 the store remains as a kernel-published read model; it is absorbed into
  journal/event emission at M5 when its remaining consumers (sticky slots, legacy events)
  are deleted.
- **Store contention with WorkManager.** Unchanged from today by design; the stores' internal
  synchronization and the worker's admission re-checks are retained precisely because this
  boundary is distributed.

## Open questions

1. Cue enablement on the autonomous path: readiness/target configuration field, a runtime
   command, or a retained device preference? (Today's `setVoiceCuesEnabledAsync` is
   ui-attached-only and dies with the legacy surface.)
2. Should `EnqueuePcm` adopt explicit credit grants in the receipt (queue depth remaining)
   rather than relying solely on `playbackChunkConsumed` pacing?
3. Does the kernel thread also host StoreDriver's fast persists (saving a hop for commit
   points), or do all stores live behind the driver uniformly? Recommendation: uniform
   driver, revisit only if commit-point latency measurably matters.
4. The ui-attached TypeScript orchestrator (`MasterVoiceProvider` ui-attached body,
   `realtimeVoiceController`, `useAutoListenController`) is deliberately retained: it is the
   seed of the planned React-backed desktop/web adapter
   (`docs/architecture/desktop-voice.md`), which implements the same `VoiceRuntime` facade
   with `executionModel: "ui-attached"` against browser media instead of the Expo module.
   M5 removes only its Android-native reachability (the Kotlin functions it can no longer
   call). The open question is when to retarget its media calls onto the platform-neutral
   media interface the desktop workstream will introduce, and when it must pass the same
   conformance suite the Android adapter passes — not whether to delete it.
5. Whether the future iOS adapter shares the kernel reducer via transpiled fixtures only
   (current plan: shared JSON fixtures, independent implementation) or via a shared KMP
   module (out of scope here; would change build infrastructure).

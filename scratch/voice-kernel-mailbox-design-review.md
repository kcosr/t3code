# Review: Voice kernel mailbox design and hybrid implementation

**Date:** 2026-07-16  
**Branch:** `feature/voice-kernel-m1`  
**Scope:** Design of `specs/native-voice-runtime-kernel.md` and the live hybrid in
`apps/mobile/modules/t3-voice` (mailbox + epochs + drivers; service still largely
imperative).  
**Kind:** Design / architecture review (not a line-level PR review).

## Summary

The **target design is right** for the race class this runtime has been fighting: a
single-threaded kernel, effects at the edges, and one local epoch admission check, while
retaining distributed protocol fences (authority, command fences, journals, process-death
finalization).

The **live tree is a deliberate hybrid**, not the pure kernel yet. That hybrid is where
most risk sits: mailbox-serialized imperative bodies, closure-carrying driver results,
dual epoch maps, and unfinished hard cases (especially THREAD_TURN blocked on
`enqueuePcmBlocking`). Complexity has been reordered more than reduced; the service is
still ~6k lines.

Recommendation: keep shipping toward the pure model. Prioritize closing purity on the
hottest paths (thread speech backpressure, realtime cancel, stop admission, recovery
fixtures) before cosmetic package split (M7) or bridge cleanup (M5) alone.

---

## What works well

### 1. Correct diagnosis

The historical race class (pool callback × global lock × attempt identity) is classic
shared-mutable-state failure. Making total order a **structural** property instead of an
invariant every call site must remember is the right move.

### 2. Clean separation of fence kinds

Keeping **distributed** fences (authority generation, command fences, journals, durable
finalization) while collapsing **local** attempt fencing into one epoch is sophisticated
and correct. Many actor rewrites throw away hard protocol fences; this one does not.

### 3. Explicit hard cases

Stop without an interrupt lane, write-before-effect via two-step sequencing, mic-off fast
path, bulk PCM off the mailbox—these are where actor designs usually fail silently.
Naming them in the kernel spec is a strong signal.

### 4. Migration rule: one owner per path

“No dual shapes; ship deletions not flags” is the only way this finishes. The alternative
is a permanent dual runtime.

### 5. Recovery as data → plan

Making recovery a pure function over loaded store fixtures is how coverage can match
severity. Production recovery is still live choreography; the design correctly targets
that gap.

---

## Design concerns (even at target)

### D1. Epoch “drop” is too blunt for some paths

Default stale-drop is excellent for late PCM/focus noise. It is **not** always correct
for cancelled starts that must finalize on the server (the spec admits some stale results
need reducer transitions, not discard). That exception set must stay small and
table-tested, or the team reintroduces tribal “sometimes drop, sometimes don’t” knowledge
—the same complexity class as the old local fences.

### D2. Cross-driver ordering only via round-trips

Correct, but easy to violate under pressure. Every “persist then speak / then HTTP”
becomes two messages. Latency is fine for SharedPreferences; cognitive cost is real.
Without aggressive fixture tests that shuffle result order, people will re-inline effects
“for simplicity.”

### D3. Unbounded mailbox + synchronous binders

`submitAndAwait` on the binder for dispatch/snapshot/attach is contract-driven, but:

- queue depth becomes **binder latency** for every JS caller
- one slow kernel body (or a flood of mis-classified media facts) stalls **all** safety
  actions behind it

The design relies on “no blocking in the reducer” plus a 250 ms watchdog. That only works
if the watchdog is treated as a **ship blocker**, not a diagnostic curiosity.

### D4. Net lanes still encode product policy

THREAD_TURN=1 / REALTIME=4 / CONTROL=1 is sensible, but it is policy hidden in executors.
If CONTROL and REALTIME both need to cancel the same peer, kernel-level sequencing must
own admission—lane concurrency must not become a second source of truth.

### D5. Desktop / ui-attached dual world

Keeping the ui-attached TypeScript path for future desktop is reasonable product-wise,
but it means two mental models of voice until a real platform-neutral `VoiceMediaRuntime`
exists. Kernel purity on Android does not simplify the client half of the architecture
yet.

### D6. iOS “mirror the kernel”

Shared JSON fixtures only is realistic. Claiming the kernel is “mirrorable” without a
shared reducer language means iOS will reimplement and diverge. Fine if called a product
choice; not if people expect parity by construction.

---

## Implementation issues (current hybrid)

Authoritative paths reviewed include:

- `VoiceKernelMailbox.kt`, `VoiceKernelMessages.kt`, `VoiceKernelEpoch.kt`,
  `VoiceKernelEffects.kt`
- `T3VoiceRuntimeService.kt` (mailbox ingress, `handleDriverResult`, `driverEpoch`,
  recovery, destroy, thread speech)
- `VoiceNetDriver.kt`, `VoiceMediaDriver.kt`, `T3VoicePcmPlayer.kt`
- Specs: `native-voice-runtime-kernel.md`, `kernel-milestones/m1-mailbox-ingress.md`,
  `m4-epoch-consolidation.md`

### I1. Closures-as-messages undermine the model — **High**

NetDriver returns a continuation thunk; the service runs it after epoch admit:

```text
blockingBody() → continuation
DriverResult(..., NetCompleted(label, continuation))
→ handleDriverResult → continuation()
```

So a “message” is not data; it is a thunk over service fields. Consequences:

- history cannot be fixture-replayed
- epoch drop is the only safety net for stale closures
- accidental capture of the wrong `attempt` / owner is still possible

Valid as a **migration** step; not yet the kernel design. Until results are pure facts
(e.g. `SpeechStreamSucceeded(segmentId, …)`), most of the testability win is unrealized.

### I2. Dual epoch systems can disagree — **High**

Kernel owns `VoiceKernelEpochRegistry`. MediaDriver also keeps
`ConcurrentHashMap` epoch maps and drops at the driver if missing, then the kernel admits
again.

During migration that double-gate is defensive. Long-term it is two stale policies. If
arm/disarm drifts from registry retire, results are either silently dropped (hard to
debug) or double-delivered.

### I3. `driverEpoch()` is a heuristic footgun — **High**

Approximate logic:

```text
if thread attempt → that epoch
else if realtime checkpoint → mode epoch
else → service epoch
```

Work that is “about” the peer while a thread turn is live, or service-scoped while
realtime is active, can stamp the **wrong root**. That is exactly how late results get
wrongly admitted or wrongly dropped. Target design wants explicit roots at arm sites; a
global helper is a footgun.

### I4. Hard case D not fixed — THREAD_TURN blocks on PCM — **High**

Thread speech still does:

```kotlin
) { pcm ->
  player.enqueuePcmBlocking(playbackId, chunkCount, pcm)
}
// inside netDriver.execute("thread-speech", THREAD_TURN, ...)
```

`enqueuePcmBlocking` still `lock.wait()`s when the queue is full. That does **not** block
the kernel thread (good), but it **does** block the entire THREAD_TURN lane: cancel, poll,
upload, disposition all sit behind a full PCM queue. Under slow playback or audio-focus
pause, thread control can starve. The design’s pull-based Net→Media pipe with non-blocking
admit is not fully here.

### I5. Complexity reordered, not reduced — **Medium–High (process)**

`operationLock` is largely gone; `assertKernelThread` is the new gate. Serialization is
better. The service is still a giant bag of mutable fields + `*Locked` methods. Until
state is one `KernelState` and the service is a thin host, recovery and interruption
cannot be reasoned about as a table.

The tree already moved past pure M1 into a partial M2/M3/M4 world. **Half-kernel is a
long-lived danger zone:** new paths arrive as `mailbox.submit { old imperative }` and
never convert.

### I6. Lifecycle edges still awkward — **Low–Medium**

- **`onStartCommand`** returns stickiness from a cached value; a comment admits one intent
  may return stale stickiness after a readiness message is only queued. Acceptable Android
  limitation; still a real FGS policy race.
- **`onDestroy`** fire-and-forgets teardown on the mailbox then `drainAndQuit()`. Ordering
  usually works, but teardown is a huge body on the kernel thread at the moment drivers
  should be cancelled first. Cancel-all-then-join would be safer.
- **Timer cancel off-kernel** leaves registry entries until re-arm (documented). Under
  high rearm churn that can leak entries or confuse admission.

### I7. Recovery still live choreography — **Medium**

`onCreate` still loads stores, builds a plan, then `submitAndAwait`s a large recovery body
that constructs MediaDriver and runs the plan. The pure `Recover` fixture matrix is not
the production path yet. Highest-risk code still has thin structural coverage.

### I8. Binder `submitAndAwait` has no timeout — **Medium**

Many value-returning binder methods await the kernel with `FutureTask.get()` unbounded.
A hung kernel body hangs binder / Expo promises until process death. Consider bounded
await + typed failure for non-admission paths (or at least diagnostics/snapshot).

### I9. Docs drift — **Low–Medium (ops → design bugs)**

Product docs (`docs/architecture/voice.md`) still describe older media tickets / grant
shapes while specs (`voice-auth-unification`, kernel milestones) move. Reviewers and
implementers will disagree about “current truth.”

---

## Severity ranking

| ID | Issue | Severity | Kind |
| -- | ----- | -------- | ---- |
| I1 | Closure-messages + hybrid purity gap | High | Implementation / process |
| I4 | THREAD_TURN blocked on `enqueuePcmBlocking` | High | Incomplete cutover |
| I3 | `driverEpoch()` heuristic mis-stamping | High | Implementation footgun |
| I2 | Dual epoch maps (driver + registry) | High | Migration hazard |
| D1 | Stale-drop exceptions not table-tested | Medium–High | Design edge |
| I5 | Service still ~6k lines imperative | Medium–High | Process |
| I8 | No timeout on `submitAndAwait` | Medium | Implementation |
| D3 | Mailbox backlog → safety latency | Medium | Design (discipline) |
| I7 | Recovery still imperative | Medium | Incomplete (M6) |
| D5 | ui-attached + Android dual models | Low–Medium | Product architecture |
| I6 | Stale stickiness / destroy ordering | Low–Medium | Platform edges |
| I9 | Architecture docs out of date | Low–Medium | Ops |

---

## Suggested priority order

1. **Thread speech backpressure** — replace `enqueuePcmBlocking` on the NetDriver path
   with a bounded non-blocking pipe so cancel/upload/poll cannot starve behind PCM.
2. **Kill `driverEpoch()` heuristic** — require explicit arming epochs at every
   net/media/store effect site; fail closed if missing.
3. **Pure driver results on hot paths** — convert Net/Media completions from thunks to
   data messages for stop, cancel, speech terminal, and realtime peer terminal first.
4. **Stale-result exception matrix** — table of “drop vs reducer-handle” per result kind;
   especially cancelled-start finalization.
5. **Recovery fixtures (M6)** — pure `Recover` before more surface area changes.
6. **Bounded `submitAndAwait`** — timeout + typed failure for non-admission awaits.
7. **Single epoch owner** — MediaDriver maps become arm-time stamping only, or go away
   once registry is sole admission authority.
8. **Doc sync** — mark superseded sections in `docs/architecture/voice.md` relative to
   auth-unification and kernel specs.
9. Bridge cutover (M5) / package split (M7) — after purity and backpressure, not instead.

---

## Bottom line

**Design:** Ship toward this. Single-threaded kernel + effectful drivers + epoch admission
is the right endgame for a native voice runtime that must survive process death,
notifications, WebRTC, and HTTP long-polls without another year of
`fix(voice): fence …` commits.

**Implementation:** Not there yet. What exists today is closer to a **serialized
imperative service** than a pure kernel. Biggest threats:

1. treating the hybrid as “done enough”
2. leaving NetDriver able to block on PCM
3. epoch identity via heuristic instead of arming sites
4. never finishing pure results / recovery fixtures that make the model pay for itself

---

## References

- `specs/native-voice-runtime-kernel.md`
- `specs/kernel-milestones/m1-mailbox-ingress.md`
- `specs/kernel-milestones/m4-epoch-consolidation.md`
- `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/kernel/VoiceKernelMailbox.kt`
- `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/T3VoiceRuntimeService.kt`
- `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/net/VoiceNetDriver.kt`
- `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/media/VoiceMediaDriver.kt`
- `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/media/T3VoicePcmPlayer.kt`

# M4 — Epoch Consolidation

Kernel milestone M4 (`specs/native-voice-runtime-kernel.md`, Fencing model + Migration M4).
Real epochs replace the placeholder (`driverEpoch()` = "m3-placeholder", service:125-130);
ONE admission check lands in `handleDriverResult` (service:144-168); the local fencing
families die. The families split three ways — the scope split IS the milestone:

## Scope A — kernel-thread families (pure collapse, delete now)

- Cue generation counter `nextCueGeneration` (service:1271, bumps :1499/:1558/:1588/
  :1669/:4661/:4674) → attemptOrdinal on the cue-arming epoch.
- Media arbiter owner-identity guards (`recordingOwner` :1257, `playbackOwner` :1258,
  `realtimeStopDrainSessionId` :1274, `pendingRecordingStart` :1275; `takeIf` guards
  :1319/:1373/:1513/:3594/:3867) → arming-epoch admission. The OWNER concept survives as
  plain state (who holds the resource); only the staleness re-derivation dies.
- State-store phase-claim CAS (T3VoiceState.kt: `nextOperationGeneration` :213,
  `claimRealtime` :321, `claimRecording` :378, `claimPlayback` :473,
  `updateIfOperationOwner`, `compareAndSet` :338): the kernel is the sole writer — drop
  the CAS write-side machinery to plain writes. THE STORE OBJECT ITSELF STAYS (JS read
  model until M5).
- Engine-slot version CAS + identity fences (Slot: version :48, requireFence :201-210,
  requireBinding :212-222): every method is already assertKernelThread-guarded — delete
  the version/fence CAS. KEEP the stage→commit→complete/rollback two-phase SEQUENCING
  (durable commit-point ordering, invariant 7) as plain kernel-thread logic.
- `VoiceKernelReschedulePolicy.owns` sites (service:5245/:5269/:5280/:5291) → Tick
  messages carrying the arming epoch; the policy object and its test die.

## Scope B — driver-internal families guarding genuinely-foreign threads

Deletion is legal ONLY by this recipe, per family: the arming effect's epoch is handed to
the driver object; the driver forwards raw facts (terminal, timeout, focus change,
completion) tagged with that epoch as DriverResults; the kernel admits once. Then delete
the family's STALENESS mechanism. DO NOT delete genuine internal mutual exclusion that
protects a driver object's own data structures across its own worker threads — that is
not staleness fencing (e.g. the WebRTC session's internal synchronized blocks protecting
its session object, the PCM player's queue lock). The distinction per family:

- `T3VoiceRealtimeTerminalLatch` (sole caller T3VoiceWebRtcSession:96) — DELETE; the
  kernel admits one terminal per peer epoch; late duplicates drop at admission.
- `T3VoiceSessionIdTombstones` (session:100) — DELETE; epoch includes the session
  identity; a reused/late session id is a stale epoch.
- `T3VoiceRealtimeConnectionTimeoutPolicy` owner tokens (session:98, :746-799) — DELETE;
  timeouts become epoch-stamped Ticks; a stale timeout drops at admission.
- `T3VoiceRealtimeAudioOwnerPolicy` (session:97, :1152-1191) — DELETE; ADM error facts
  carry the peer epoch.
- `T3VoiceRecordingTerminalPolicy` (+ its coordinator; recorder:179-323) — DELETE the
  claim/owner policy; the recorder posts ONE terminal fact per recording epoch; keep the
  recorder's internal synchronized protecting MediaRecorder handle state.
- Cue player generation admission + terminalClaimed CAS (CuePlayer highestGeneration
  :108-109, terminalClaimed :82/:244, active===cue :173/:189/:236/:271) — DELETE the
  generation/claim machinery; completions carry the cue epoch; keep the player's internal
  locks over AudioTrack state.
- PCM player identity/timeout-generation/release CAS (requireActive :397-401,
  timeoutGeneration :85/:413-421, released :86/:405-407) — DELETE staleness parts;
  KEEP chunk-index/queue-bound input validation and internal queue locking.
- Audio-router owner generations (activeOwnerId/generation :43-44, select :144, focus
  guards :295/:371 — callbacks arrive on the MAIN thread via null-Handler registration
  :66-68/:342) — DELETE the owner-gen staleness check; route/focus facts post as
  epoch-stamped DriverResults; ADD explicit router epoch-admission tests (no dedicated
  coverage exists today).

## Scope C — FENCED OFF (not M4)

Binder generation stamps + `T3VoiceBinderOperationRegistry` isActive re-checks and
`T3VoiceBindingRealtimeOwnerPolicy` (module binderLock domain) — bridge-boundary
mechanisms coupled to M5's pending/ack conversion. Do not touch.

## Epoch stamping (identity sources — use EXACTLY these)

`runtimeInstanceId`: controller identity (service:2624, minted :1945). `authorityGeneration`:
readiness/canonical generation (service:2632, :235, :271, :925). `rootOperationId`:
modeSessionId for mode-scoped work, clientOperationId for turn-scoped
(VoiceRuntimeThreadExecution:238-240; realtime fence service:1031+ family), realtime
session id for peer-scoped. `attemptOrdinal`: a kernel-owned monotonic counter bumped per
arming (replaces attempt object identity, slot version, owner generation, cue generation,
timeout tokens). Stamping points: the 9 thread-lane executeDetached sites (:2722, :2957,
:3045, :3112, :3304, :3344, :3403, :3556, :3892), realtime/control lane submissions,
StoreDriver persists (:287, :1730, :1817, :2184, :3778 + engine checkpoint effects),
MediaDriver arming calls, Tick scheduling (:170-179).

## The admission point

`VoiceKernelEpochPolicy.admit(currentEpochFor(result), result.epoch)` runs ONCE in
`handleDriverResult` before invoking any continuation; DropStale increments a diagnostic
counter (ring entry with dimension). Then DELETE the ~45 hand-rolled checks (the seam
map §3 list: ~24 `=== attempt`/stopped/cancelRequested sites, ~12 engine-identity sites,
3 binding-identity sites, 4 owns sites, 2 handoff-activation sites). Survivors must be
listed in the commit message with reasons (expected: protocol fences only, per the
exclusion list below).

## Exclusion list (protocol/distributed — untouchable)

Authority CAS/floor/Locked (AuthorityStore:115/:177/:189-210) incl. the stale-authority
throws at service:5342/:4858; command fence tuple (ThreadTurn:9-329); consumer
leases/election (Consumers:4-37); idempotency ledgers; journal cursor/rebase
(Journal:56-71); persisted checkpoint/finalization/terminal dedupe; StartCommandPolicy
OS-replay validation.

## Tests

Delete/replace per the seam map §5 list (family tests → epoch-admission suite: per-family
stale-drop fixtures, one admit-order property test). PCM chunk-validation and cue/router
PURE policy tests survive. Slot two-phase sequencing tests survive re-expressed. Add
router epoch coverage. `VoiceKernelReschedulePolicyTest` dies with its policy.

## Verification

1. Family greps → zero: `TerminalLatch|SessionIdTombstones|ConnectionTimeoutPolicy|RealtimeAudioOwnerPolicy|RecordingTerminalPolicy|ReschedulePolicy` across the module (source + tests).
2. `grep -c "m3-placeholder" service` → 0; `grep -c "admit(" handleDriverResult region` → 1.
3. `grep -c "=== attempt\|!== attempt\|=== engine\|!== engine\|=== bindingIdentity" service` → 0 (or listed survivors).
4. `pnpm run typecheck` + `pnpm run lint:mobile` green.
5. Commit message: per-family disposition table (A/B/C), stamping-site count, deleted-check count, survivors.

## Done criteria

Commits: `feat(voice): stamp real kernel epochs` then `feat(voice): delete local fencing
families` (order matters — stamping lands and passes before deletion). Tree clean; pc
gate follows; then M5.

## Review amendments (BINDING — supersede conflicting text above)

E1. **Route completions through admission FIRST.** Convert the 9 thread-lane
`executeDetached` sites (:2722, :2957, :3045, :3112, :3304, :3344, :3403, :3556, :3892)
to the continuation-carrying `netDriver.execute(label, lane, epoch) { IO; { completion } }`
form so their completions arrive via `handleDriverResult`. NO check deletion anywhere
until its path is admission-gated. Apply the same conversion to any other completion
currently returning via `submitCallback`.

E2. **Same-epoch exactly-once is NOT provided by admit()** (stateless equality). Where a
family provided exactly-once: (a) cue terminal — add a per-epoch once-latch IN KERNEL
STATE (first admitted terminal per cue epoch wins; later same-epoch terminals drop with a
diagnostic) and only then delete `terminalClaimed`; (b) recorder — RETAIN the
active-field read-then-null arbitration under the recorder monitor (it, not the epoch,
guarantees one terminal fact); delete only the generation/owner staleness policy;
(c) WebRTC session — the active-field transition already serializes stop/fail; the
terminal latch is redundant and deletable, but for THAT reason, not epoch dedup.

E3. **Per-root epoch registry.** Kernel state gains a registry mapping root →
current `VoiceKernelEpoch` (thread turn by clientOperationId; realtime by session id;
recording/playback/cue per-resource arming; tick by timerId), updated at each arming.
`currentEpochFor(result)` = classification table over (driver, resultKind) → registry
lookup. Each stamping site constructs its epoch from the registry entry it just armed.

E4. **Stop/cancel bumps the root attemptOrdinal** (adopt the master spec's cancellation
rule now). Even so, per E5, state predicates survive.

E5. **Delete only identity conjuncts.** At each compound site remove ONLY the
`=== attempt` / `!== engine` / `=== bindingIdentity` identity comparison; RETAIN
`attempt.stopped` (16 sites), `attempt.cancelRequested` (:3917, :3934 — persisted and
recovered; durable decision), `finishCall(call)` (internal call arbitration),
`isOperational()` (:5005, :5067), `checkpoint != null` (:5249, :5295). The verification
grep forces refactoring compound conditions, not deleting lines.

E6. **Tombstones fenced to M5**: downgrade `T3VoiceSessionIdTombstones` to an assertion
now (session ids are still bridge-supplied until the M5 cutover per the kernel spec);
full deletion rides M5. Its test survives, re-pointed at the assertion.

E7. **Per-arm timer dedup**: connection-timeout tokens and PCM timeoutGeneration dedupe
re-arms within one root epoch — reproduce by bumping the per-resource attemptOrdinal at
every re-arm so a superseded Tick carries a stale epoch; requires the E3 registry.
PCM `requireActive` (:397-401) is command-path input validation — KEEP.

E8. **Slot**: replace `committedVersion: Long?` with a phase marker
(`STAGED|COMMITTED`) so two-phase commit sequencing survives, THEN delete `version`,
`requireFence`, `requireBinding`.

E9. **Per-file deletable members** (nothing else in these files):
WebRTC session — the four staleness fields/uses `terminalLatch`, `audioOwners`,
`connectionTimeouts`, `usedSessionIds` (:96-100, per E6 tombstones = assertion) and
their call sites; the active-field synchronized blocks STAY. PCM — `timeoutGeneration`
and `released` CAS staleness only; `requireActive`, queue locks, chunk validation STAY.
Cue — `highestGeneration` admission and (after E2a's kernel latch) `terminalClaimed`;
AudioTrack locks STAY. Enumerate any further candidate in the commit message BEFORE
deleting it, with its classification.

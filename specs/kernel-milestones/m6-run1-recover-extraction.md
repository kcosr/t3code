# M6 Run 1 — recover() Extraction + Fixture Matrix (additive, no deletion)

First of two M6 runs. Binding inventory: `specs/kernel-milestones/m6-seam-map.md`
(anchors at `195bd7879`; RE-LOCATE BY SYMBOL). Kernel spec Recovery section as amended
by the seam map's §0 drift list. `onCreate` is NOT modified in this run — the new
function runs under test only; the live path cuts over in run 2. Tree releasable
standalone.

## Review correspondence (pre-launch findings F1-A..I — rulings binding)

F1-A killed the original R-1: `VoiceRuntimeThreadStoredStatePolicy.decide`'s
`parentGrantAvailable` comes from `persistedAuthority()` (svc:1488) — a FRESH
`authorityStore.load()` at step 26, NOT the controller — and step 21's
`restoreCanonicalAuthorityLocked` CLEARS the store on configure-throw (svc:5259-5261).
Live behavior on that path: Prepared claim + configure-throw → fresh read Missing →
decide=REVOKE (disable + revocation record). A plan-frozen decision computed from the
loaded authority would instead produce CANCEL_PREPARED + thread start against a phantom
grant. The thread-op decision is therefore EXECUTION-TIME, never plan-frozen. All other
findings folded below.

## Design rulings (binding, post-amendment)

**R-1 (amended): pure `recover()` with one execution-time decision.**
`recover(LoadedState, Permissions, Clock) -> VoiceRuntimeRecoveryPlan`. The plan =
KernelState-seed + ordered `[VoiceRuntimeRecoveryEffect]`. Every decision is
plan-computed EXCEPT the thread-op reconcile: recover() emits
`ReconcileThreadOperation(loadedThreadOpState)` carrying the loaded claim but NO frozen
decision. At execution (run 2), after the ConfigureCanonicalAuthority effect has run,
the interpreter re-reads `authorityStore.load()`, computes `parentGrantAvailable` via a
NEW pure helper extracted from the svc:1884-1895 grant-match logic
(`VoiceRuntimeThreadStoredStatePolicy.parentGrantAvailable(grant?, loaded)` or
equivalent), calls the existing pure `decide`, and dispatches. The pure policy stays the
sole decision-maker; only its authority INPUT is fresh. Run 1 ships the helper + its
tests, including the pinning case: Prepared claim, grant=null → REVOKE.

**R-2: plan seed carries every surviving service field (F1-B).** The KernelState-seed
MUST include, at minimum: `installedRuntimeId`, `initialGeneration`,
`canonicalPreparedAuthority`, **`readinessConfig` (the FINAL post-overlay,
post-reconcile value)**, **`runtimeSnapshot` (the post-cutover healed value, threaded
from the loader)**, `cueSettings`, and the realtime-install plan. KDoc documents the
run-2 host sequence: loader → recover → `deviceIdentity.getOrCreate(plan.
installedRuntimeId)` → construct controller → ASSIGN `readinessConfig` and
`runtimeSnapshot` (and `cueSettings`) from the plan → kernel block executes
`plan.effects` in emitted order. Ordering invariants encoded as list order and asserted
by fixtures: every RestoreCompletedRecording before SweepStaleCache;
SetServiceReady before ReconcileThreadOperation; ConfigureCanonicalAuthority before
RealtimeInstall and ReconcileThreadOperation; recovered realtime install
precedes/excludes canonical install (step-22 precedence).

**R-3 (amended signature, F1-D): scenario-5 extraction.** The inline `resolve`
onFailure fallback (svc:1639-1669) consumes more than preparation+fences. New
`T3VoiceStartupAuthorityFencePolicy.resolveWithFallback` takes: the preparation
selection, the recovered fences, the persistent-readiness value (runtimeId +
config.generation), the attached-preparation value (fence runtimeId/generation/origin),
`canonicalInstalledPresent: Boolean`, and the three read-success flags
(persistentReadinessRead/attachedPreparationRead/activeAuthorityRead). Success path
delegates to the existing `resolve`; failure path reproduces the inline
selectRuntimeId + generation-max + discardPreparation math EXACTLY. Derive fixture
expectations from the CURRENT inline code.

**R-4 (amended): loader model + temporal readiness semantics (F1-F, F1-G).**

- Loader ordering (binding): `retireLegacyV2` BEFORE `authorityStore.load()` (it
  migrates v2 keys); snapshot `read()` BEFORE `LegacyRealtimeCutover.migrate`; the
  POST-CUTOVER healed snapshot is what enters LoadedState. Migrate stays loader-side in
  its current impure shape.
- CRITICAL temporal fact (F1-F): `readinessStore.write()` REMOVES the prepared/active
  keys. In the live prologue, step 10's disable/promote writes change what steps 11/12
  re-read (`prepared()`/`activeAuthority()` return null/updated AFTER the write).
  recover() consumes the loader's one-shot reads but MUST apply the same
  transformation: after its step-10 decision produces a disable or promote write
  effect, the persistent-readiness/active-authority values feeding steps 11/12 and the
  fence assembly are the POST-WRITE views (null on disable-wipe; updated on promote).
  Row-2's fixture asserts the post-wipe fence set.
- The in-memory bridge completion store stays OUT of LoadedState; its restore+sweep
  remains an emitted effect.

**R-5 (amended): effect vocabulary (F1-C, F1-E, F1-H).** Sealed
`VoiceRuntimeRecoveryEffect` must cover, beyond the original list
(writeDisabledForRuntimeRevocation, discardInitialPreparation, the three storeDriver
clears, invalidateReadiness, clearLockedAfterAuthorityRevocation, snapshot clear,
restoreCompleted, sweepStaleCache, setServiceReady, engine installs, ReconcileThreadOperation):

- `WriteReadiness(config)` — svc:1566 (transient align), :1591 (reconcile-failure
  disable), :1822 (attached write-back).
- `WriteActivatedReadiness(...)` — svc:1579 (promote).
- Diagnostics effects with their exact codes/generations (corrupt
  finalization/checkpoint/prepared-authority, cutover failure, discard, revoke).
- NOT an effect: `restoreProcess` (F1-E) — it is internal to the RESTORE executor
  (`startRuntimeThreadLocked` svc:2293-2294), not plan-observable. Drop it from the
  plan-effect assertions; it stays covered by the existing execution-recovery tests.
- The revoke effect's disabled-config generation is CONTROLLER-resolved at execution
  (svc:1950-1953 reads `controller.snapshot().identity.generation`) — the effect
  carries the selection, not an absolute generation (F1-H); fixtures assert selection +
  clear/invalidate effects only.
- `verifyReadiness` is impure (permissions/SDK reads + require-throw, svc:1462-1476):
  recover() reproduces its overlay from the `Permissions` param INCLUDING the throwing
  require semantics (F1-I) — do not lift the method verbatim.

## Files

- NEW `VoiceRuntimeRecovery.kt` (flat package — `kernel/` is M7): LoadedState,
  Permissions, VoiceRuntimeRecoveryPlan, sealed VoiceRuntimeRecoveryEffect, recover().
- `T3VoiceReadiness.kt`: `resolveWithFallback` (R-3).
- `VoiceRuntimeThreadExecution.kt`: the pure `parentGrantAvailable` helper (R-1).
- NEW test file(s): fixture matrix + helper tests. No other production changes;
  onCreate untouched.

## Fixture matrix (seam map §5 as amended here)

All 15 rows as LoadedState fixtures asserted against the plan (decision half + effect
contents + ORDER), with these amendments: row 2 asserts the post-wipe fence set and the
WriteReadiness(disable) effect; rows 1/3 assert their readiness write effects; row 5
uses resolveWithFallback's widened inputs; rows 6/7/8 assert the
ReconcileThreadOperation effect (loaded state + position after
ConfigureCanonicalAuthority) — the decide outcomes are covered by the existing decide
tests plus the new parentGrantAvailable helper tests (including grant=null → REVOKE
pinning); row 8 asserts revocation selection without absolute generation; the PLAYING
cross-product row asserts the RESTORE-arm reachability only (no restoreProcess plan
effect). Ordering fixtures: restore-before-sweep, ready-before-reconcile,
configure-before-install-and-reconcile, recovered-install-excludes-canonical. All
virtual-clock, no Robolectric.

## Forbidden

- No modification to onCreate, the two recovery helpers, or any live recovery path.
- No deletion of anything. No new packages.
- recover() is pure: no service/controller/platform references; the ONLY
  execution-time decision is the ReconcileThreadOperation re-derivation, which lives in
  run 2's interpreter calling the pure helper — recover() itself never reads a store.
- No weakening of any existing test.

## Done criteria

- recover(), plan type with the FULL seed field list, effect vocabulary incl.
  readiness writes, resolveWithFallback, parentGrantAvailable helper, full fixture
  matrix — all green; existing suites untouched and green; onCreate byte-identical;
  `pnpm run typecheck` + `pnpm run lint:mobile` green; tree clean.

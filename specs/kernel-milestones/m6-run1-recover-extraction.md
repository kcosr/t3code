# M6 Run 1 — recover() Extraction + Fixture Matrix (additive, no deletion)

First of two M6 runs. Binding inventory: `specs/kernel-milestones/m6-seam-map.md`
(anchors at `195bd7879`; RE-LOCATE BY SYMBOL). Kernel spec Recovery section §:481-500 as
amended by the seam map's §0 drift list (19+7 steps not seventeen; 13 store sources not
10; foreground posture is downstream, NOT a recovery step; 5 recovery tests not 6).
`onCreate` is NOT modified in this run — the new function runs under test only; the live
path cuts over in run 2. Tree must be releasable standalone.

## Design rulings (binding)

**R-1: single pure `recover()`, controller constructed AFTER it.** Spec shape preserved:
`recover(LoadedState, Permissions, Clock) -> VoiceRuntimeRecoveryPlan` where the plan is
`(KernelState-seed + ordered [Effect])`. The blocker the seam map flagged (step 26's
`decide` reads `persistedAuthority()` from the controller, which is built mid-sequence at
step 17) dissolves because the controller's installed authority at that point IS the
loaded canonical authority (step 21 configures the controller from `authorityStore.load()`
— the same value the loader already read). Therefore `decide` takes the LOADED canonical
authority. VERIFY ITEM (implementer + reviewer, blocking): read
`restoreCanonicalAuthorityLocked` and `controller.configureAuthority/
configureRealtimeAuthority` and confirm no normalization/mutation makes
"controller-installed" differ from "loader-loaded" for the fields
`VoiceRuntimeThreadStoredStatePolicy.decide` consumes (parent-grant availability). If any
divergence exists, STOP and surface it — do not paper over.

**R-2: host sequence after `recover()` returns (run 2 will wire this; run 1 documents it
in the plan type's KDoc):** loader → `recover(...)` → host: `deviceIdentity.getOrCreate(
plan.installedRuntimeId)` (durable write, host-side — ambiguity #3 ruling) → construct
`VoiceRuntimeActiveThreadController` from plan identity data → execute `plan.effects` in
EMITTED ORDER on the kernel thread. Ordering invariants (seam map §7) are encoded as list
order and asserted by fixtures: every RestoreCompletedRecording effect precedes
SweepStaleCache; SetServiceReady precedes StartThreadTurn; ConfigureCanonicalAuthority
precedes RealtimeInstall and thread reconcile effects; recovered realtime install
precedes/excludes canonical install per step-22 precedence.

**R-3: scenario-5 extraction (ambiguity #5).** The inline `resolve` onFailure fallback
(svc:1639-1669) becomes `T3VoiceStartupAuthorityFencePolicy.resolveWithFallback(
preparation?, fences...) -> T3VoiceStartupAuthorityResolution` — success path delegates
to the existing `resolve`; failure path reproduces the inline `selectRuntimeId` +
generation-max + discardPreparation math EXACTLY (this is W0b scenario 5, previously
untestable). The old `resolve` stays (other callers unknown — verify; if none outside
this path, it may become private to the policy).

**R-4: loader (ambiguity #6).** New `LoadedState` assembly runs where the StoreDriver
executes today: reads ALL 13 sources per seam map §2 (the 10 spec-listed + device
identity current value + session credential state + realtime cleanup store), the
Permissions snapshot, and RUNS `LegacyRealtimeCutover.migrate` in its current impure
shape (loader-side clears, healed snapshot into LoadedState) — recover() sees only the
post-cutover snapshot. The in-memory bridge completion store stays OUT of LoadedState
(seam map §2); its restore+sweep remains an emitted effect executed against the live
object.

**R-5: decisions in, effects out.** recover() internally reuses the pure policies per
seam map §3 verbatim (canonical-readiness transient/disabled, committed-readiness
reconcile, fence persistentPreparation/selectPreparation/resolveWithFallback,
thread stored-state decide (Clock param), recovered-realtime authority/recoveryIdentity,
finalization shouldConvergeIdle, thread-recording restore DECISION half — its
`restoreCompleted` callback becomes an effect). The inline discard-preparation block
(svc:1671-1704) and the revoke-decision logic inside
`revokePersistedThreadOperationLocked` (1926-1966) are re-expressed as pure decision code
inside recover() emitting effects (writeDisabledForRuntimeRevocation,
discardInitialPreparation, the three storeDriver clears, invalidateReadiness,
clearLockedAfterAuthorityRevocation, snapshot clear). Effect vocabulary: model on seam
map §4's table — one sealed `VoiceRuntimeRecoveryEffect` type in the new file.

## Files

- NEW `VoiceRuntimeRecovery.kt` (flat module package — the `kernel/` relocation is M7,
  do NOT create packages): `LoadedState`, `Permissions` (or reuse an existing shape),
  `VoiceRuntimeRecoveryPlan`, sealed `VoiceRuntimeRecoveryEffect`, `recover(...)`.
- `T3VoiceReadiness.kt`: add `resolveWithFallback` to the fence policy (R-3). No other
  production file changes. `onCreate` untouched.
- NEW test file(s): the fixture matrix.

## Fixture matrix (seam map §5 is the binding table)

All 15 rows as `LoadedState` fixtures asserted against the plan: decision half AND the
NEW `[Effect]` assertions (contents + ORDER). Plus: the phase cross-products expressed
via `VoiceRuntimeExecutionSnapshot.phase` (with the PLAYING row asserting the
`VoiceRuntimeExecutionRecovery.restoreProcess` effect), and row-5's new
resolveWithFallback fixtures (both success-delegation and failure-fallback, asserting
selectedRuntimeId/generation-floor/discard equal the inline math's outputs for the same
inputs — derive expected values from the CURRENT inline code, not from intuition).
Ordering fixtures: at minimum one fixture each asserting restore-before-sweep,
ready-before-start, configure-before-install, recovered-install-excludes-canonical.
Existing pure-policy suites (per §5 rightmost column) are untouched and keep passing —
they cover decisions; the new fixtures own the plan/effect layer. All virtual-clock, no
Robolectric (W0b toolchain constraint stands).

## Forbidden

- No modification to `onCreate`, the two recovery helpers, or any live recovery path.
- No deletion of anything.
- No new packages/directories (M7 owns the split).
- No controller/service references inside `recover()` or the new file — it is pure:
  LoadedState/Permissions/Clock in, plan out. Any platform import (android.\*) in
  VoiceRuntimeRecovery.kt is a defect, except data types already used by the loaded
  stores' models.
- No weakening of any existing test.

## Done criteria

- `recover()` + loader-shape types + resolveWithFallback landed; full fixture matrix
  green; existing suites untouched and green; onCreate byte-identical;
  `pnpm run typecheck`, `pnpm run lint:mobile` green (Kotlin-only change should be a
  no-op for both — they still gate); tree clean.

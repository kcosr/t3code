# M6 Run 2 — onCreate Cutover + Choreography Deletion

Second M6 run; requires run 1 landed (recover(), loader shape, resolveWithFallback, and
the full fixture matrix all green with onCreate untouched). Binding inventory:
`specs/kernel-milestones/m6-seam-map.md` §1/§6/§7. Scope: cut the live startup path over
to loader → `recover()` → host sequence → effect execution, then DELETE the inline
choreography. The fixture matrix from run 1 pins behavior across the cutover.

## Review correspondence (pre-launch findings — binding)

- F2-A (widened per re-verdict): the ReconcileThreadOperation executor is the ONE
  carve-out from "dumb dispatch". It: re-loads the thread-op store fresh (live
  svc:1882); re-reads `authorityStore.load()` fresh (AFTER ConfigureCanonicalAuthority
  ran, whose failure path clears the store); computes `parentGrantAvailable` via run
  1's pure helper; calls the pure `decide` with execution-time `now`; and on REVOKE
  reads `pendingRuntimeRevocation()`/`activeAuthority()` live, invokes run 1's pure
  revocation-selection helper with the fresh grant, executes the selected effect shape
  (grant-based disable/clear/invalidate vs locked-clear + snapshot reset), resolves the
  disabled-config generation from the controller, AND performs the three field
  mutations the deleted helper performs today: `readinessConfig = disabled`
  (svc:1955), `canonicalPreparedAuthority = null` (svc:1956), `runtimeSnapshot = empty`
  on the Locked-clear branch (svc:1964). No other interpreter arm decides anything.
- F2-B: the host MUST assign `readinessConfig` and `runtimeSnapshot` (and `cueSettings`)
  from the plan before the kernel block — omitting them leaves field defaults and
  silently discards the permission overlay, reconcile results, and healed snapshot
  (invisible to the pure fixtures; the revoke executor reads `readinessConfig` at
  svc:1951).
- F2-C: interpreter arms exist for the readiness write effects
  (WriteReadiness/WriteActivatedReadiness); there is NO restoreProcess effect (it is
  internal to `startRuntimeThreadLocked`).
- F2-E: where seam-map §6/§7 says "relocate recover() to kernel/", the packets govern —
  no package moves before M7.
- Run-1 adjudication carry-forwards (binding): (a) the legacy-retirement session
  credential clear (svc:1499-1503) stays LOADER-side per the ruling documented in
  VoiceRuntimeRecovery.kt's KDoc — the cutover's loader step performs it with
  retireLegacyV2; it is NOT a plan effect. (b) The CANONICAL realtime install executor
  runs only if the ConfigureCanonicalAuthority effect succeeded
  (restoreCanonicalAuthorityLocked returned true) — mirroring live svc:1854-1856; the
  RECOVERED install is not so gated. Encode this as interpreter sequencing, not a new
  decision.

## Staging (MANDATORY — three sequential commits, each compiling and green)

A previous run blocked declaring the atomic rewrite infeasible in one turn. Do NOT
attempt it atomically. Land three commits in this order, running the module tests
between each:

1. **Commit 1 (additive scaffolding):** add to the service, UNCALLED from onCreate: the
   loader private method (assembles LoadedState + Permissions per the ordering below —
   roughly 80 lines), the effect-interpreter private method (a single `when` over
   `VoiceRuntimeRecoveryEffect`, each arm delegating to the existing executor method —
   roughly 120 lines including the ReconcileThreadOperation carve-out), and the
   host-sequence private method. Everything compiles; onCreate byte-identical; all
   suites green.
2. **Commit 2 (flip):** replace the onCreate body with the new ~15-line core (stores →
   loader → recover → deviceIdentity → controller → field assigns → kernel block
   executing plan.effects). The old choreography code and the two helpers remain in the
   file, now uncalled. Run-1 fixtures + all suites green.
3. **Commit 3 (delete):** remove the dead inline choreography remnants, the two
   helpers, and the superseded inline scenario-5 fallback. Zero references remain.

## The cutover (host sequence per run-1 ruling R-2)

`onCreate` becomes, in order:

1. Construct stores + repos (unchanged — these are loader inputs).
2. LOADER: assemble `LoadedState` (all 13 sources, seam map §2) + Permissions snapshot;
   ordering: `retireLegacyV2` before `authorityStore.load()`; snapshot read before
   `LegacyRealtimeCutover.migrate` (loader-side, current shape); the healed snapshot
   enters LoadedState.
3. `val plan = recover(loadedState, permissions, clock)`.
4. `deviceIdentity.getOrCreate(plan.installedRuntimeId)` (durable write, host).
5. Construct `voiceRuntimeController` from plan identity data (the existing ~1719-1794
   execution-closure block moves intact — it is host wiring, not decision logic).
6. ASSIGN from plan: `readinessConfig = plan.readinessConfig`,
   `runtimeSnapshot = plan.runtimeSnapshot`, `cueSettings = plan.cueSettings`,
   `canonicalPreparedAuthority = plan.canonicalPreparedAuthority` (F2-B + re-verdict).
   Then `createHostDriver()`; notification channel (unchanged host).
7. Kernel-thread block (`submitAndAwait("service-create-recovery")`): construct
   mediaDriver (unchanged), then EXECUTE `plan.effects` in emitted order via the
   effect-interpreter `when` — each effect maps to the existing method per seam map §4
   (configure authority, engine-slot recovered/canonical install, readiness writes,
   thread-op writes, revoke sequence — its disabled-config generation resolved from the
   controller at execution — restoreCompleted calls, sweepStaleCache, setServiceReady,
   ReconcileThreadOperation per F2-A, storeDriver clears with driverEpoch() at
   execution, diagnostics).

## Deletions (only after the cutover compiles against the interpreter)

- The inline decision choreography inside `onCreate` (the ~388-line body's steps 2-16,
  18, and the kernel block's decision content of steps 21-26 — everything recover() now
  owns), and the two helpers `reconcilePersistedThreadOperationLocked` +
  `revokePersistedThreadOperationLocked` (their decision halves live in the pure
  policies/helpers; the thread-op reconcile and revoke halves are invoked by the
  interpreter at execution per F2-A; the remaining effect halves live in the
  interpreter).
- The now-uncalled inline scenario-5 fallback (superseded by resolveWithFallback).
- Nothing else. Methods the interpreter calls (restoreCanonicalAuthorityLocked,
  installRecoveredRealtimeStateLocked, installRealtimeEngineLocked,
  recoverRealtimeEngineLocked, startRuntimeThreadLocked, etc.) STAY — they are effect
  executors, not choreography.

## Behavior invariants (the fixture matrix pins these; the cutover must not move them)

- All ordering invariants of seam map §7 (restore-before-sweep; ready-before-start;
  configure-before-installs/reconcile; recovered-install precedence; retire-fence before
  fence assembly — the latter is now loader-ordering).
- Failure semantics preserved verbatim: every runCatching + diagnostic on corrupt
  finalization/checkpoint/prepared-authority; readiness-reconcile failure → clear
  authority + disable + canonicalInstalled=null; cutover failure → reset snapshot + diag;
  authority Locked → non-capturing convergence. These live in recover()/loader per run 1;
  the cutover may not add or drop any.
- Foreground posture: still NOT touched by recovery (downstream only). If the cutover
  causes any startForeground on the startup path, that is a defect.
- `onStartCommand`/`onDestroy`/`onBind` untouched.

## Tests

- Run 1's fixture matrix must pass UNCHANGED — it is the cutover's safety net; any
  fixture edit in this run is a finding unless it adds assertions.
- Existing instrumented tests (`T3VoiceRuntimeServiceInstrumentedTest`) must still
  compile and their scenarios remain valid (they drive onCreate implicitly via service
  start — the recovery outcome must be observably identical).
- Add one interpreter test if expressible without Robolectric: a synthetic plan with all
  effect kinds asserts the interpreter dispatches each to the right method-shape (via a
  seam/fake if one exists cheaply; if not feasible without a harness, record why in run
  notes — do not fake it with a hollow stub).
- No test weakening anywhere.

## Forbidden

- No package moves (M7).
- No changes to recover()'s decisions — if the cutover exposes a divergence between the
  old inline behavior and recover()'s plan, STOP and surface it (that is a run-1 defect
  to fix THERE, with a fixture, not something to absorb in the interpreter).
- No new decision logic in the service — the interpreter is a dumb dispatch table, with
  EXACTLY ONE carve-out: the ReconcileThreadOperation executor's fresh authority read +
  pure-helper + pure-decide call (F2-A). Nothing else decides.

## Done criteria

- onCreate = stores + loader + recover + host sequence + interpreter (~15-line core);
  inline choreography and both helpers deleted (service ~6033 → ~5650 per seam map §6);
  fixture matrix + all suites green; both source sets compile;
  `pnpm run typecheck`, `pnpm run lint:mobile` green; tree clean.

## Run notes

- No interpreter dispatch test was added. The interpreter dispatches to service-private
  `*Locked` methods that require a service harness, while the module's JUnit4 toolchain has no
  Robolectric support (the W0b constraint). Coverage remains the run-1 fixture matrix plus the
  instrumented service tests.
- Loading a recovered thread operation calls
  `restore(threadOperation, recorder::restoreCompleted)`, and the emitted
  `RestoreCompletedRecording` effect invokes `recorder.restoreCompleted` again. This duplicate is
  benign because the completed-recording registry insert is idempotent and keyed by recording ID.

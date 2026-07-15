# M3 Run 2 — Realtime Engine → Sub-Reducer

Second M3 run (`specs/native-voice-runtime-kernel.md` M3). Converts
`VoiceRuntimeRealtimeEngine.kt` (1657 lines, 36 monitor sites) from a monitor-guarded
object called from lanes into a PURE sub-reducer invoked only on the kernel thread, with
all IO as NetDriver lane effects. READ `specs/kernel-milestones/m3-seam-map.md` §3 first.
The engine is already structured admit(pure) → IO(off-monitor) → complete(pure); this run
makes that structure the type system's problem instead of a convention.

## Target shape

- `VoiceRuntimeRealtimeReducer` (rename/rework of the engine class): every public
  entry becomes a pure function `(RealtimeState, input) -> RealtimeReduction(state,
effects, result?)` running ONLY on the kernel thread (assert). No `synchronized`
  anywhere in the file; the monitor dies.
- `RealtimeState` (new, kernel-owned; replaces the placeholder slot in
  `VoiceKernelState` doc comment): `checkpoint`, `serverSession`, `pendingStart`,
  `finalizationInFlight`, and the `commands` idempotency ledger (retained verbatim —
  M4 owns fencing changes, not this run).
- IO: the reducer emits effect descriptions (start/offer/heartbeat/pollActions/focus/
  ack/handoff-exchange/commit/close/cleanup) that the SERVICE maps onto the existing
  `VoiceNetDriver` lanes; results return via `handleDriverResult` into the matching
  `completeX` reduction. The lane routing from run 1 (REALTIME bound-4 / CONTROL
  single) is UNCHANGED.
- Sinks become return values: state/terminal/finalization/presentation outputs ride the
  `RealtimeReduction` (typed output list) and the service dispatches them AFTER the
  reduction returns — the sink callback objects, `runOnKernelThreadOrAwait`, and the
  deferral comments all die. This retires the B9 invariant for the engine (no monitor
  exists to hold); note its retirement in the commit message and in
  `specs/kernel-milestones/m2-state-capture.md` (one-line addendum).
- Ports: `peer` and `cues` remain MediaDriver calls but are now emitted as effects from
  reductions and executed by the service driver glue (peer.prepare/applyAnswer/
  setInputReady/setMuted/drainPlayout/stop; cue ready/ended). `repository` writes become
  explicit `persist` steps in the reduction outputs, sequenced per the commit-point rule
  (the former in-monitor `update()` save → now: reduction returns (state', Persist(...)
  - deferred emits); service persists via StoreDriver lane then dispatches emits on the
    Persisted continuation for checkpoint-gated outputs; cheap SharedPreferences saves may
    stay synchronous in the service glue — decide per site against the seam map and record
    the table in the commit message).

## Mandatory fixes folded in

1. The binder dispatch path currently runs `engine.stop`/`engine.setMuted` synchronously
   on the kernel thread, and `stop(IMMEDIATE)` reaches synchronous `server.close`
   (adjudication finding, banked). Under the reducer: stop admission is pure, returns
   the receipt, and emits a close effect on the CONTROL lane. Same for the notification
   stop path.
2. `reconcileFinalization`'s synchronous commit/close chain becomes effect emissions
   with completion reductions; the `remoteDispatcher` port dies.

## Test migration

The engine test suite (~40 cases in `VoiceRuntimeRealtimeEngineTest` +
`VoiceRuntimeRealtimeEngineSlotTest`) converts to reducer fixtures: same scenarios,
`(state, input) -> (state', effects, outputs)` assertions replacing port-mock
verification. Effects are DATA — assert them structurally. Do not weaken any scenario;
the packet reviewer will diff scenario names old→new. The engine-slot staged
install/deferred-swap logic: keep semantics, re-express over RealtimeState (its
slot-version CAS was deleted in M2's world only if unused — verify; the deferred
refresh-after-terminal rule is retained as reducer logic).

## Forbidden

Changing lane routing, store internals, contracts, TS, `nativeRevision`; touching M4
territory (epoch stamping, binder-generation deletion, tombstones); weakening the
idempotency ledger; leaving any `synchronized` or sink-callback in the engine file.

## Verification

1. `grep -c "synchronized\|@Synchronized" VoiceRuntimeRealtimeEngine*.kt` → 0.
2. `grep -rn "runOnKernelThreadOrAwait\|VoiceRuntimeRealtimePresentation\b.*sink\|stateSink\|terminalSink\|finalizationSink\|remoteDispatcher" apps/mobile/modules/t3-voice/android/src/main` → only reduction-output dispatch remains (zero callback-sink objects).
3. `submitAndAwait` count in the service DECREASES (record before/after; the sink-driven
   awaits die; binder value-returns remain).
4. `pnpm run typecheck` + `pnpm run lint:mobile` green.
5. Scenario-name diff old→new test suites in the commit message; zero dropped scenarios.

## Done criteria

Commits: `feat(voice): convert realtime engine to a kernel sub-reducer` (+ optional test
migration commit); tree clean; pc gate follows; then M4.

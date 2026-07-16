# M5 Run 2 — Bridge Delete Sweep (Android-unreachable surface)

Second M5 run; requires run 1 landed. Inventory and every anchor:
`specs/kernel-milestones/m5-seam-map.md` §1e/§3/§4/§5/§7 (anchors at `5a765febf`;
RE-LOCATE BY SYMBOL). Scope: delete the 17 Android-unreachable module functions, the 5
legacy events, their binder methods, transitive zero-caller helpers, the Scope-C realtime
owner policy, the realtime sticky slot, and (D6) the thread-voice-handoff state machinery.
Bump `nativeRevision` 16→17. The ui-attached TS seed is UNTOUCHED (desktop/web); only its
Kotlin reachability dies.

## Deletions (per seam-map §1e table — module fn → binder method → transitive fallout)

- The 17 module `AsyncFunction`s and their binder methods, exactly as tabulated. Honor
  every STAYS annotation: `realtime.prepare/.stop/.applyAnswer/.setMuted/.routes()` stay
  (autonomous callers); ONLY `realtime.selectRoute` goes; `controllerCommands.pending/
invalidateReadiness/isAttached/requestPrimary` stay while `register/unregister/complete`
  go; `cueSettingsStore` stays; `startRuntimeForeground`/`updateRuntimeControlSurfacesLocked`/
  `reconcileReadinessLocked`/`cancelRealtimeReadyCueLocked` stay.
- Transitive helpers: `disablePendingCuesLocked`, `drainRealtimeForStopLocked` (its F2
  retire/disarm lines die with it — its callees stay), `expireThreadVoiceHandoffLocked`,
  `T3VoiceState.beginThreadVoiceHandoffAdoption`/`markThreadVoiceHandoffAdopted`.
- Module `registeredControllerGeneration` field + the `OnDestroy` unregister block
  (module:228-231) — dead once unregister dies.
- Events `stateChanged`, `audioRouteChanged`, `realtimeTerminated`, `threadVoiceHandoff`,
  `voiceCommand` + their module collectors and the binder StateFlow getters
  (`realtimeTermination` svc:287, `threadVoiceHandoff` :296, `voiceCommands` :299) + the
  now-unused event-body data classes (State.kt:113/:128/:143). The `AudioRouteChanged`/
  `RealtimeError`→`realtimeTerminated` emits into the events flow (State emit sites,
  seam-map §4) go with their events; `runtimeError` emission STAYS.
- `mutableRealtimeTermination` slot: delete decl/expose (State.kt:206/:220), the slot
  write inside `terminateRealtime` (State.kt:539) — the TRANSITION ITSELF STAYS (autonomous
  engine) — and the synthetic binder-loss emission (module:992-1002).
- Scope-C: `T3VoiceBindingRealtimeOwnerPolicy` (whole file) + module wiring (:37/:83/
  :85/:103/:987) + its test file. `T3VoiceBinderOperationRegistry` and the dispatcher/
  admission STAY (they underlie the KEEP surface).
- D6 — handoff machinery: `mutableThreadVoiceHandoff` + `publishThreadVoiceHandoff`/
  `clearThreadVoiceHandoff`/`pendingThreadVoiceHandoff`/`isThreadVoiceHandoffRecordingProtected`
  - adoption claims/sets (State.kt:213-216/:229-/:245-/:257-/:272-/:280-/:288-/:293-299)
  - the REALTIME_HANDOFF slot write (:417) + `realtimeHandoffRecordingTermination` var
    (:212) + service shutdown clears (svc:2435-2437) and protection reads (:5778/:5784, both
    in deleted functions). VERIFY FIRST (implementer + reviewer, blocking): the kernel
    engine's handoff saga (`VoiceRuntimeRealtimeEngine` HandoffToThreadVoice path) reads
    NONE of this — grep the engine + reducer for these symbols; if any live read exists,
    STOP and surface it in the run notes instead of deleting.
- `HANDOFF_CLIENT_*` diagnostic codes go unused → remove from the enum only if nothing
  else references them (check diagnostics tests).

## TS side

- `T3Voice.types.ts`: LEAVE all 17 interface members + event names (ui-attached seed
  compiles against them; module functions are Android-runtime-absent, which is invisible
  to tsc — seam-map §6).
- `nativeRevision` 16→17 (module constant + index.ts:48 + index.test.ts gates).
- No live-Android TS uses any deleted function (verified in seam map — the
  `androidVoiceRuntime.ts` Pick excludes them all).

## Forbidden

- Nothing from the KEEP surface (35 functions, 5 events post-run-1) changes shape.
- No deletion of any TS on the ui-attached path; no interface-member removal.
- No touching run 1's conversion machinery.
- `T3VoiceStateStore.state`/`events` and the claim/release/terminate transitions stay
  (autonomous arbiter — seam-map §4 MUST-SURVIVE list).

## Tests (seam-map §7 dispositions are binding)

- DIE: the nine ThreadVoiceHandoff State-store tests; `realtimeVoiceController.test.ts`;
  `threadVoiceHandoffReconciler.test.ts`; `T3VoiceBindingRealtimeOwnerPolicyTest.kt`; the
  ~15 NativeVoiceCommand blocks in `nativeVoiceReadiness.test.ts`; the bridge-realtime
  instrumented scenario (`realtimeSurvivesUnbindAndNotificationStopAfterRebind`) —
  re-express its intent against the autonomous realtime entry if feasible in-module,
  otherwise record why not in the run notes.
- SPLIT files: delete only the listed methods/blocks; the KEPT scenarios must remain
  passing and UNWEAKENED (M0's silent test-deletion is the standing cautionary tale —
  the adjudicator diffs test files line-by-line).
- Both source sets: `src/test` AND `src/androidTest` must compile (instrumented set broke
  silently once before; the pc gate compiles it).

## Done criteria

- Module surface: 35 functions (20 protocol + 9 media + 6 perm/diag), 5 events; revision
  17 both sides; zero references to any deleted symbol; `pnpm run typecheck`,
  `pnpm run lint:mobile`, module unit tests green; tree clean.

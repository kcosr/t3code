# M5 Run 2 — Bridge Delete Sweep (Android-unreachable surface)

Second M5 run; requires run 1 landed (run 1 already removed the handoff chain and the
two termination slots). Inventory: `specs/kernel-milestones/m5-seam-map.md` §1e/§3/§5/§7
(anchors at `5a765febf`; RE-LOCATE BY SYMBOL). Scope: delete the 12 remaining
Android-unreachable module functions, 4 legacy events, their binder methods, transitive
zero-caller helpers, the Scope-C realtime owner policy, the realtime sticky slot, and
the caller-less revocation acknowledge. Bump `nativeRevision` 16→17. The ui-attached TS
seed is UNTOUCHED; only its Kotlin reachability dies.

## Review correspondence

- F6: the D6 blocking-verify belongs to run 1 (retargeted to `publishThreadVoiceHandoff`
  producers) and was moved there with the whole handoff chain. This run's list is the
  seam-map §1e table MINUS the five handoff functions and the `threadVoiceHandoff` event.
- L4: handoff readers of the composer slot were resolved in run 1. EXPECTED SURVIVORS
  at this run's base (re-verdict R2-A — do NOT treat as a run-1 failure): the vestigial
  fields `handoffInProgress`, `awaitingHandoffAction`, `handoffEligibleSessionId`,
  `handoffEnvironmentOrigin` and helper `clearHandoffEligibilityLocked`. THIS run
  disposes of them: once the realtime binders die they have zero real writers — delete
  the four fields + the helper and simplify the constant-false/null conditions at their
  read sites (svc:424/:1592/:1612/:1645/:1671 old anchors — relocate by symbol).
  Semantics-preserving on Android: arm was ui-attached-only (died in run 1) and prepare
  dies here, so the fields are never true/non-null in autonomous production today. Any
  OTHER handoff symbol at base → STOP: run 1 did not complete its scope.
- F2 ruling (run 1): groups C/D keep their existing model. This run deletes ONLY the
  caller-less `acknowledgeVoiceRuntimeAuthorityRevocationAsync`; the getter and the
  readiness-disabled pair and `readinessDisabled` event STAY.

## Deletions (seam-map §1e table minus handoff; STAYS annotations are binding)

- The 12 module `AsyncFunction`s + their binder methods: `getMediaCapabilitiesAsync`,
  `setVoiceCuesEnabledAsync`, `registerVoiceControllerAsync`,
  `unregisterVoiceControllerAsync`, `getPendingVoiceCommandAsync`,
  `completeVoiceCommandAsync`, `prepareRealtimeSessionAsync`, `applyRealtimeAnswerAsync`,
  `stopRealtimeSessionAsync`, `drainAndStopRealtimeSessionAsync`, `setRealtimeMutedAsync`,
  `setAudioRouteAsync`. Honor every STAYS: `realtime.prepare/.stop/.applyAnswer/
.setMuted/.routes()` stay (autonomous `realtimePeerPort`); ONLY `realtime.selectRoute`
  goes (verified sole caller = deleted `setAudioRoute` binder);
  `controllerCommands.pending/invalidateReadiness/isAttached/requestPrimary` stay while
  `register/unregister/complete` go; `cueSettingsStore` stays;
  `startRuntimeForeground`/`updateRuntimeControlSurfacesLocked`/
  `reconcileReadinessLocked`/`cancelRealtimeReadyCueLocked` stay.
- Plus `acknowledgeVoiceRuntimeAuthorityRevocationAsync` (zero TS callers anywhere —
  verified) + its binder `acknowledgeRuntimeRevocation` (svc:442-504 old anchors) +
  `T3VoiceRevocationAcknowledgementCoordinator` IF the binder was its last caller
  (VERIFY: grep for other coordinator callers; if a native/recovery caller exists, keep
  the coordinator and delete only the bridge layer, and record it in the run notes).
  Note this removes an F2-era `retireThreadTurnEpoch` call site inside the dead closure —
  fine, the path was unreachable from TS.
- Transitive helpers: `disablePendingCuesLocked`, `drainRealtimeForStopLocked` (its F2
  retire/disarm lines die with it — its callees stay).
- Module `registeredControllerGeneration` field + `OnDestroy` unregister block
  (module:228-231).
- Events `stateChanged`, `audioRouteChanged`, `realtimeTerminated`, `voiceCommand` +
  module collectors + binder StateFlow getters (`realtimeTermination` svc:287,
  `voiceCommands` :299) + now-unused event bodies (State.kt:113/:128). The
  `AudioRouteChanged`/`RealtimeError`→`realtimeTerminated` emits go with their events;
  `runtimeError` emission STAYS.
- `mutableRealtimeTermination` slot: decl/expose (State.kt:206/:220) + the slot write
  inside `terminateRealtime` (:539) — the TRANSITION ITSELF STAYS (autonomous engine,
  svc callers in `handleRealtimeTerminatedLocked`) — + the synthetic binder-loss
  emission (module:992-1002).
- Scope-C: `T3VoiceBindingRealtimeOwnerPolicy` (whole file) + module wiring
  (:37/:83/:85/:103/:987) + its test file. `T3VoiceBinderOperationRegistry` and the
  dispatcher/admission STAY (they underlie the KEEP surface).

## TS side

- `T3Voice.types.ts`: LEAVE the deleted functions' interface members + event names
  (ui-attached seed compiles against them; Kotlin absence is invisible to tsc).
- `nativeRevision` 16→17 (module + index.ts:48 + index.test.ts gates).
- No live-Android TS uses any deleted function (the `androidVoiceRuntime.ts` Pick
  excludes them all — verified).

## Forbidden

- Nothing from the KEEP surface or run 1's conversion machinery changes shape.
- Groups C/D untouched except the one dead ack function above.
  `T3VoiceReadinessStore.acknowledgeRuntimeRevocation` (Readiness.kt:437-444) becomes
  zero-caller as a result and REMAINS AS-IS (R2-B) — the C/D-untouched rule wins over
  dead-symbol sweeping; it is cleaned up when notice unification is designed post-M7.
- No TS deletion on the ui-attached path; no interface-member removal.
- `T3VoiceStateStore.state`/`events` and all claim/release/terminate transitions stay.

## Tests (seam-map §7, minus what run 1 already took)

- DIE: `realtimeVoiceController.test.ts` (whole file — subject is the deleted bridge
  realtime API); `T3VoiceBindingRealtimeOwnerPolicyTest.kt`; the ~15 NativeVoiceCommand
  blocks in `nativeVoiceReadiness.test.ts` (readiness-gating and disable blocks KEPT);
  `terminalStateIsDurableAndRejectsStaleUpdates` re-expressed without the realtime slot;
  the bridge-realtime instrumented scenario
  (`realtimeSurvivesUnbindAndNotificationStopAfterRebind`) — re-express against the
  autonomous realtime entry if feasible, else record why not.
- SPLIT files: delete only the listed blocks; KEPT scenarios remain passing and
  UNWEAKENED (adjudicator diffs test bodies).
- Both source sets compile: `src/test` AND `src/androidTest`.

## Done criteria

- Post-M5 module surface: 43 functions (20 protocol + 9 media + 6 perm/diag + 5
  converted A/B + 3 kept C/D), 6 events (`playbackChunkConsumed`, `runtimeError`,
  `voiceRuntimeWake`, wake-only `recordingTerminated`/`playbackTerminated`,
  `readinessDisabled`); revision 17 both sides; zero references to any deleted symbol;
  `pnpm run typecheck`, `pnpm run lint:mobile`, module unit tests green; tree clean.

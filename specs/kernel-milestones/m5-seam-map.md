# M5 Seam Map (bridge cutover — post-M4 tree @ 5a765febf)

Authoritative inventory for the M5 packets; produced by orchestrator audit. Scope per
`specs/native-voice-runtime-kernel.md` Bridge section (:421-472) and Migration M5 (:537-541);
Scope C inherited from `specs/kernel-milestones/m4-epoch-consolidation.md` (:62-66). All anchors
at HEAD `5a765febf`. The ui-attached TypeScript orchestrator (MasterVoiceProvider ui-attached
body, realtimeVoiceController, useAutoListenController, useThreadVoiceComposerController.ts) is the
desktop/web seed and is DELIBERATELY RETAINED — M5 removes only Kotlin the Android path can no
longer reach; no TS on that path is proposed for deletion here.

Absolute file roots (omitted below for brevity):

- Module: `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/T3VoiceModule.kt`
- Service: `.../t3voice/T3VoiceRuntimeService.kt` (6385 lines)
- State: `.../t3voice/T3VoiceState.kt`; Readiness/controller: `.../t3voice/T3VoiceReadiness.kt`
- Binder fencing: `.../t3voice/T3VoiceBinderOperationRegistry.kt`, `.../T3VoiceBindingRealtimeOwnerPolicy.kt`
- TS module pkg `@t3tools/mobile-voice-native`: `apps/mobile/modules/t3-voice/src/{index.ts,T3Voice.types.ts}`
- TS voice features: `apps/mobile/src/features/voice/*`

---

## 1. Module surface census

Module registers **61 `AsyncFunction`s + 11 `Events`** (`Events(...)` :194-206; `Constants nativeRevision→15` :209). The spec's "~64 functions / 11 events" predates **W0a**: the three
"zero JS caller" functions (`setReadinessSnapshotAsync`, `getBluetoothPermissionAsync`,
`requestBluetoothPermissionAsync`) are **already deleted** — grep across the module returns 0 hits.
So the M5 DELETE workload for those three is already discharged (drift item D1).

### 1a. KEEP — canonical protocol (20 in code; spec says 19 — drift D2)

| #   | AsyncFunction                                    | Module line | live autonomous caller (TS)             |
| --- | ------------------------------------------------ | ----------- | --------------------------------------- |
| 1   | `describeVoiceRuntimeAsync`                      | :263        | androidVoiceRuntime.ts:72               |
| 2   | `getVoiceRuntimeSnapshotAsync`                   | :267        | androidVoiceRuntime.ts:73               |
| 3   | `inspectVoiceRuntimeAuthorityAsync`              | :273        | provisioning (inspect)                  |
| 4   | `configureVoiceRuntimeAuthorityAsync`            | :283        | androidVoiceRuntime.ts:74               |
| 5   | `setVoiceRuntimeSessionCredentialAsync`          | :296        | nativeVoiceRuntimeProvisioning.ts:64    |
| 6   | `clearVoiceRuntimeAuthorityAsync`                | :319        | androidVoiceRuntime.ts:75               |
| 7   | `attachVoiceRuntimeAsync`                        | :330        | androidVoiceRuntime.ts:76               |
| 8   | `updateVoiceRuntimeAttachmentAsync`              | :350        | androidVoiceRuntime.ts:77               |
| 9   | `detachVoiceRuntimeAsync`                        | :367        | androidVoiceRuntime.ts:78               |
| 10  | `readVoiceRuntimeAsync`                          | :374        | androidVoiceRuntime.ts:126              |
| 11  | `acknowledgeVoiceRuntimeAsync`                   | :393        | androidVoiceRuntime.ts:79               |
| 12  | `acknowledgeVoiceRuntimeRetainedRecordAsync`     | :411        | (typed in Pick, not yet wired — see §2) |
| 13  | `dispatchVoiceRuntimeAsync`                      | :423        | androidVoiceRuntime.ts:80               |
| 14  | `readVoiceRuntimeDraftArtifactAsync`             | :435        | androidVoiceRuntime.ts:81               |
| 15  | `acknowledgeVoiceRuntimeDraftArtifactAsync`      | :449        | androidVoiceRuntime.ts:82               |
| 16  | `claimVoiceRuntimePresentationActionAsync`       | :469        | androidVoiceRuntime.ts:83               |
| 17  | `acknowledgeVoiceRuntimePresentationActionAsync` | :487        | androidVoiceRuntime.ts:84               |
| 18  | `disableVoiceRuntimeReadinessAsync`              | :510        | nativeVoiceRuntimeProvisioning.ts:67    |
| 19  | `clearVoiceRuntimeAuthorityIfIdleAsync`          | :517        | nativeVoiceRuntimeProvisioning.ts:71    |
| 20  | `getVoiceRuntimeOwnershipAsync`                  | :539        | nativeVoiceRuntimeProvisioning.ts:75    |

**Drift D2:** the spec's protocol list (`kernel:445-448`) enumerates "prepare/inspect/configure/
clear(+IfIdle) authority" — there is **no** `prepareVoiceRuntimeAuthorityAsync` in code, and code
carries an un-enumerated `setVoiceRuntimeSessionCredentialAsync` (the raw-token carrier alluded to
at `kernel:472`). Net **20** live protocol functions. Event `voiceRuntimeWake` (:205) is the KEEP
protocol event.

### 1b. KEEP — media (9)

`startRecordingAsync` :673, `stopRecordingAsync` :696, `cancelRecordingAsync` :706,
`deleteRecordingAsync` :713, `startPlaybackAsync` :740, `enqueuePlaybackChunkAsync` :750,
`finishPlaybackAsync` :762, `cancelPlaybackAsync` :772, `getAudioRoutesAsync` :943. Events:
`playbackChunkConsumed` :196, `runtimeError` :199. **Coupling risk (see §8):** `deleteRecordingAsync`
(KEEP) reads the sticky `recordingTermination` slot to validate bridge ownership (service :606-613)
— it depends on a CONVERT-group slot.

### 1c. KEEP — permissions / diagnostics (6)

`getStateAsync` :259, `getMicrophonePermissionAsync` :641, `requestMicrophonePermissionAsync` :649,
`getNotificationPermissionAsync` :657, `requestNotificationPermissionAsync` :665,
`getDiagnosticsAsync` :949. `getStateAsync` reads `T3VoiceStateStore.state` (see §4).

### 1d. CONVERT — the four live pending/ack groups (9 functions; detailed in §2)

- Composer-recording termination: `acknowledgeRecordingTerminationAsync` :723,
  `discardUnownedRecordingTerminationAsync` :731, `getPendingRecordingTerminationAsync` :793.
- Manual-playback termination: `acknowledgePlaybackTerminationAsync` :779,
  `getPendingPlaybackTerminationAsync` :787.
- Readiness-disabled notice: `getPendingReadinessDisabledAsync` :603,
  `acknowledgeReadinessDisabledAsync` :609.
- Authority-revocation notice: `getPendingVoiceRuntimeAuthorityRevocationAsync` :533,
  `acknowledgeVoiceRuntimeAuthorityRevocationAsync` :545.

### 1e. DELETE (17 functions + 5 events)

All 17 verified **bridge-only**: every binder method they call is invoked _only_ from the module;
the autonomous runtime calls the underlying `realtime` driver / `*Locked` helpers directly. So each
binder method becomes **ZERO-CALLER** on deletion. Chain and transitive fallout:

| Module fn (line)                                | binder method (svc line)                   | transitive newly-zero-caller                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getMediaCapabilitiesAsync` :248                | _(none — pure module map)_                 | —                                                                                                                                                                                                                                                                                                              |
| `setVoiceCuesEnabledAsync` :568                 | `setVoiceCuesEnabled` :877                 | `disablePendingCuesLocked` :1747 (deletable); `cueSettingsStore` STAYS                                                                                                                                                                                                                                         |
| `registerVoiceControllerAsync` :577             | `registerVoiceController` :495             | `T3VoiceControllerCommands.register` STAYS-nowhere (deletable); `startRuntimeForeground`/`updateRuntimeControlSurfacesLocked` STAY                                                                                                                                                                             |
| `unregisterVoiceControllerAsync` :587           | `unregisterVoiceController` :513           | `controllerCommands.unregister` deletable. **Nuance:** also textually called at `OnDestroy` module :229, guarded by `registeredControllerGeneration` (field :47, set only in :582); after item deleted the guard stays null → :228-231 block is dead and must be removed too. `reconcileReadinessLocked` STAYS |
| `getPendingVoiceCommandAsync` :597              | `pendingVoiceCommand` :522                 | `controllerCommands.pending` STAYS (autonomous getter :300)                                                                                                                                                                                                                                                    |
| `completeVoiceCommandAsync` :624                | `completeVoiceCommand` :525                | `controllerCommands.complete` deletable                                                                                                                                                                                                                                                                        |
| `getPendingThreadVoiceHandoffAsync` :799        | `pendingThreadVoiceHandoff` :649           | helpers STAY (see §4 handoff note)                                                                                                                                                                                                                                                                             |
| `acknowledgeThreadVoiceHandoffAsync` :805       | `acknowledgeThreadVoiceHandoff` :704       | `T3VoiceState.markThreadVoiceHandoffAdopted` :280 deletable                                                                                                                                                                                                                                                    |
| `armThreadVoiceHandoffAsync` :817               | `armThreadVoiceHandoff` :720               | sets `awaitingHandoffAction`/`handoffEligibleSessionId` — arming goes inert (see §4)                                                                                                                                                                                                                           |
| `prepareRealtimeSessionAsync` :824              | `prepareRealtimeSession` :777              | drivers `realtime.prepare`/`.stop` STAY (autonomous `realtimePeerPort` :4722/:4770)                                                                                                                                                                                                                            |
| `applyRealtimeAnswerAsync` :881                 | `applyRealtimeAnswer` :832                 | `realtime.applyAnswer` STAYS (:4747)                                                                                                                                                                                                                                                                           |
| `stopRealtimeSessionAsync` :913                 | `stopRealtimeSession` :840                 | `cancelRealtimeReadyCueLocked`/`realtime.stop` STAY                                                                                                                                                                                                                                                            |
| `drainAndStopRealtimeSessionAsync` :922         | `drainAndStopRealtimeSession` :848         | `drainRealtimeForStopLocked` :1605 deletable (its callees STAY)                                                                                                                                                                                                                                                |
| `setRealtimeMutedAsync` :932                    | `setRealtimeMuted` :859                    | `realtime.setMuted` STAYS (:4763)                                                                                                                                                                                                                                                                              |
| `recordThreadVoiceHandoffClientStageAsync` :955 | `recordThreadVoiceHandoffClientStage` :867 | pure diagnostics; `HANDOFF_CLIENT_*` codes go unused (enum cleanup)                                                                                                                                                                                                                                            |
| `beginThreadVoiceHandoffAdoptionAsync` :964     | `beginThreadVoiceHandoffAdoption` :665     | `expireThreadVoiceHandoffLocked` :5777 deletable; `T3VoiceState.beginThreadVoiceHandoffAdoption` :257 deletable                                                                                                                                                                                                |
| `setAudioRouteAsync` :972                       | `setAudioRoute` :887                       | **`realtime.selectRoute`** :888 becomes ZERO-CALLER (no autonomous caller — route selection is the `set-audio-route` runtime command, contracts:596-599). Contrast `realtime.routes()` :863 kept alive by `getAudioRoutesAsync`                                                                                |

DELETE events (module Events block): `stateChanged` :195, `audioRouteChanged` :200,
`realtimeTerminated` :201, `threadVoiceHandoff` :202, `voiceCommand` :203. Their binder StateFlow
getters `realtimeTermination` :287, `threadVoiceHandoff` :296, `voiceCommands` :299 lose their sole
(bridge) reader.

**Already-gone dead code (drift D3):** `executeRealtimeHandoff` and `completionLock` — the spec's
M5 "delete dead code" list — return **0 hits** module-wide (removed in M4). The **interrupt lane**
(spec M5 :464) is also gone (deleted in M1); remaining `interrupt` tokens are unrelated
(`InterruptedException` mailbox :71-73, `interruptionPolicy` command field, engine `recoverInterrupted`).

**Net post-M5 surface:** 20 protocol + 9 media + 6 perm/diag = **35 KEEP functions**; the 9 CONVERT
functions collapse (terminations → completion handles on the media results; the two notices fold
into the existing `acknowledgeVoiceRuntimeRetainedRecordAsync` + rebase). Events: KEEP
`playbackChunkConsumed`, `runtimeError`, `voiceRuntimeWake` = **3** (spec's "~6" retains the two
termination events; see drift D4 in §8).

---

## 2. Four live pending/ack groups → conversion targets

Retained-record substrate already present (the conversion pattern is concrete): the journal exposes
`VoiceRuntimeRetainedRecordKey` (CoreModels :140-154; variants `ThreadReceipt`, `RealtimeTerminal`),
acknowledged via binder `acknowledgeVoiceRuntimeRetainedRecord` (svc :1078-1083 →
`voiceRuntimeController.acknowledgeRetainedRecord`), and redelivered by **rebase**
(`VoiceRuntimeDelivery.Rebase`, Journal.kt :56-71; reasons `CURSOR_TOO_OLD`/`RUNTIME_REPLACED`/
`GENERATION_CHANGED`, CoreModels :162-166). The two notices become new `RetainedRecordKey` variants
carried in the journal snapshot; the two terminations become per-operation bridge completion handles
(ownership spec:318-324 — the sticky global slots are removed there).

### Group A — composer-recording termination (in-memory sticky slot)

- **Holder:** `T3VoiceStateStore.mutableRecordingTermination` StateFlow (State.kt :208, exposed :222;
  binder getter svc :290).
- **Write sites:** `terminateRecordingLocked` (svc :5847) → `T3VoiceStateStore.terminateRecording`
  (State.kt :409, COMPOSER_DICTATION → :416). Callers of `terminateRecordingLocked`: recorder terminal
  `handleRecorderTerminatedLocked` :1420/:1435/:1448 (completed/cancelled/failed), setInactive :2416,
  discard path :5708.
- **Bridge get/ack:** `pendingRecordingTermination` :646 (get), `acknowledgeRecordingTermination`
  :618 (ack → `clearRecordingTermination` State.kt :438), `discardUnownedRecordingTermination` :622
  (mailbox; guarded by `isThreadVoiceHandoffRecordingProtected`). Also read by KEEP `deleteRecording`
  :606-613.
- **TS drivers:** `useComposerDictation` — pending :308, ack :311/:342/:360/:374, discard via
  `dictationTermination.ts:28` (from :337).
- **Replacement:** per-operation completion handle on the recording stop/cancel result (ownership
  spec:318-324). `deleteRecording`'s validation must be re-sourced from the handle/registry.

### Group B — manual-playback termination (in-memory sticky slot)

- **Holder:** `T3VoiceStateStore.mutablePlaybackTermination` StateFlow (State.kt :210, exposed :224;
  binder getter svc :293).
- **Write sites:** `terminatePlaybackLocked` (svc :5871) → `T3VoiceStateStore.terminatePlayback`
  (State.kt :491, MANUAL_PLAYBACK → :497). Callers: `cancelPlayback` :761, PCM finished
  `handlePcmFinishedLocked` :1466, setInactive :2429, player-terminal :3717, discard :5724.
- **Bridge get/ack:** `pendingPlaybackTermination` :774 (get), `acknowledgePlaybackTermination`
  :770 (ack → `clearPlaybackTermination` State.kt :502). No discard variant.
- **TS drivers:** `useThreadSpeech` — pending :228/:441, ack :181.
- **Replacement:** per-operation completion handle on the playback stop/cancel result.

### Group C — readiness-disabled notice (already SharedPreferences-durable)

- **Holder:** `T3VoiceReadinessStore`, pref key `pending_disabled_generation` (Readiness.kt
  :524; read `pendingDisabled()` :446-450 returns a `T3VoiceRuntimeEvent.ReadinessDisabled`;
  ack `acknowledgePendingDisabled()` :502-506).
- **Write site:** `disableReadinessLocked` (svc :5948) → `readinessStore.writeDisabledWithPending`
  (:6007 → Readiness.kt :462-500, sets pending_disabled_generation) — the _notification-disable_
  path (caller svc :2321). Note the _conditional/in-app_ disable `disableRuntimeVoiceReadinessLocked`
  (svc :341) uses `writeDisabledForRuntimeRevocation` (:369) which does **not** set pending-disabled.
- **Event:** `T3VoiceStateStore.emit(ReadinessDisabled(...))` at svc :6051-6053 → module events
  collector :125-126 → `readinessDisabled` event :204.
- **TS driver (LIVE, autonomous):** `AutonomousAndroidMasterVoiceProvider.tsx` :417 (getPending)/:423
  (ack), via generic `reconcilePendingNativeReadinessDisable` (`nativeVoiceReadiness.ts:134-137`).
  (ui-attached also wires it at MasterVoiceProvider.tsx :1371/:1344/:1379.)
- **Replacement:** the `readinessDisabled` event becomes a retained-record **wake**; the durable
  pending flag is already a natural retained record acknowledged via
  `acknowledgeVoiceRuntimeRetainedRecordAsync` + rebase redelivery (contracts model).

### Group D — authority-revocation notice (already SharedPreferences-durable)

- **Holder:** `T3VoiceReadinessStore`, pref keys `pending_revocation_runtime_id` /
  `pending_revocation_environment_origin` (Readiness.kt :532-534; read `pendingRuntimeRevocation()`
  :392-400; ack `acknowledgeRuntimeRevocation()` :437-444).
- **Write sites:** `writeDisabledForRuntimeRevocation` (Readiness.kt :402-435; from
  `disableRuntimeVoiceReadinessLocked` svc :369) **and** `writeDisabledWithPending` (from
  `disableReadinessLocked` svc :6007). So groups C and D are written at the same disable sites.
- **Bridge get/ack:** `pendingRuntimeRevocation` :390 (get), `acknowledgeRuntimeRevocation` :422
  (ack; wraps `T3VoiceRevocationAcknowledgementCoordinator` clearing thread-operation + fence).
- **TS driver (LIVE, autonomous):** `AutonomousAndroidMasterVoiceProvider.tsx` :443 consumes
  `getPendingVoiceRuntimeAuthorityRevocationAsync`. **CRITICAL (drift D5):**
  `acknowledgeVoiceRuntimeAuthorityRevocationAsync` has **NO TS caller anywhere** (declared only at
  T3Voice.types.ts:453). The autonomous provider retires a pending revocation via the _provisioning_
  path — `disableVoiceRuntimeReadinessAsync` (nativeVoiceRuntimeProvisioning.ts:67) +
  `clearVoiceRuntimeAuthorityIfIdleAsync` (:71) — never via the dedicated acknowledge. So the
  acknowledge half of group D has no consumer to migrate; the packet author must decide whether the
  binder ack survives (recovery-only) or is deleted with the getter reshaped to a retained record.

---

## 3. Sticky termination StateFlows + interrupt lane

All three sticky termination StateFlows live in `T3VoiceStateStore` and are surfaced through the
binder:

| StateFlow                                         | State.kt decl / expose | binder getter       | writers                                                      | readers                                                                                                            |
| ------------------------------------------------- | ---------------------- | ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `mutableRecordingTermination`                     | :208 / :222            | svc :290            | `terminateRecording` :416; cleared :438/:442, :613/:619/:641 | `pendingRecordingTermination` :647, `deleteRecording` :607, discard :628, adoption :259/:304, restore :2201, :5764 |
| `mutablePlaybackTermination`                      | :210 / :224            | svc :293            | `terminatePlayback` :497; cleared :502                       | `pendingPlaybackTermination` :775                                                                                  |
| `mutableRealtimeTermination`                      | :206 / :220            | svc :287            | `claimRealtime` :327 (nulls), `terminateRealtime` :539       | binder getter only (ui-attached realtime)                                                                          |
| `realtimeHandoffRecordingTermination` (plain var) | :212                   | _(not a StateFlow)_ | `terminateRecording` REALTIME_HANDOFF :417                   | pending :425, clear :431, adoption :260                                                                            |

**`mutableRealtimeTermination` → DELETE:** its only reader is the binder getter (svc :287) feeding
the deleted `realtimeTerminated` event; the module also emits a synthetic one on binder loss
(:992-1002). The `terminateRealtime` state transition (svc :527-541) STAYS for the autonomous engine,
but the slot write (:539) and getter die.

**Interrupt lane:** none exists at HEAD. Deleted in M1 (spec Migration :521-522). No interrupt
StateFlow/queue/lane in service or binder. (Remaining `interrupt` mentions are unrelated — §1e D3.)

---

## 4. T3VoiceStateStore — writers, readers, survival

`T3VoiceStateStore` (State.kt :190-607) is a global singleton with four roles; **it is not merely a
JS read model** — it is the live media/phase arbiter the autonomous runtime is built on. M4 Scope A
already collapsed its CAS machinery to plain writes (`claimIdle` :575, `updateIfOwner` :582,
`updateIfOperationOwner` :595 — no `compareAndSet`/`nextOperationGeneration` remain).

**MUST SURVIVE (KEEP surface + autonomous arbiter depends on it):**

- `state` StateFlow (:218) — the phase/owner model (INACTIVE/IDLE/ARMING/RECORDING/PLAYING/REALTIME +
  activeRecordingId/PlaybackId/RealtimeSessionId). Read ~50 sites in service as the resource arbiter
  (e.g. IDLE gates :475/:1662/:1758, foreground reconcile :2331/:2341, ownership :395). **KEEP
  `getStateAsync`** (:259) reads `state.value.toEventBody()`. Claim/release/mark API — `claimRecording`
  :361 (svc :544), `releaseRecording` :389, `markRecordingStarted` :400, `claimPlayback` :451 (svc
  :5820), `releasePlayback` :479, `claimRealtime` :313 (svc :785 bridge **and** :4720 autonomous),
  `releaseRealtimeClaim` :331 (svc :814/:4771), `setRealtime` :508, `terminateRealtime` :527 (svc
  :1536/:1558), `setServiceReady`/`setForeground`/`setInactive` :343/:357/:543.
- `events` SharedFlow (:219) + `emit` (:558) — carries the KEEP events `playbackChunkConsumed`
  (svc :1378), `runtimeError` (svc :2866/:3790/:3861/:3937/:3978/:5347), `voiceRuntimeWake` (svc :2139).
  **Survives**, but must shed its DELETE consumers (`AudioRouteChanged` emit :1392, `RealtimeError`
  emit :1404 → the deleted `audioRouteChanged`/`realtimeTerminated` events; the module swallows
  `PlaybackTerminated`/`RecordingTerminated` from this channel at :116-117).

**DELETE (remaining consumers to remove):**

- Sticky termination slots `mutableRecordingTermination`/`mutablePlaybackTermination`/
  `mutableRealtimeTermination`/`realtimeHandoffRecordingTermination` (:206-212) and their
  clear/terminate/pending API (§3). Converted (A/B) or dead (realtime).
- Legacy events: `stateChanged` (module collector :98-108 over `state`), `audioRouteChanged`,
  `realtimeTerminated`, `threadVoiceHandoff`, `voiceCommand`. Their event-body shapes on the
  data classes (`AudioRouteChanged` :113, `RealtimeTerminated` :128, `ThreadVoiceHandoff` :143)
  become unused.
- Thread-voice-handoff **adoption machinery** — `beginThreadVoiceHandoffAdoption` :257,
  `isThreadVoiceHandoffAdoptionClaimed` :272, `markThreadVoiceHandoffAdopted` :280,
  `isThreadVoiceHandoffAdopted` :288, plus `threadVoiceHandoffAdoptionClaims` map :216 and
  `adoptedThreadVoiceHandoffRecordingIds` set :215 — bridge-only (§1e items 8/16). Deletable.

**HANDOFF DECISION ITEM (drift D6):** the base handoff state `mutableThreadVoiceHandoff` (:213,
exposed :226, binder getter svc :296) plus `publishThreadVoiceHandoff` :229 / `clearThreadVoiceHandoff`
:245 / `pendingThreadVoiceHandoff` :299 / `isThreadVoiceHandoffRecordingProtected` :293 has a native
**producer** (the REALTIME_HANDOFF recording termination :417, and shutdown clears svc :2435-2437,
protection reads :5778/:5784) even though every handoff **bridge consumer** (arm/getPending/ack/
beginAdoption/recordStage) is in the DELETE set and the JS adopter is ui-attached-only. The binder
getter (:296) and the `threadVoiceHandoff` event die; the packet author must decide whether the
native handoff producer half is itself dead on autonomous (memory: ui-attached seed) and leaves
entirely, or whether the internal handoff record stays for native realtime→thread handoff. Resolve
before deleting `publishThreadVoiceHandoff`/`mutableThreadVoiceHandoff`.

`T3VoiceControllerCommands` (Readiness.kt :669-721) — the `voiceCommand` backing (StateFlow
`mutablePending` :671). `register`/`unregister`/`complete` (:677/:684/:714) become zero-caller
(bridge-only, §1e items 3/4/6). `pending`/`invalidateReadiness`/`isAttached`/`requestPrimary`
(:674/:695/:692/:700) STAY (autonomous thread-mode control uses `requestPrimary`; getter :300 dies).

---

## 5. Scope-C binder fencing (deferred from M4)

M4 fenced these to M5 (m4:62-66). All three still exist at HEAD:

1. **`T3VoiceBinderOperationRegistry`** (own file, 92 lines) — binder-generation stamps + `isActive`
   re-checks. `binderGeneration` field :27, `complete` :70, `isActive` :77. Module usage:
   `pendingBinderOperations` :36, `register` :1082, `connected` :91, `disconnected` :989,
   `complete` :1101/:1167, `isActive` :1128, `timeout` :1114, `destroy` :232, `Dispatch.binderGeneration`
   :1103/:1131/:1154. **This is the generic pending-promise manager for ALL 61 bridge operations**
   (KEEP included) — it does not disappear with the DELETE set. Its fate is a _decision_: whether M5's
   per-operation completion handles route through this same registry or a parallel channel. Likely
   STAYS; the M4 fence was to avoid touching it before the completion-handle model is designed.
2. **`T3VoiceBindingRealtimeOwnerPolicy`** (own file, 27 lines) — `binderGeneration` :6, `Owner` :4.
   Module usage: `bindingRealtimeOwner` :37, `connected` :83, `observe` :85/:103, `disconnected` :987.
   **Sole purpose:** fire a synthetic `RealtimeTerminated` on binder disconnect (module :992-1002)
   for the ui-attached realtime surface. Realtime is deleted → **this whole class + its wiring + the
   synthetic emission DELETE.** The cleanest Scope-C removal.
3. **`T3VoiceBinderOperationDispatcher`** + `T3VoiceBinderOperationAdmission` (inline in module
   :1362-1392) — the ordered-post + admission `admissionAttempted` CAS (:1370/:1381/:1384), reached via
   `tryAdmit` (:1363; used by KEEP `dispatchVoiceRuntime` admission :1059/:1109/:1128). **STAYS**
   (admission is a KEEP-protocol mechanism for `dispatchVoiceRuntimeAsync`).

Verdict: of Scope C, only `T3VoiceBindingRealtimeOwnerPolicy` is an unconditional M5 delete; the
registry + dispatcher underlie the KEEP surface and are reshaped, not removed.

---

## 6. JS/TS side

**Native module = hand-written TS interface, no codegen.** `interface T3VoiceNativeModule`
(T3Voice.types.ts :353-522) is cast onto the untyped Expo proxy by
`requireOptionalNativeModule<T3VoiceNativeModule>` (index.ts :58). **Consequence: deleting the 17
functions from Kotlin does NOT break `tsc`** — the ui-attached callers keep compiling against the
still-present interface members. A typecheck break happens only if the _interface members_ are also
removed while ui-attached callers remain; since that path is retained, **leave the 17 members in
`T3Voice.types.ts`** (or the ui-attached seed stops compiling). At runtime the ui-attached subtree
never mounts on Android, and off-Android `getT3VoiceNativeModule()` returns `null`, so the calls are
never dispatched — the deletions are Android-runtime-invisible.

**Execution-model gate:** component-tree fork in `MasterVoiceProvider.tsx:1845-1849`
(`mobileVoiceExecutionModel(Platform.OS) === "autonomous" ? AutonomousAndroidMasterVoiceProvider :
UiAttachedMasterVoiceProvider`); mapper `voiceExecutionComposition.ts:3-5`. Second split via RN
platform-file resolution: `useThreadVoiceComposerController.android.ts` (autonomous, asserts :23-24)
vs `.ts` (ui-attached, asserts :63). The module is imported unconditionally; there is no per-function
`executionModel` guard — ui-attached-only functions are simply never reached on Android.

**`androidVoiceRuntime.ts`** (`apps/mobile/src/features/voice/androidVoiceRuntime.ts`) — resolves the
module at :92, calls only the protocol subset through a narrowed `AndroidVoiceRuntimeNative` Pick
(:19-37, which deliberately excludes every DELETE fn): describe :72, snapshot :73, configureAuthority
:74, clearAuthority :75, attach :76, updateAttachment :77, detach :78, acknowledge :79, dispatch :80,
draftRead :81, draftAck :82, presentationClaim :83, presentationAck :84-85, read :126, `addListener
"voiceRuntimeWake"` :155. No DELETE/CONVERT function. (`acknowledgeVoiceRuntimeRetainedRecordAsync` is
in the Pick :31 but not yet wired — the natural landing spot for the group C/D retained-record acks.)

**`useComposerDictation`** (live Android hook) — recording surface + group A: perms :177/:180/:182,
start :185, cancel :197/:271/:403, stop :236, delete :139-144/:238-243, getState :305, **pending :308,
ack :311/:342/:360/:374, discard `dictationTermination.ts:28`** (from :337), `addListener
"recordingTerminated"` :329. Group A changes here: the pending/ack/discard trio and the
`recordingTerminated` listener are replaced by the completion-handle result on stop/cancel.

**`useThreadSpeech`** (live Android hook) — playback surface + group B: getState :215/:502/:624,
**pending :228/:441, ack :181**, start :238, enqueue :305, finish :339, cancel :332/:347/:425/:680,
`addListener "playbackTerminated"` :437 / `playbackChunkConsumed` :446 / `runtimeError` :456. Group B
changes here: pending/ack + `playbackTerminated` listener → completion handle on stop/cancel.
**Premise correction:** `useThreadSpeech` does **not** touch readiness-disabled or authority-revocation
— those (groups C/D) are driven by `AutonomousAndroidMasterVoiceProvider.tsx` (:417/:423 and :443),
not by this hook.

**nativeRevision:** TS side `NATIVE_REVISION = 15` (index.ts :48), **exact-equality** gate
`resolvedModule?.nativeRevision !== NATIVE_REVISION` (index.ts :59) — mismatch → module resolves
`null`. Interface field T3Voice.types.ts :354. Kotlin `"nativeRevision" to 15` (module :209). M5 must
bump both in lockstep (the ownership spec forbids dual shapes during migration; it stays an equality
gate). Gate tests: index.test.ts :27 (15 ok) / :37 (13 rejected).

**ui-attached-only callers of the 17 DELETE functions** (all in the retained seed — flag, do not
delete): RVC = `realtimeVoiceController.ts`, UAMVP = `MasterVoiceProvider.tsx` (179-1838), UTVCC =
`useThreadVoiceComposerController.ts`.

| DELETE fn                                  | ui-attached caller(s)           |
| ------------------------------------------ | ------------------------------- |
| `prepareRealtimeSessionAsync`              | RVC:399                         |
| `applyRealtimeAnswerAsync`                 | RVC:416                         |
| `stopRealtimeSessionAsync`                 | RVC:491,501,524,736,877,911,959 |
| `drainAndStopRealtimeSessionAsync`         | RVC:646                         |
| `setRealtimeMutedAsync`                    | RVC:547                         |
| `armThreadVoiceHandoffAsync`               | RVC:639                         |
| `getPendingThreadVoiceHandoffAsync`        | UAMVP:591                       |
| `acknowledgeThreadVoiceHandoffAsync`       | UAMVP:505                       |
| `beginThreadVoiceHandoffAdoptionAsync`     | UTVCC:151                       |
| `recordThreadVoiceHandoffClientStageAsync` | UAMVP:578,629; UTVCC:167        |
| `getPendingVoiceCommandAsync`              | UAMVP:1451                      |
| `completeVoiceCommandAsync`                | UAMVP:1242,1508,1580            |
| `registerVoiceControllerAsync`             | UAMVP:1449                      |
| `unregisterVoiceControllerAsync`           | UAMVP:1530                      |
| `setAudioRouteAsync`                       | RVC:576                         |
| `setVoiceCuesEnabledAsync`                 | UAMVP:270                       |
| `getMediaCapabilitiesAsync`                | UAMVP:837                       |

`useAutoListenController.ts` makes zero direct native calls (orchestrates via the RVC abstraction).
TS interface member anchors for the 17 (leave in place): T3Voice.types.ts :481, :473, :474-477,
:478-480, :514-516, :485, :490-494, :483, :484, :503-505, :506, :507, :508, :509-511, :517-521, :482,
:401, :453.

---

## 7. Test inventory

### DELETE — dies with the surface

- **`T3VoiceStateStoreTest.kt`** (SPLITS — highest-value file). Nine `ThreadVoiceHandoff` tests DIE:
  :40, :62, :82, :113, :149, :355, :394, :439, :472. `terminalStateIsDurableAndRejectsStaleUpdates`
  :207 (`RealtimeTerminated`) DIES/re-express. `modeClaimsClearMutuallyExclusive...` :171 PARTIAL
  (realtime-terminal asserts re-express; recording/playback claim logic KEPT). `@Before resetStore`
  :12-25 touches both surfaces.
- **`T3VoiceRuntimeServiceInstrumentedTest.kt`** (androidTest, SPLITS): `realtimeSurvivesUnbindAnd
NotificationStopAfterRebind` :118 uses bridge `prepareRealtimeSession` (:127-137) — DIES / re-express
  against the autonomous realtime entry. The three other `@Test`s (:32/:57/:81) survive.
- **`realtimeVoiceController.test.ts`** — whole file DIES: the controller-under-test drives the
  deleted bridge realtime API end-to-end (native mock :102-145 stubs prepare/applyAnswer/stop/drain/
  arm/setMuted/setAudioRoute + `audioRouteChanged`/`stateChanged` events; ~60 `it` blocks).
- **`threadVoiceHandoffReconciler.test.ts`** — whole file DIES: reconciler exists solely to process
  `ThreadVoiceHandoff` events (describe :22/:60).
- **`nativeVoiceReadiness.test.ts`** — SPLITS: ~15 `NativeVoiceCommand*` blocks die (:123,:166,:193,
  :281,:289,:313,:328,:339,:351,:358,:371,:387,:402,:418,:438); readiness-gating blocks (:21/:31/:58/
  :80/:102) KEPT; disable blocks (:224/:244) are group-C-adjacent (PORT).

### CONVERT — ports, re-expressed

- **`T3VoiceStateStoreTest.kt`**: the four recording/playback-termination tests PORT to the
  completion-handle model — `recordingTerminationIsDurableUntilMatchingAcknowledgement` :226,
  `pendingRecordingTerminationBlocksReplacementButSurvivesRealtime` :246,
  `playbackTerminationIsDurableAndBlocksReplacement...` :266, plus native-thread-slot tests :281/:309.
- **`T3VoiceControlPolicyTest.kt`** (mostly KEPT): two `ReadinessDisabled` methods PORT — :299, :341.
- **`VoiceRuntimeThreadOperationStoreTest.kt`** (KEPT): one authority-revocation method PORTs — :110
  (`clearLockedAfterAuthorityRevocation`).
- **`useComposerDictation.test.ts`** (mostly KEPT): one method PORTs — orphan discard
  `discardUnownedRecordingTerminationAsync` mock :71 (`it` :68).

### Scope-C — whole files, fate tied to §5 disposition

- **`T3VoiceBinderOperationRegistryTest.kt`** — 7 `@Test`s, all on `binderGeneration`/registry
  (:11/:25/:36/:56/:66/:78/:95). Survives if the registry survives (likely, reshaped).
- **`T3VoiceBinderOperationDispatcherTest.kt`** — 1 `@Test` :11 (`ordinaryOperationsRemainOrdered`).
  Survives with the dispatcher (KEEP admission).
- **`T3VoiceBindingRealtimeOwnerPolicyTest.kt`** — 2 `@Test`s :8/:24. **DIES** with the policy class.

### Confirmed clean (KEEP — no DELETE/CONVERT/Scope-C touch)

`VoiceRuntimeRealtimeTest.kt` (new-kernel `VoiceRuntimeRealtimeDelegate` — the `StopRealtimeVoice`/
`HandoffToThreadVoice` there are new action-enum members, not the deleted bridge fns),
`T3VoiceControllerCommandsTest.kt` (tests the KEPT `T3VoiceControllerCommands` methods, not the
bridge register/complete), `VoiceKernelMailboxInstrumentedTest.kt`, `index.test.ts`,
`androidVoiceRuntime.test.ts`, `voiceExecutionComposition.test.ts`. `traditionalAudioHandoff.test.ts`
mocks kept media fns (cancelPlayback/cancelRecording/getState) — KEPT.

---

## 8. Risks / order

### Cannot be deleted without breaking a KEEP path

- **`deleteRecordingAsync` (KEEP-media) depends on the group-A sticky slot** (svc :606-613 reads
  `recordingTermination.value` to validate bridge ownership + URI). The completion-handle conversion
  must give `deleteRecording` an alternate validation source (retained completed-recording registry)
  _before_ the slot is removed, or delete-after-terminate breaks.
- **`terminateRealtime` / `claimRealtime` / `releaseRealtimeClaim` / `setRealtime` STAY** (autonomous
  engine, svc :4720/:4771/:1505/:1536) even though the `realtimeTermination` slot + event die. Delete
  the _slot write_ (State.kt :539) and getter (svc :287), not the transitions.
- **`realtime.routes()` (svc :863) must outlive `realtime.selectRoute` (svc :888)** — `getAudioRoutesAsync`
  (KEEP) keeps `routes()`; only `selectRoute` goes zero-caller. Do not delete the shared `realtime`
  driver, only its `selectRoute` method.
- **`T3VoiceControllerCommands.requestPrimary`/`pending` STAY** (autonomous thread-mode control) while
  `register`/`unregister`/`complete` are deleted — split the class, do not delete it.
- **`T3VoiceBinderOperationRegistry` underlies all 61 operations** — deleting it breaks every KEEP
  bridge call. Only `T3VoiceBindingRealtimeOwnerPolicy` is an unconditional Scope-C delete.

### Recommended commit order (one vertical switch, no aliases)

1. **Server/contracts + Kotlin retained-record variants:** add `RetainedRecordKey` variants for the
   readiness-disabled + authority-revocation notices (CoreModels + journal); wire the two disable
   write sites (svc :6007, :369) to emit them; keep the old pending flags writing in parallel _within
   this commit only_ is forbidden by the no-dual-shape rule — instead land the retained-record path
   and the getter/ack removal together.
2. **Kotlin completion handles for terminations (groups A/B):** convert stop/cancel recording &
   playback binder results to per-operation completion handles; re-source `deleteRecording` validation;
   delete the three sticky slots + `recordingTermination`/`playbackTermination`/`realtimeTermination`
   getters + terminate-slot writes.
3. **Kotlin DELETE surface:** remove the 17 module functions + their zero-caller binder methods + the
   transitive helpers (`disablePendingCuesLocked`, `drainRealtimeForStopLocked`,
   `expireThreadVoiceHandoffLocked`, `realtime.selectRoute`, `T3VoiceState.beginThreadVoiceHandoffAdoption`/
   `markThreadVoiceHandoffAdopted`, `T3VoiceControllerCommands.register`/`unregister`/`complete`), the
   5 DELETE events + their StateFlow getters, `T3VoiceBindingRealtimeOwnerPolicy`, the module
   `registeredControllerGeneration` field + `OnDestroy` unregister block (:228-231), and (pending D6)
   the handoff adoption machinery.
4. **Bump `nativeRevision` 15→16** in `T3VoiceModule.kt:209` and `index.ts:48` in the same commit as
   the TS hook updates.
5. **TS hook updates (same vertical change):** rewire `useComposerDictation` (group A) and
   `useThreadSpeech` (group B) to completion handles; rewire `AutonomousAndroidMasterVoiceProvider`
   groups C/D to `acknowledgeVoiceRuntimeRetainedRecordAsync` + rebase. Leave the 17 DELETE members in
   `T3Voice.types.ts` and the entire ui-attached seed untouched.
6. **Tests:** delete the DELETE-only tests/methods (§7); port the four termination tests + the two
   `ReadinessDisabled` + one revocation test; delete `T3VoiceBindingRealtimeOwnerPolicyTest.kt`.

### Drift the packet author must resolve

- **D1** — the 3 zero-caller functions are already gone (W0a); no work.
- **D2** — KEEP-protocol is **20** in code, not spec's 19: spec's "prepare authority" has no code
  counterpart; code's `setVoiceRuntimeSessionCredentialAsync` is un-enumerated. Reconcile the spec.
- **D3** — `executeRealtimeHandoff`, `completionLock`, and the interrupt lane are already deleted
  (M4/M1); the spec's M5 delete list for them is stale.
- **D4** — event count: spec says "~6 events (from 11)" and lists `recordingTerminated`/
  `playbackTerminated` under KEEP-media, but the completion-handle conversion removes them as events,
  yielding **3** surviving events (`playbackChunkConsumed`, `runtimeError`, `voiceRuntimeWake`). Decide
  whether terminations deliver purely via completion handle (→3) or retain a wake event (→ up to 6).
- **D5** — `acknowledgeVoiceRuntimeAuthorityRevocationAsync` has **no TS caller**; the autonomous
  provider retires revocations via `disableVoiceRuntimeReadinessAsync` + `clearVoiceRuntimeAuthorityIfIdleAsync`.
  Decide whether the binder ack survives (recovery-only) or the group-D getter simply becomes a
  retained record with no dedicated ack.
- **D6** — the thread-voice-handoff base state (`mutableThreadVoiceHandoff` + publish/clear/pending)
  has a native autonomous producer (REALTIME_HANDOFF termination) even though every handoff bridge
  consumer is deleted. Decide whether the whole handoff concept leaves with the bridge (ui-attached
  seed) or the native producer half stays, before deleting `publishThreadVoiceHandoff`.

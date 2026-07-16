# M6 Seam Map (recovery function — post-M5 tree @ 195bd7879)

Authoritative inventory for the M6 packets; produced by orchestrator audit. Scope per
`specs/native-voice-runtime-kernel.md` Recovery section (:481-500) and Migration M6 (:549-550):
"Replace the `onCreate` choreography with `Recover` and land the fixture matrix. Shrink the
service to the host." Reconciles `specs/kernel-milestones/w0b-recovery-characterization.md`
(predates M1-M5) against current HEAD. Format/rigor per `m3-seam-map.md` / `m5-seam-map.md`.

All anchors at HEAD `195bd7879` (branch `feature/voice-kernel-m1`). Service
`T3VoiceRuntimeService.kt` is **6033 lines** (was 5840 at M3, 6385 at M5-pre). Module root:
`apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/`.

---

## 0. Headline drift vs spec/W0b (read first)

- **D-anchor:** the spec's "seventeen live steps in `onCreate` (service:1836-2325)" is stale.
  `onCreate` is now **1491-1879** (~388 lines) plus two recovery helpers
  `reconcilePersistedThreadOperationLocked` (1881-1924) and
  `revokePersistedThreadOperationLocked` (1926-1966). M1-M5 never touched the recovery
  choreography (M2 removed `operationLock`, M4 changed fencing, M5 removed the realtime bridge
  and handoff slots — none of them the startup path). So the choreography is **not shrunk**;
  M6 is the first milestone that reduces it. Present count: **19 sequential prologue
  decision/IO steps** (main thread, 1491-1834) + a **7-step kernel-thread recovery block**
  (`submitAndAwait("service-create-recovery")` 1835-1878) + the 2 helpers.
- **D-tests:** W0b says "six `T3VoiceRuntimeServiceRecoveryTest` scenarios." HEAD has **five**
  `@Test` (10/35/51/65/81). One was dropped after W0b. All five are pure policy-object tests
  (`T3VoiceRecoveredRealtimeAuthorityPolicy`, `T3VoiceRealtimeFinalizationCallbackPolicy`,
  `T3VoiceRuntimeHandoffCapturePolicy`), not a service harness — W0b's core premise holds.
- **D-revoke-shape:** W0b scenarios 2/4/8 assumed a "pending-revocation notice" write-back.
  Post-M5 that notice is a **retained record** (`writeDisabledForRuntimeRevocation` still writes
  the durable pending flag at 1691/1954, but its bridge getter/ack were reshaped in M5). The
  revocation _decision_ is unchanged; the _effect_ shape moved.
- **D-store-list:** the spec Recovery list (:485-487) **omits three durable stores onCreate
  actually reads** — `VoiceRuntimeDeviceIdentityStore` (1712), `VoiceRuntimeSessionCredentialStore`
  (constructed 1498, cleared on retirement 1502), `VoiceRuntimeRealtimeCleanupStore` (read inside
  the legacy cutover 1508-1512) — and correctly excludes the in-memory bridge completion store.

---

## 1. onCreate choreography census

`R` = read (store), `D` = decide (policy), `E` = effect/write, `⇒` = ordering dependency.
Prologue runs on the **main thread**; the kernel block (steps 20-26) runs on the **kernel
thread** via `mailbox.submitAndAwait`.

| #   | Step (line)                                           | Reads (store)                                                             | Decides (policy)                                                                                                                        | Effects (write/schedule)                                                                                                                                             | Ordering                                             |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Construct 6 stores + realtime repo (1493-1506)        | —                                                                         | —                                                                                                                                       | —                                                                                                                                                                    | first                                                |
| 2   | `retireLegacyV2` + clear credential (1499-1504)       | authority store retired/legacy keys                                       | inline (version==v2 gate)                                                                                                               | `storeDriver.persist("legacy-retirement-clear-session-credential")` (1501); yields fence                                                                             | ⇒ 12,16 (retiredFence feeds fences)                  |
| 3   | Snapshot read (1507)                                  | `runtimeSnapshotStore.read()` (self-heals)                                | —                                                                                                                                       | —                                                                                                                                                                    | ⇒ 4,26                                               |
| 4   | Legacy realtime cutover (1508-1530)                   | `VoiceRuntimeRealtimeCleanupStore.load()` + snapshot                      | `VoiceRuntimeLegacyRealtimeCutover.migrate` (impure — see §3)                                                                           | `cleanupStore.clear()`, `snapshotStore.clear()`; diagnostic; resets snapshot on failure                                                                              | ⇒ uses 3                                             |
| 5   | Readiness config + permission overlay (1531-1537)     | `readinessStore.read()` + `hasPermission` ×2 + `Build.VERSION.SDK_INT`    | inline overlay                                                                                                                          | —                                                                                                                                                                    | ⇒ 10,17,18 (Permissions param)                       |
| 6   | Inspect prepared/attached authority (1538-1541)       | `authorityStore.inspectPreparedAttachedAuthority()` (throws→runCatching)  | —                                                                                                                                       | —                                                                                                                                                                    | ⇒ 13,14,15                                           |
| 7   | Load canonical authority (1542-1543)                  | `authorityStore.load()` → {Missing,Locked,Available}                      | `as? Available`                                                                                                                         | —                                                                                                                                                                    | ⇒ 10,11,16,17 (gates canonicalInstalled)             |
| 8   | Load finalization (1544-1552)                         | `realtimeRepo.loadFinalization()` (throws→runCatching, diag)              | —                                                                                                                                       | diagnostic on corrupt                                                                                                                                                | ⇒ 12,16,20                                           |
| 9   | Load realtime checkpoint (1553-1561)                  | `realtimeRepo.load()` (throws→runCatching, diag)                          | —                                                                                                                                       | diagnostic on corrupt                                                                                                                                                | ⇒ 12,16,20                                           |
| 10  | Canonical readiness reconcile (1562-1595)             | `readinessStore.prepared()/activeAuthority()`                             | `T3VoiceCanonicalReadinessPolicy.transient` / `VoiceRuntimeCommittedReadinessPolicy.reconcile` (NotRequired/Current/Promote/Mismatch)   | `readinessStore.write/writeActivated`; on failure `storeDriver.persist("startup-reconciliation-clear-authority")` + disable + `canonicalInstalled=null`              | needs 5,7                                            |
| 11  | Persistent-readiness prep (1596-1609)                 | `readinessStore.prepared()` (iff canonicalInstalled==null)                | `T3VoiceStartupAuthorityFencePolicy.persistentPreparation`                                                                              | —                                                                                                                                                                    | needs 7,10                                           |
| 12  | Recovered-fences array (1612-1625)                    | uses finalization/checkpoint/retiredFence/activeAuthority                 | inline (`T3VoiceRecoveredAuthorityFence` per source)                                                                                    | —                                                                                                                                                                    | needs 2,8,9,14a                                      |
| 13  | Preparation selection (1626-1634)                     | —                                                                         | `…FencePolicy.selectPreparation` (persistent vs attached)                                                                               | —                                                                                                                                                                    | needs 6,11                                           |
| 14  | **Startup resolution** (1635-1670)                    | —                                                                         | `…FencePolicy.resolve` **on success**; **inline fallback on failure = W0b scenario 5** (`selectRuntimeId` + generation math, 1639-1669) | —                                                                                                                                                                    | needs 12,13; ⇒ 15,16                                 |
| 15  | Discard-preparation revocation (1671-1704)            | `startupActiveAuthority`, `startupPersistentReadiness`                    | inline (`discardPreparation` gate) + `T3VoicePendingRuntimeRevocation`                                                                  | `readinessStore.writeDisabledForRuntimeRevocation`; `authorityStore.discardInitialPreparation`; diag; nulls attachedPreparation; mutates resolution                  | needs 14; ⇒ 16,17,18                                 |
| 16  | Installed runtime id + device identity (1705-1713)    | —                                                                         | `T3VoiceRecoveredRealtimeAuthorityPolicy.runtimeId`                                                                                     | `VoiceRuntimeDeviceIdentityStore.getOrCreate` (durable write)                                                                                                        | needs 7,8,9,14,15; ⇒ 17                              |
| 17  | **Construct `voiceRuntimeController`** (1714-1819)    | —                                                                         | —                                                                                                                                       | builds `VoiceRuntimeActiveThreadController` (stateful platform object; binds `VoiceRuntimeThreadExecution`, drafts/journal repos, realtime terminal acks, wake emit) | needs 16; ⇒ all of 18-26                             |
| 18  | Apply attached-preparation write-back (1820-1831)     | —                                                                         | (iff attached && canonicalInstalled==null)                                                                                              | `readinessStore.write`; sets `canonicalPreparedAuthority`                                                                                                            | needs 6,15,17                                        |
| 19  | Read cue settings + host driver + channel (1832-1834) | `cueSettingsStore.read()`                                                 | —                                                                                                                                       | `createHostDriver()`; `createNotificationChannel()`                                                                                                                  | ⇒ 20                                                 |
| 20  | Construct `mediaDriver` (1836-1851)                   | —                                                                         | —                                                                                                                                       | `VoiceMediaDriver(…)` wired to `postDriverResult`                                                                                                                    | kernel thread; first in block                        |
| 21  | Restore canonical authority (1852-1853)               | `authorityStore.load()` (via `installedCanonicalAuthorityLocked`)         | —                                                                                                                                       | `restoreCanonicalAuthorityLocked` → `controller.configure(Realtime)Authority`; clears authority on throw                                                             | needs 17; ⇒ 22,26                                    |
| 22  | Install recovered realtime / engine (1854-1856)       | finalization+checkpoint (`installRecoveredRealtimeStateLocked`)           | `T3VoiceRecoveredRealtimeAuthorityPolicy.authority/recoveryIdentity`                                                                    | engine-slot `stageRecoveredInstall/commit/complete`; `recoverRealtimeEngineLocked`; **else if canonicalRestored** `installRealtimeEngineLocked`                      | needs 21; recovered-first precedence                 |
| 23  | Thread recording recovery (1857-1869)                 | `threadOperationStore.load()`                                             | `VoiceRuntimeThreadRecordingRecovery.restore`                                                                                           | `recorder.restoreCompleted`; else detach active (`writeActive(recording=null,detached,cancelRequested)`)                                                             | ⇒ 24 (before sweep)                                  |
| 24  | Restore bridge completions + **sweep** (1870-1873)    | in-memory `T3VoiceBridgeCompletionStore` (empty after true process death) | —                                                                                                                                       | `restoreBridgeRecordingCompletions` → `recorder.restoreCompleted` then `recorder.sweepStaleCache` (file IO)                                                          | **must follow 23** — sweep deletes unprotected files |
| 25  | `setServiceReady` (1874)                              | —                                                                         | —                                                                                                                                       | `T3VoiceStateStore.setServiceReady()` (phase INACTIVE→IDLE)                                                                                                          | **must precede 26** (startRuntimeThread needs IDLE)  |
| 26  | Reconcile thread op → start (1875-1877)               | `threadOperationStore.load()` + `persistedAuthority()`                    | `VoiceRuntimeThreadStoredStatePolicy.decide` (NONE/RESTORE/CANCEL_PREPARED/CANCEL_UNDISPATCHED/REVOKE)                                  | write cancel/detach; `revokePersistedThreadOperationLocked` (disable+clear+invalidate); or `startRuntimeThreadLocked()`                                              | needs 21,25                                          |

**Key ordering invariants (why):**

- **24-after-23 (F2-ported):** both step 23 (durable thread-op `Active.recording`) and step 24
  (in-memory bridge completions) call `recorder.restoreCompleted` to populate
  `T3VoiceCompletedRecordingRegistry`; `sweepStaleCache` (end of step 24) deletes any cache file
  not in `protectedFiles()`. If the sweep ran before either restore, a live recovered recording's
  file is deleted. This is the single most fragile recovery ordering.
- **25-before-26:** `startRuntimeThreadLocked` early-returns unless
  `phase == IDLE` (2267); `setServiceReady` is what lifts INACTIVE→IDLE.
- **21-before-22/26:** both realtime install and thread reconcile read the controller's installed
  authority (`persistedAuthority()`, `canonicalRealtimeAuthorityLocked`).
- **22 recovered-vs-canonical precedence:** `installRecoveredRealtimeStateLocked()` (finalization/
  checkpoint) is tried first; the canonical `installRealtimeEngineLocked` runs **only if** recovered
  install returned false **and** canonical authority restored (1854-1856).
- **Foreground posture is NOT restored in onCreate.** No `startForeground` on the recovery path.
  Foreground returns via (a) `startRuntimeThreadLocked` → `ensureRuntimeForeground` (2325) when a
  turn arms, (b) START_STICKY → `onStartCommand(ACTION_READINESS/other)` → `reconcileReadinessLocked`
  (1997/2068 → `startRuntimeForeground` 5587), or (c) a realtime notification-start. Treat "restore
  foreground posture" as a **downstream effect of the armed operation**, not an onCreate step.

---

## 2. Persisted-set inventory (the loader's `LoadedState` sources)

| Spec item                    | Store class @ file:line                                                                                                                                                | Load method (:line)                                                                                                                                           | Result / corrupt variant                                                                        | onCreate site         | In `LoadedState`?                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| readiness config             | `T3VoiceReadinessStore` `T3VoiceReadiness.kt:232`                                                                                                                      | `read()` :261; also `prepared()` :300, `activeAuthority()` :346, `pendingRuntimeRevocation()` :392, `pendingDisabled()` :446, `disabledAuthorityFence()` :452 | `read()` **self-heals** (no Locked); `prepared/activeAuthority` throw→runCatching               | 1531-1537, 1597, 1610 | YES (config+prepared+active+pendingRevocation)                                                                              |
| prepared/attached authority  | `VoiceRuntimeAuthorityStore` `VoiceRuntimeAuthorityStore.kt:67`                                                                                                        | `inspectPreparedAttachedAuthority()` :77                                                                                                                      | returns `VoiceRuntimePreparedAttachedAuthority?`; **throws on corrupt** (runCatching 1538)      | 1538-1541             | YES                                                                                                                         |
| canonical authority          | same                                                                                                                                                                   | `load()` :186                                                                                                                                                 | `VoiceRuntimeAuthorityLoadResult{Missing,Locked,Available}` :44-49                              | 1542-1543             | YES                                                                                                                         |
| realtime checkpoint          | `VoiceRuntimeDurableRealtimeCheckpointRepository` `VoiceRuntimeRealtimeCheckpointStore.kt:7`                                                                           | `load()` :20                                                                                                                                                  | `VoiceRuntimeRealtimeCheckpoint?`; **throws `VoiceRuntimeDurableStateCorruptionException`** :24 | 1553-1561             | YES                                                                                                                         |
| finalization record          | same                                                                                                                                                                   | `loadFinalization()` :50                                                                                                                                      | `VoiceRuntimeRealtimeFinalization?`; **throws** on corrupt :54                                  | 1544-1552             | YES                                                                                                                         |
| thread operation claim       | `VoiceRuntimeThreadOperationStore` `VoiceRuntimeThreadOperationStore.kt:61`                                                                                            | `load()` (used 1857/1882/2268)                                                                                                                                | `VoiceRuntimeThreadOperationLoadResult{Missing,Locked,Available}` :46-51                        | 1857, 1882            | YES                                                                                                                         |
| execution snapshot           | `VoiceRuntimeExecutionSnapshotStore` `VoiceRuntimeExecutionSnapshotStore.kt:5`                                                                                         | `read()` :40                                                                                                                                                  | `VoiceRuntimeExecutionSnapshot`; **self-heals** on corrupt (clear+empty) :65-68                 | 1507                  | YES (cutover + thread restore consumer)                                                                                     |
| completed-recording registry | `T3VoiceCompletedRecordingRegistry` (`recorder.completed`) `T3VoiceRecorder.kt:176`; durable = `T3VoiceRecordingCache(cacheDir)` :175                                  | `restore()` :114, `sweep()` :180, `protectedFiles()` :144                                                                                                     | boolean; in-memory index over durable file cache                                                | 1857-1873             | PARTIAL — durable source is thread-op `Active.recording` (row above) + on-disk cache; the index is rehydrated, not "loaded" |
| cue settings                 | `T3VoiceCueSettingsStore` `T3VoiceCueSettings.kt:10`                                                                                                                   | `read()`                                                                                                                                                      | `T3VoiceCueSettings`                                                                            | 1832                  | YES                                                                                                                         |
| retirement fences            | `VoiceRuntimeAuthorityStore` `retireLegacyV2()` :200 / `retiredFence()` :218; `VoiceRuntimeRealtimeCleanupStore` `VoiceRuntimeRealtimeCleanupStore.kt:14` `load()` :44 | —                                                                                                                                                             | `VoiceRuntimeRetiredAuthorityFence?`; cleanup `{Missing,Available,Locked}` :5-11                | 1499, 1508-1512       | YES (retiredFence into fences; cleanup consumed inside cutover)                                                             |

**Spec-missed stores onCreate reads (loader must include):**

- **`VoiceRuntimeDeviceIdentityStore`** `VoiceRuntimeActiveThreadController.kt:6` — `getOrCreate(installedRuntimeId)`
  reads/writes durable `runtime_id` (1712-1713). Not a decision input but a **loader-side durable
  write** that must precede controller construction. Not in the spec list.
- **`VoiceRuntimeSessionCredentialStore`** `VoiceRuntimeStorage.kt:215` — `load()` :241
  `{Missing,Locked,Available}` :208-211. Constructed 1498; in onCreate only **cleared** on legacy
  retirement (1502). Part of the persisted set touched, not a recovery decision.
- **Permissions** — `hasPermission(RECORD_AUDIO)` / `POST_NOTIFICATIONS` + `Build.VERSION.SDK_INT`
  (1533-1536, 1466-1470). This is the `Permissions` param of `recover(LoadedState, Permissions, Clock)`.

**Confirmed NOT in `LoadedState` (in-memory, process-death-volatile):**

- **`T3VoiceBridgeCompletionStore`** `T3VoiceState.kt:184` — an `object` with two `linkedMapOf`
  (recordings/playbacks) :185-188. Empty after true process death; step 24's
  `restoreBridgeRecordingCompletions` is a no-op on cold start and only matters on a warm in-process
  service re-create. **Keep out of `LoadedState`**; its sweep side-effect stays a driver effect.

---

## 3. Pure-policy reuse map

| Policy (fn @ file:line)                                                                                          | Signature                                                                                                                              | onCreate call site | Pure? (no IO/clock/platform)                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T3VoiceCanonicalReadinessPolicy.transient` `T3VoiceReadiness.kt:570`                                            | `(T3VoiceReadinessConfig, VoiceRuntimePersistedAuthority) -> T3VoiceReadinessConfig`                                                   | 1565               | **PURE**. Also `.disabled` :562 (used in revoke 1950)                                                                                                           |
| `VoiceRuntimeCommittedReadinessPolicy.reconcile` `VoiceRuntimeCommittedReadiness.kt:13`                          | `(canonical, prepared?, active?) -> Decision{NotRequired,Current,Promote,Mismatch}`                                                    | 1569               | **PURE**                                                                                                                                                        |
| `T3VoiceStartupAuthorityFencePolicy.persistentPreparation` `T3VoiceReadiness.kt:101`                             | `(T3VoicePreparedReadiness?) -> T3VoiceStartupAuthorityFence?`                                                                         | 1603               | **PURE** (require-based)                                                                                                                                        |
| `…FencePolicy.selectPreparation` :114                                                                            | `(persistent?, attached?) -> fence?`                                                                                                   | 1630               | **PURE**                                                                                                                                                        |
| `…FencePolicy.selectRuntimeId` :133                                                                              | `(vararg String?) -> String?`                                                                                                          | 1642 (fallback)    | **PURE**                                                                                                                                                        |
| `…FencePolicy.resolve` :141                                                                                      | `(preparation?, vararg recoveredFences?) -> T3VoiceStartupAuthorityResolution`                                                         | 1637               | **PURE**                                                                                                                                                        |
| `VoiceRuntimeThreadStoredStatePolicy.decide` `VoiceRuntimeThreadExecution.kt:431`                                | `(loaded, parentGrantAvailable: Boolean, nowMillis: Long) -> Decision{NONE,RESTORE,CANCEL_PREPARED,CANCEL_UNDISPATCHED,REVOKE}`        | 1896               | **PURE**, but takes `nowMillis` → `Clock` param                                                                                                                 |
| `T3VoiceRecoveredRealtimeAuthorityPolicy.runtimeId/authority/recoveryIdentity` `T3VoiceRuntimeService.kt:67-108` | `runtimeId(canonical?,finalization?,checkpoint?,retired?,readiness?)`; `authority(fin?,cp?,origin?)`; `recoveryIdentity(auth,current)` | 1705, 4325, 4348   | **PURE** (require-based)                                                                                                                                        |
| `T3VoiceRealtimeFinalizationCallbackPolicy.shouldConvergeIdle` :111                                              | `(hasFinalization: Boolean, hasCheckpoint: Boolean) -> Boolean`                                                                        | idle convergence   | **PURE**                                                                                                                                                        |
| `VoiceRuntimeThreadRecordingRecovery.restore` `VoiceRuntimeThreadExecution.kt:411`                               | `(loaded, restoreCompleted: (Recording)->Boolean) -> Boolean`                                                                          | 1858               | decision PURE; **`restoreCompleted` callback is an EFFECT** — split needed                                                                                      |
| `VoiceRuntimeLegacyRealtimeCutover.migrate` `VoiceRuntimeLegacyRealtimeCutover.kt:17`                            | `(VoiceRuntimeExecutionSnapshot) -> Result`                                                                                            | 1509-1512          | **NOT pure** — reads `cleanupStore.load()`, writes `cleanupStore.clear()`/`snapshotStore.clear()`. Phase gate (1518-1519) is pure; clears are **loader/effect** |

**Not a policy — inline decision logic that M6 must extract:**

- **W0b scenario 5 (the fallback):** `resolve`'s `onFailure` branch (1639-1669) re-derives
  `selectedRuntimeId`/`recoveredGeneration`/`preparationGeneration`/`discardPreparation` inline; it
  duplicates `selectRuntimeId` + generation-max math. **No extracted seam** (W0b: "none — inline in
  onCreate"). Must become a `T3VoiceStartupAuthorityFencePolicy` member so the fixture matrix can
  assert it.
- **Discard-preparation block** (1671-1704): `discardPreparation` gate + `generationFloor` +
  `pendingRevocation` selection is inline, mixed with the `writeDisabledForRuntimeRevocation`/
  `discardInitialPreparation` effects.
- **`revokePersistedThreadOperationLocked`** (1926-1966): pending-revocation selection over
  `Available/Locked/Missing` is inline; interleaved with effects (`writeDisabledForRuntimeRevocation`,
  `storeDriver.persist` clear, `controllerCommands.invalidateReadiness`, `clearLockedAfterAuthorityRevocation`,
  snapshot clear).
- **`T3VoiceStartCommandPolicy`** (`T3VoiceStartCommandPolicy.kt:10`) — **NOT used in recovery**;
  only `onStartCommand`/`reconcileStartCommand` (2001/2021/2043/2209). W0b's "T3VoiceStartCommandPolicy?"
  question resolves to **no**; exclude from `recover()`.

---

## 4. Effect inventory for recovery output (`[Effect]`)

What the recovered `(KernelState, [Effect])` must trigger, mapped to existing driver
effects/methods at HEAD. Drivers: `VoiceNetDriver` (`netDriver`, field :1036), `VoiceStoreDriver`
(`storeDriver`, :1037), `VoiceMediaDriver` (`mediaDriver`, built 1836), `VoiceHostDriver`
(`hostDriver`, built 1833 via `createHostDriver` 2121); realtime engine slot
`voiceRuntimeRealtimeEngineSlot`; kernel timers via `submitCallbackDelayed →
VoiceKernelCancellationToken`.

| Recovered trigger                 | Current site (fn @ line)                                                                                                                    | Existing driver effect / method                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resume long-poll (thread turn)    | `startRuntimeThreadLocked` :2259 → `materializeRuntimeThreadReceiptLocked` → poll loop                                                      | `netDriver.execute(tag, VoiceNetLane.THREAD_TURN, epoch, blockingBody)` (e.g. 3086); arm `THREAD_TURN` epoch (2320)                                                                                                             |
| schedule refresh recovery         | `scheduleRuntimeThreadRestoreLocked` :3059, `scheduleRuntimeThreadPollRetryLocked` :3243                                                    | `submitCallbackDelayed(…, VoiceRuntimeThreadRetryPolicy.delayMillis(n), "thread-restore")` → kernel timer (a `Tick`/`Delayed` effect)                                                                                           |
| arm restored thread turn          | `reconcilePersistedThreadOperationLocked` :1881 → `startRuntimeThreadLocked` :1876                                                          | kernel state (thread attempt) + the two above                                                                                                                                                                                   |
| install recovered realtime engine | `installRecoveredRealtimeStateLocked` :4316 / `installRealtimeEngineLocked` :4284                                                           | `voiceRuntimeRealtimeEngineSlot.stageRecoveredInstall/commit/complete` (4307-4312, 4332-4338); `recoverRealtimeEngineLocked` :4356 → `applyRealtimeReduction(engine.recoverInterrupted(...))` → NetDriver realtime-lane effects |
| schedule realtime finalization    | `recoverRealtimeEngineLocked` :4356 (failure) → :4372                                                                                       | `scheduleVoiceRuntimeRealtimeFinalizationLocked(engine, 1_000L)` → kernel timer                                                                                                                                                 |
| restore foreground posture        | **downstream** — `ensureRuntimeForeground` :2216 / `startRuntimeForeground` :2174 (from armed turn 2325 or `reconcileReadinessLocked` 5587) | `hostDriver.setForeground(types, snapshot)` (2179) + `T3VoiceStateStore.setForeground(true)`; `ensureMediaSessionLocked`                                                                                                        |
| cue settings apply                | `cueSettings = cueSettingsStore.read()` :1832                                                                                               | loaded into kernel state; applied lazily by cue coordinator / MediaDriver (no eager effect)                                                                                                                                     |
| sweep caches                      | `restoreBridgeRecordingCompletions` :1870 → `recorder.sweepStaleCache` :1872 (file IO)                                                      | MediaDriver-adjacent (`recorder.sweepStaleCache` `T3VoiceRecorder.kt:180`) — a **file-IO effect**, must run after all `restoreCompleted`                                                                                        |
| durable reconciliation clears     | 1501 / 1588 / 1957                                                                                                                          | already driver-routed: `storeDriver.persist("legacy-retirement-clear-session-credential" \| "startup-reconciliation-clear-authority" \| "revoke-thread-operation-clear-authority", driverEpoch(), body)`                        |
| restore canonical authority       | `restoreCanonicalAuthorityLocked` :5236                                                                                                     | `controller.configureAuthority/configureRealtimeAuthority` (5251-5256) — a **controller effect** (stateful), not a driver                                                                                                       |
| set service ready                 | `T3VoiceStateStore.setServiceReady()` :1874                                                                                                 | kernel state transition (INACTIVE→IDLE)                                                                                                                                                                                         |

Note the three `storeDriver.persist` clears are **already effects** but their _decision_ is inline;
M6 makes them `[Effect]` outputs of `recover()`.

---

## 5. Fixture matrix seed (W0b × HEAD reconciliation)

Each row becomes a `LoadedState` fixture asserted against `(KernelState, [Effect])`. "Ported test"
= the existing pure-policy test that already covers the _decision_ (it survives, unchanged, and is
subsumed as the decision half of the fixture); the **new** work per row is the `[Effect]` assertion
(previously unreachable in `onCreate`).

| W0b # | Scenario                              | `LoadedState` fixture (stores set)                                       | Decision policy (HEAD)                                      | `(KernelState,[Effect])` assertion                                                                                | Existing test (ports vs dies)                                      |
| ----- | ------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1     | Canonical + readiness disabled        | canonical Available (`readinessEnabled=false`)                           | `T3VoiceCanonicalReadinessPolicy.transient`                 | state: transient readiness; effect: readiness write-back                                                          | `T3VoiceCanonicalReadinessPolicyTest` (6) PORT                     |
| 2     | Committed-readiness mismatch          | canonical Available enabled + prepared/active non-matching               | `VoiceRuntimeCommittedReadinessPolicy.reconcile → Mismatch` | effect: `storeDriver` clear-authority + disable + diagnostic                                                      | `VoiceRuntimeCommittedReadinessTest` (4) PORT                      |
| 3     | Prepared authority survives           | canonical null + persistent prepared readiness                           | `…FencePolicy.persistentPreparation`                        | state: verified readiness; effect: readiness write-back                                                           | `VoiceRuntimeThreadExecutionTest`/fence tests PORT                 |
| 4     | Discard preparation                   | canonical null + attached prepared + recovered-fence conflict            | `…FencePolicy.resolve` (discard) + inline discard block     | effect: `writeDisabledForRuntimeRevocation` + `discardInitialPreparation` + retained revocation record (M5 shape) | fence tests PORT; **effect NEW**                                   |
| 5     | **Resolution-failure fallback**       | inconsistent prepared/attached/active forcing `resolve` `onFailure`      | **inline fallback (1639-1669) — must extract**              | state: `selectedRuntimeId`/generation-floor; effect: discard                                                      | **none — NEW fixture + policy extraction (mandatory)**             |
| 6     | Thread op RESTORE                     | thread-op Available Active (unexpired, dispatched)                       | `VoiceRuntimeThreadStoredStatePolicy.decide → RESTORE`      | effect: `startRuntimeThreadLocked` (arm turn + long-poll)                                                         | `VoiceRuntimeThreadExecutionTest` (30) PORT                        |
| 7     | CANCEL_PREPARED / CANCEL_UNDISPATCHED | thread-op Prepared (+parent grant) / Active (undispatched, no recording) | `…decide → CANCEL_PREPARED` / `CANCEL_UNDISPATCHED`         | effect: `writePrepared(cancelRequested)` / `writeActive(detached,cancelRequested)` then start                     | PORT                                                               |
| 8     | REVOKE                                | thread-op Locked, or Active expired, or Prepared w/o grant               | `…decide → REVOKE` → `revokePersistedThreadOperationLocked` | effect: disable + `storeDriver` clear + `invalidateReadiness` / `clearLockedAfterAuthorityRevocation`             | `VoiceRuntimeThreadOperationStoreTest` (:110) PORT; **effect NEW** |
| 9     | Completed-recording restore + sweep   | thread-op Active w/ `recording` + cache files                            | `VoiceRuntimeThreadRecordingRecovery.restore`               | effect: `restoreCompleted` then `sweepStaleCache` **ordered**                                                     | `T3VoiceRecordingCacheTest` (8) PORT                               |
| 10    | Active-at-crash detach                | thread-op Active, `restore`→false                                        | recovery restore false-branch (1862-1868)                   | effect: `writeActive(recording=null,detached,cancelRequested)`                                                    | decision covered; **effect NEW**                                   |
| 11    | Checkpoint → recovered engine         | realtime checkpoint present, no finalization                             | `T3VoiceRecoveredRealtimeAuthorityPolicy.authority`         | effect: engine-slot `stageRecoveredInstall` + `recoverInterrupted`                                                | `T3VoiceRuntimeServiceRecoveryTest` #1/#2 PORT                     |
| 12    | Finalization → cleanup retry          | finalization present                                                     | `…authority` + `…FinalizationCallbackPolicy`                | effect: engine install + `scheduleVoiceRuntimeRealtimeFinalizationLocked`                                         | `T3VoiceRuntimeServiceRecoveryTest` #3/#4 PORT                     |
| 13    | Legacy cutover idempotent/failure     | snapshot in `LEGACY_ACTIVE_PHASES` and/or cleanup marker                 | `VoiceRuntimeLegacyRealtimeCutover.migrate`                 | effect: `cleanupStore.clear` + `snapshotStore.clear`; failure → empty snapshot + diag                             | `VoiceRuntimeLegacyRealtimeCutoverTest` (3) PORT                   |
| 14    | Authority tamper → Locked             | authority store returns `Locked`                                         | `authorityStore.load → Locked`                              | state: non-capturing convergence (canonicalInstalled null path)                                                   | `VoiceRuntimeAuthorityStoreTest` (8) PORT                          |
| 15    | Checkpoint corruption                 | checkpoint raw unreadable → throws                                       | `runCatching` at 1553-1561                                  | effect: diagnostic + `getOrNull()` (no engine install)                                                            | `VoiceRuntimeRealtimeCheckpointStoreTest` (8) PORT                 |

**Process-death-per-phase** (spec :496) folds onto the above as `LoadedState` cross-products:
each of {ARMING, RECORDING, PLAYING, REALTIME_STARTING/ACTIVE, thread mid-turn} maps to a snapshot

- thread-op/checkpoint fixture already covered by rows 6/9/10/11/13 — enumerate the phase as the
  `VoiceRuntimeExecutionSnapshot.phase` field, not as new decision seams. `PLAYING` specifically
  triggers `VoiceRuntimeExecutionRecovery.restoreProcess` (2293-2294) — add that as a distinct
  `[Effect]` assertion.

**Five `T3VoiceRuntimeServiceRecoveryTest` scenarios** all **PORT** (pure policy tests):
#1 checkpoint-without-canonical (row 11), #2 identity-comparison (row 11),
#3 finalization-durable-origin (row 12), #4 stale-idle-convergence (row 12 / scenario 5-adjacent
`shouldConvergeIdle`), #5 handoff-armed-only-after-capture (`T3VoiceRuntimeHandoffCapturePolicy` —
maps to row 6 arm gate). **None die.**

**Tests that die:** none of the recovery-owning suites die outright; M6 is additive (new
`[Effect]` fixtures) plus one extraction (scenario 5). If a service-level Robolectric harness were
added it would be new, not a port — but W0b established the toolchain (JUnit4+org.json, no Context)
cannot host one, so **stay at the pure-fixture level**.

---

## 6. "Shrink to host" concretely

**What the service still owns post-M5 (6033 lines):** the entire `onCreate` recovery choreography
(§1, the M6 target); `onStartCommand` intent routing (1972-2075); `onDestroy` teardown
(2077-2118); `onBind` (1968); all `*Locked` reducer methods (thread-turn 2259-3600s, realtime
4284-5000s, media, foreground 2174-2250, readiness 5576-5700s); the anonymous driver
implementations (`createHostDriver` 2121-2142, mediaDriver listener 1836-1851); the epoch registry
helpers (126-180); the `VoiceRuntimeThreadExecution` object bound at controller construction
(1719-1794); notification building; MediaSession plumbing.

**Moves to `recover(LoadedState, Permissions, Clock) -> (KernelState, [Effect])`:** the decision
logic of steps 5-16, 22 (authority/identity policy), 23/26 (thread-op decision), plus the
**extracted scenario-5 fallback** and the **discard/revoke decision** logic. Output is DATA:
`initialGeneration`, `runtimeId`, `canonicalPreparedAuthority`, realtime-install plan, thread-op
decision, and the `[Effect]` list (long-poll, refresh timer, engine install, sweep, clears).

**Stays a driver (the loader):** the `StoreDriver` reads all durable stores off the kernel thread
and hands `recover()` a `LoadedState` value — steps 1-9 IO, plus `deviceIdentity.getOrCreate`
(durable write) and the impure `LegacyRealtimeCutover.migrate` clears. `MediaDriver`/`NetDriver`
execute the emitted effects.

**The host retains:** foreground/notification/binder plumbing (`createHostDriver` effects, `onBind`,
`buildNotification`, MediaSession), the mailbox pump (`mailbox`, `submitAndAwait`), driver wiring
(construct MediaDriver 1836, hostDriver 1833), and **controller construction** — see the ambiguity
below.

**Estimate:** M6 deletes the ~388-line `onCreate` body + the two helpers (~85 lines) ≈ **~470
lines out of the service**, replaced by a ~15-line loader-invoke + `Recover` post + effect-execute
shim. `recover()` (comparable logic, ~250-300 lines) relocates to a **new pure file** (e.g.
`kernel/VoiceRuntimeRecovery.kt`), not the service. Net service: **6033 → ~5650-5700 lines**.

**Ambiguities the packet author MUST decide:**

1. **Controller construction (step 17) cannot be pure.** `VoiceRuntimeActiveThreadController` is a
   stateful platform object whose `execution` closure binds ~8 service methods (1719-1794). `recover()`
   must emit the _data_ (`runtimeId`, `initialGeneration`, `canonicalPreparedAuthority`) and the
   **host** constructs the controller. Decide the boundary: does `recover()` run before or after
   controller construction? (It needs `installedRuntimeId` from step 16, which needs the recovered
   fences — so the loader computes `installedRuntimeId`, host builds controller, then `recover()`
   produces the post-controller effects. This two-phase split is the central design question.)
2. **Kernel-thread block (steps 20-26) is effect-execution, not decision.** It already runs on the
   kernel thread via `submitAndAwait`. Re-express as `[Effect]` emitted by `recover()` and executed
   by the host/drivers, preserving the 24-after-23 and 25-before-26 ordering as reducer step
   sequencing.
3. **`deviceIdentity.getOrCreate` durable write** — loader-side (before controller) vs an effect.
   It must precede controller construction, so almost certainly loader-side.
4. **The three `storeDriver.persist` clears** — become `[Effect]` outputs; confirm they carry the
   correct `driverEpoch()` at emit time.
5. **Scenario-5 extraction target** — a new `T3VoiceStartupAuthorityFencePolicy.resolveFallback`
   (or fold into `resolve` returning a richer result) so the fixture matrix can assert it.
6. **`LegacyRealtimeCutover.migrate` split** — the phase-gate decision is pure but the two `clear()`
   calls are effects; decide whether the loader runs `migrate` (current shape) or `recover()` emits
   the clears.

---

## 7. Risks / order

**Recommended run split: TWO runs.**

- **Run 1 — extract + fixtures (green, no deletion):** introduce `recover(LoadedState, Permissions,
Clock) -> (KernelState, [Effect])` and the `StoreDriver` loader; extract the scenario-5 fallback
  into `T3VoiceStartupAuthorityFencePolicy`; land the full §5 fixture matrix (15 rows + phase
  cross-products + 5 ported recovery tests). Keep `onCreate` calling the old choreography — the new
  function runs in parallel under test only. This is the bulk and is testable at the pure-fixture
  level with zero Robolectric.
- **Run 2 — shrink + delete:** cut `onCreate` over to `loader → Recover post → effect execution`,
  delete the ~470-line inline choreography + the two helpers, relocate `recover()` to `kernel/`.
  Ends in deletion per the migration rule.

A single run is possible but couples the controller-construction seam (ambiguity #1) and the
effect re-expression (ambiguity #2) into one high-risk change; splitting lets Run 1's fixtures pin
behavior before Run 2 mutates the live path.

**Highest-risk ordering constraints (carry into `[Effect]` sequencing):**

1. **All `restoreCompleted` before `sweepStaleCache`** (steps 23→24). Violating it deletes a live
   recovered recording's cache file. Non-obvious because `restoreBridgeRecordingCompletions` calls
   the sweep _internally_ (`T3VoiceState.kt:266`).
2. **`setServiceReady` before `startRuntimeThreadLocked`** (25→26): the start early-returns unless
   phase==IDLE (2267).
3. **`restoreCanonicalAuthorityLocked` before realtime install and thread reconcile** (21→22,26):
   both read the controller's installed authority.
4. **Recovered-realtime-install tried before canonical install** (22): `installRecoveredRealtimeStateLocked`
   first; canonical `installRealtimeEngineLocked` only if it returned false AND canonical restored.
5. **Discard-preparation after `resolve`, before `installedRuntimeId`** (15→16): it mutates
   `startupResolution` and nulls `startupAttachedPreparation`, both consumed downstream.
6. **`retireLegacyV2` before recovered-fences assembly** (2→12): the retired fence is a fence input.

**Spec-vs-code drift (packet author reconcile):**

- Stale line anchors (`onCreate` 1836-2325 → 1491-1879 + 1881-1966); "seventeen steps" → 19
  prologue + 7 kernel-block + 2 helpers.
- Recovery test count 6 → 5 (all pure policy tests; none is a service harness).
- Spec store list omits `VoiceRuntimeDeviceIdentityStore`, `VoiceRuntimeSessionCredentialStore`,
  `VoiceRuntimeRealtimeCleanupStore`; correctly excludes the in-memory bridge completion store.
- Post-M5 the revocation notice is a retained record, not a bridge pending flag — W0b rows 2/4/8
  effect shapes updated accordingly.
- "restore foreground posture" is not an `onCreate` step at HEAD; it is a downstream effect of the
  armed thread/realtime operation or the START_STICKY `reconcileReadinessLocked` — model it as an
  effect of those, not of `recover()` directly.

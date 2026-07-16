# M7 Seam Map — Package Split (reference; tree @ e2cbc5312, branch feature/voice-kernel-m1)

Authoritative inventory for the M7 packet. M7 (spec `native-voice-runtime-kernel.md`
§Migration.7): split the single flat package `expo.modules.t3voice` into `host/`,
`kernel/`, `media/`, `net/`, `store/`, `bridge/` **along the now-real seams. Mechanical,
last, no behavior change.**

Scope of module: `apps/mobile/modules/t3-voice/android/src/{main,test,androidTest}/java/expo/modules/t3voice/`.

**Corpus:** 60 main `.kt`, 47 unit-test `.kt` (`src/test`), 2 instrumented `.kt`
(`src/androidTest`). All 60 main files currently sit in the one flat package
`expo.modules.t3voice`, so there are **zero intra-module cross-file imports today**
(verified: `grep '^import expo.modules.t3voice' = 0`). The split therefore does not _move_
imports — it _adds_ one import per newly-crossed seam reference and rewrites one `package`
line per moved file. That is the entire mechanical shape of the diff (plus, at most, the
config edits discussed in §3).

---

## 0. Binding headline decisions (read first)

1. **The two FQCN-referenced Android entry classes STAY in the root package
   `expo.modules.t3voice`.** `T3VoiceRuntimeService` (named by string in
   `AndroidManifest.xml`) and `T3VoiceModule` (named by string in
   `expo-module.config.json` **and** `package.json`) do **not** move. This keeps M7's diff
   to _package-line + import-line hunks only_, with **zero** manifest/config edits — and
   eliminates the one change class the pc gate (compile + unit tests + androidTest compile)
   **cannot** verify (a wrong FQCN string compiles clean and only fails at runtime on
   device). See §3 for the full argument and the alternative (move + 3 config edits).
2. **Every straddler moves whole; no file body is edited.** A split of a straddler is
   admitted only where it is a pure cut-paste of top-level declarations into a sibling file
   in the same target package — and M7 needs **none** of those. All five known straddlers
   move whole with a documented compromise (§2).
3. **Kotlin `internal` is module-scoped, so no package move can break visibility.** Every
   type in this module is `internal` (or the two `public` entry classes). Moving files
   between sub-packages of the same Gradle module cannot break `internal` access, and
   `private` is file-scoped so it cannot have cross-file users. Confirmed in §3.

Resulting counts: **root 2, host/ 2, kernel/ 21, media/ 14, net/ 6, store/ 11, bridge/ 4 = 60.**

---

## 1. File census by target package

Doubt column: blank = unambiguous; ⚠ = AMBIGUOUS (recommendation given, alternative noted);
`S` = straddler (see §2). Line counts from `wc -l` @ e2cbc5312. Test column names the
unit-test file(s) that follow the subject (they move to the mirror sub-package — see
§4 "test tree").

### root package `expo.modules.t3voice` — UNMOVED (2)

| File                       |  LoC | Doubt | Why it stays root                                                                                                                                                                                                                       | Tests                                                                                                              |
| -------------------------- | ---: | :---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `T3VoiceRuntimeService.kt` | 5967 |   S   | manifest names `…t3voice.T3VoiceRuntimeService` by string; it is _the_ host shell (`class T3VoiceRuntimeService : Service()`) + notification snapshot + loader + interpreter + hundreds of `*Locked` executors. Whole-file, stays root. | `T3VoiceRuntimeServiceRecoveryTest` (test), `T3VoiceRuntimeServiceInstrumentedTest` (androidTest) — both stay root |
| `T3VoiceModule.kt`         | 1029 |   S   | expo-module.config.json + package.json name `…t3voice.T3VoiceModule` by string; `class T3VoiceModule : Module()` + `T3VoiceBinderOperationDispatcher` (same file). Whole-file, stays root.                                              | `T3VoiceBinderOperationDispatcherTest` — stays root (dispatcher lives in this file)                                |

### host/ — Android-facing host support (service shell's satellites) (2)

| File                           | LoC | Doubt | Contents                                                                                                  | Tests                           |
| ------------------------------ | --: | :---: | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `VoiceHostDriver.kt`           |  72 |       | `VoiceHostDriver`, `VoiceHostEffects`, `VoiceHostMediaSessionModel`, `AndroidVoiceHostMainDispatcher`     | `VoiceHostDriverTest`           |
| `T3VoiceStartCommandPolicy.kt` |  41 |       | `onStartCommand` stickiness policy + `T3VoiceStartCommandStickinessCache` (imports `android.app.Service`) | `T3VoiceStartCommandPolicyTest` |

Note: the _service shell_ proper (`T3VoiceRuntimeService`) is the manifest-named entry class
and stays root by decision §0.1; `host/` therefore holds the host **driver + host lifecycle
policy** only. If you prefer the service to physically live under `host/`, that is the §3
"move" alternative and costs one manifest edit.

### kernel/ — mailbox, epochs, recovery, reducers/policies, kernel state, domain models (21)

| File                                    |  LoC | Doubt | Contents                                                                                                                                                                                                                                                  | Tests                                                                                              |
| --------------------------------------- | ---: | :---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `VoiceKernel.kt`                        |   19 |       | `VoiceKernelReducer`, `VoiceKernelState`, `VoiceKernelReduction`                                                                                                                                                                                          | —                                                                                                  |
| `VoiceKernelEffects.kt`                 |  250 |       | `VoiceKernelEffect`, `VoiceKernelEffectFamily`                                                                                                                                                                                                            | —                                                                                                  |
| `VoiceKernelEpoch.kt`                   |  153 |       | epoch model + `VoiceKernelEpochPolicy` + `VoiceKernelEpochRegistry`                                                                                                                                                                                       | `VoiceKernelEpochPolicyTest`                                                                       |
| `VoiceKernelMailbox.kt`                 |  140 |       | `VoiceKernelMailbox` (uses `android.os.Handler/Looper` as its thread substrate — still the kernel mailbox)                                                                                                                                                | `VoiceKernelMailboxInstrumentedTest` (androidTest)                                                 |
| `VoiceKernelMessages.kt`                |   76 |       | `VoiceKernelMessage`, `VoiceKernelHostIntentAction`, `VoiceKernelDriver`, driver-result payloads                                                                                                                                                          | `VoiceKernelHostIntentActionTest`                                                                  |
| `VoiceRuntimeCoreModels.kt`             |  186 |   S   | core domain: `VoiceRuntimeIdentity/Cursor/Snapshot/Target/Operation/Event/…` + exception types. Whole-file → kernel.                                                                                                                                      | `VoiceRuntimeFoundationTest`                                                                       |
| `VoiceRuntimeExecutionModels.kt`        |  321 |       | `VoiceRuntimeExecutionSnapshot`, phases, `VoiceRuntimeExecutionEvent`, `VoiceRuntimeCommand`, transitions                                                                                                                                                 | `VoiceRuntimeExecutionStateTest`                                                                   |
| `VoiceRuntimeExecutionReducer.kt`       |  472 |       | `VoiceRuntimeExecutionReducer` (pure)                                                                                                                                                                                                                     | `VoiceRuntimeExecutionStateTest`                                                                   |
| `VoiceRuntimeExecutionRecovery.kt`      |  137 |       | `VoiceRuntimeExecutionRecovery`, `idleAfterOperation`                                                                                                                                                                                                     | (covered by recovery tests)                                                                        |
| `VoiceRuntimeRecovery.kt`               |  289 |       | `recover()`, `VoiceRuntimeRecoveryPlan/Effect`, `LoadedState`, `Permissions`, `Clock`                                                                                                                                                                     | `VoiceRuntimeRecoveryTest`                                                                         |
| `VoiceRuntimeRealtimeEngine.kt`         | 1934 |       | `VoiceRuntimeRealtimeReducer` + all realtime state/effect/interface types (no network I/O)                                                                                                                                                                | `VoiceRuntimeRealtimeReducerTest`, `VoiceRuntimeRealtimeTest` (see net note)                       |
| `VoiceRuntimeRealtimeEngineSlot.kt`     |  199 |       | `VoiceRuntimeRealtimeEngineSlot`, binding/snapshot/installation                                                                                                                                                                                           | `VoiceRuntimeRealtimeEngineSlotTest`                                                               |
| `VoiceRuntimeRealtimeExecution.kt`      |  295 |       | realtime authority/attempt/cleanup/restart/reconciliation **policies**                                                                                                                                                                                    | `VoiceRuntimeRealtimeExecutionTest`, `VoiceRuntimeRealtimeCleanupTest`                             |
| `VoiceRuntimeThreadExecution.kt`        |  660 |   ⚠   | thread authority/rearm/cancel/terminal/… **policies** + `T3VoiceRecordingFileBody`/`VoiceRuntimeThreadRecordingBodyPolicy` (a net request body — minor). Whole-file → kernel; body types are the compromise.                                              | `VoiceRuntimeThreadExecutionTest`                                                                  |
| `VoiceRuntimeCommittedReadiness.kt`     |   38 |       | `VoiceRuntimeCommittedReadinessPolicy`                                                                                                                                                                                                                    | `VoiceRuntimeCommittedReadinessTest`                                                               |
| `VoiceRuntimeLegacyRealtimeCutover.kt`  |   40 |       | `VoiceRuntimeLegacyRealtimeCutover`                                                                                                                                                                                                                       | `VoiceRuntimeLegacyRealtimeCutoverTest`                                                            |
| `VoiceRuntimeAuthority.kt`              |   85 |   ⚠   | `VoiceRuntimeAuthorityRegistry` (in-memory) + checkpoint. kernel (in-memory registry); durable twin is `VoiceRuntimeAuthorityStore`→store. Alt: store/.                                                                                                   | (covered by controller/authority tests)                                                            |
| `VoiceRuntimeActiveThreadController.kt` | 1227 |  S⚠   | `VoiceRuntimeActiveThreadController` orchestrator + `VoiceRuntimeDeviceIdentityStore(context)` (small durable store inside). Whole-file → kernel; the device-identity store is the compromise. Alt: host/.                                                | `VoiceRuntimeActiveThreadControllerTest`                                                           |
| `T3VoiceDiagnosticRing.kt`              |  200 |   ⚠   | `T3VoiceDiagnosticRing`, `T3VoiceDiagnostics`, entry/category/code. Cross-cutting infra written by every layer, surfaced to bridge. Recommend kernel/ (shared infra; only `android.os.SystemClock`). Alt: host/ or a `util/` (not in the sanctioned six). | `T3VoiceDiagnosticRingTest`                                                                        |
| `T3VoiceState.kt`                       |  545 |   S   | state models + `T3VoiceStateStore` + `T3VoiceBridgeCompletionStore/Actions` + `restoreBridgeRecordingCompletions`. Whole-file → kernel; bridge-completion store is the compromise (§2).                                                                   | `T3VoiceStateStoreTest`                                                                            |
| `T3VoiceReadiness.kt`                   |  947 |   S   | ~25 readiness/control **policies** + `T3VoiceReadinessStore(context)` (durable) + `T3VoiceControllerCommands` + `T3VoiceControlPolicy/Command/Decision`. Whole-file → kernel; readiness store + controller commands are the compromise (§2).              | `T3VoiceCanonicalReadinessPolicyTest`, `T3VoiceControlPolicyTest`, `T3VoiceControllerCommandsTest` |

### media/ — media driver + recorder/players/cues/router/focus/webrtc/endpoint (14)

| File                                   |  LoC | Doubt | Contents                                                                                                                                         | Tests                                   |
| -------------------------------------- | ---: | :---: | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `VoiceMediaDriver.kt`                  |  277 |       | `VoiceMediaDriver`, factory, events, `AndroidVoiceMediaDriverFactory`                                                                            | `VoiceMediaDriverTest`                  |
| `T3VoiceRecorder.kt`                   |  392 |       | `T3VoiceRecorder`, `T3VoiceRecordingCache`, `T3VoiceCompletedRecordingRegistry`, termination                                                     | `T3VoiceRecordingCacheTest`             |
| `T3VoicePcmPlayer.kt`                  |  531 |       | `T3VoicePcmPlayer` + PCM output/clock/limits                                                                                                     | `T3VoicePcmPlayerTest`                  |
| `T3VoiceCuePlayer.kt`                  |  413 |       | `T3VoiceCuePlayer`, cue enums, Android cue output/clock/worker/scheduler                                                                         | `T3VoiceCuePlayerTest`                  |
| `T3VoiceCueCoordinator.kt`             |   21 |       | `T3VoiceCueCoordinator`                                                                                                                          | —                                       |
| `T3VoiceCueSettings.kt`                |   38 |   ⚠   | `T3VoiceCueSettings` + `T3VoiceCueSettingsStore(context)` (durable, but cue-coupled). Recommend media/ (co-locate with cue player). Alt: store/. | —                                       |
| `T3VoiceAudioRouter.kt`                |  406 |       | `T3VoiceAudioRouter`, route/start-result models                                                                                                  | `T3VoiceAudioRouterEpochAdmissionTest`  |
| `T3VoiceAudioRoutePolicy.kt`           |   72 |       | `T3VoiceAudioRoutePolicy` + route kind/device/change enums                                                                                       | `T3VoiceAudioRoutePolicyTest`           |
| `T3VoiceAudioFocusPolicy.kt`           |   85 |       | `T3VoiceAudioFocusPolicy` + focus state/event/action                                                                                             | `T3VoiceAudioFocusPolicyTest`           |
| `T3VoicePlaybackAudioFocus.kt`         |  101 |       | `T3VoicePlaybackAudioFocus`                                                                                                                      | (via player tests)                      |
| `T3VoiceWebRtcSession.kt`              | 1230 |       | `T3VoiceWebRtcSession` + WebRTC callbacks (18 `org.webrtc`/`android.media` imports)                                                              | (instrumented-adjacent; unit-untested)  |
| `T3VoiceEndpointDetector.kt`           |  247 |       | `T3VoiceEndpointDetector` + diagnostics/config                                                                                                   | `T3VoiceEndpointDetectorTest`           |
| `T3VoiceCapturePolicy.kt`              |   21 |       | `T3VoiceCapturePolicy`, `T3VoiceCaptureState`                                                                                                    | `T3VoiceCapturePolicyTest`              |
| `T3VoiceRealtimePlayoutDrainPolicy.kt` |   57 |       | `T3VoiceRealtimePlayoutDrainPolicy` + monitor                                                                                                    | `T3VoiceRealtimePlayoutDrainPolicyTest` |

### net/ — net driver + HTTP transport + HTTP delegates/gateways (6)

Principle: a file lives in `net/` when its _reason to exist_ is talking to the network
(delegate/transport/gateway that performs I/O), even though it also carries request/response
model classes. Pure reducers/policies with no I/O go to `kernel/`.

| File                                 | LoC | Doubt | Contents                                                                                                                                                                                                               | Tests                        |
| ------------------------------------ | --: | :---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `VoiceNetDriver.kt`                  |  93 |       | `VoiceNetDriver`, lanes, executor factory, result sink                                                                                                                                                                 | `VoiceNetDriverTest`         |
| `VoiceRuntimeHttp.kt`                | 463 |       | `VoiceRuntimeHttpTransport/Call` (java.net), request/result/method/policy models, bounded stream                                                                                                                       | `VoiceRuntimeHttpTest`       |
| `VoiceRuntimeRealtimeHttpGateway.kt` | 191 |       | `VoiceRuntimeRealtimeHttpGateway`                                                                                                                                                                                      | (via realtime tests)         |
| `VoiceRuntimeRealtime.kt`            | 923 |  S⚠   | `VoiceRuntimeRealtimeDelegate` (HTTP) + realtime wire models + path builders. Whole-file → net; carries many models (compromise). Alt: kernel/.                                                                        | `VoiceRuntimeRealtimeTest`   |
| `VoiceRuntimeThreadTurn.kt`          | 961 |  S⚠   | `VoiceRuntimeThreadTurnDelegate` (HTTP) + thread-turn wire models + JSON. Whole-file → net (compromise: models). Alt: kernel/.                                                                                         | `VoiceRuntimeThreadTurnTest` |
| `VoiceRuntimeControl.kt`             | 251 |   ⚠   | native heartbeat: `T3VoiceHttpsNativeHeartbeatTransport` (HTTP) + schedule/response/origin **policies** + control lease. Recommend net/ (I/O file, consistent with the other transports). Alt: kernel/ (policy-heavy). | `VoiceRuntimeControlTest`    |

### store/ — durable stores/repos/journals (11)

| File                                     | LoC | Doubt | Contents                                                                                                                                                                                                           | Tests                                                            |
| ---------------------------------------- | --: | :---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `VoiceStoreDriver.kt`                    |  32 |       | `VoiceStoreDriver`                                                                                                                                                                                                 | `VoiceStoreDriverTest`                                           |
| `VoiceRuntimeStorage.kt`                 | 287 |   S   | `VoiceRuntimeKeyValueStore`/`VoiceRuntimePreferences` + grant cipher (Keystore) + grant/credential models + `VoiceRuntimeSessionCredentialStore`. Whole-file → store.                                              | (via durability tests); helper `MemoryRuntimeStorage.kt` → store |
| `VoiceRuntimeDurableJournal.kt`          | 791 |       | `VoiceRuntimeDurableJournalRepository` + memory twin + retention model                                                                                                                                             | `VoiceRuntimeDurabilityTest`                                     |
| `VoiceRuntimeJournal.kt`                 | 120 |   ⚠   | `VoiceRuntimeJournal` + `VoiceRuntimeIdempotencyLedger` + `VoiceRuntimeDeliveryGate` (all in-memory dedup). Recommend store/ (co-locate with journals). Alt: kernel/ (idempotency/delivery are kernel primitives). | (via durability/execution tests)                                 |
| `VoiceRuntimeDurableArtifacts.kt`        | 256 |       | `VoiceRuntimeDurableDraftRepository` + memory twin + draft models                                                                                                                                                  | (via durability tests)                                           |
| `VoiceRuntimeConsumers.kt`               | 261 |   ⚠   | `VoiceRuntimeConsumerRegistry` + `VoiceRuntimePresentationActionStore` + `VoiceRuntimeDraftArtifactStore` + opaque payload. Recommend store/. Alt: kernel/ (registry logic).                                       | (via durability/control tests)                                   |
| `VoiceRuntimeThreadOperationStore.kt`    | 461 |       | `VoiceRuntimeThreadOperationStore` + claim/state/result                                                                                                                                                            | `VoiceRuntimeThreadOperationStoreTest`                           |
| `VoiceRuntimeAuthorityStore.kt`          | 402 |       | `VoiceRuntimeAuthorityStore` (durable) + persisted/fence models + lifecycle policy                                                                                                                                 | `VoiceRuntimeAuthorityStoreTest`                                 |
| `VoiceRuntimeExecutionSnapshotStore.kt`  | 129 |       | `VoiceRuntimeExecutionSnapshotStore`                                                                                                                                                                               | (via execution/durability tests)                                 |
| `VoiceRuntimeRealtimeCheckpointStore.kt` | 787 |       | `VoiceRuntimeDurableRealtimeCheckpointRepository`                                                                                                                                                                  | `VoiceRuntimeRealtimeCheckpointStoreTest`                        |
| `VoiceRuntimeRealtimeCleanupStore.kt`    |  82 |       | `VoiceRuntimeRealtimeCleanupStore` + load result                                                                                                                                                                   | `VoiceRuntimeRealtimeCleanupTest`                                |

### bridge/ — Expo↔native binder registry/dispatcher + event projection + validation (4)

| File                                | LoC | Doubt | Contents                                                                                                                                                 | Tests                                |
| ----------------------------------- | --: | :---: | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `VoiceRuntimeBridge.kt`             | 740 |       | `VoiceRuntimeBridge` (event/snapshot projection to JS)                                                                                                   | (via control/realtime tests)         |
| `T3VoiceBinderOperationRegistry.kt` |  92 |       | `T3VoiceBinderOperationRegistry<T>`                                                                                                                      | `T3VoiceBinderOperationRegistryTest` |
| `T3VoiceBridgeValidation.kt`        |  27 |       | `T3VoiceBridgeValidation`                                                                                                                                | `T3VoiceBridgeValidationTest`        |
| `T3VoiceSessionIdAssertion.kt`      |  22 |   ⚠   | `T3VoiceSessionIdAssertion` — monotonic session-id guard at the bridge boundary. Recommend bridge/ (pairs with BridgeValidation). Alt: host/ or kernel/. | `T3VoiceSessionIdAssertionTest`      |

Note: `T3VoiceBinderOperationDispatcher` is a bridge concept but is a top-level class inside
`T3VoiceModule.kt`, which stays root (§0.1); it therefore stays root with the module.
`T3VoiceBinderOperationDispatcherTest` stays root with it.

---

## 2. Straddlers — split vs whole-move

**Policy applied:** M7 is "mechanical, no behavior change." Bias = **whole-file move with a
documented compromise**. Split only if it is a _pure cut-paste of top-level declarations_
into a sibling file in the same target package with no body edits and no new cross-file
references introduced. **None of the straddlers below require a split for M7; all move
whole.** Splits are listed only to document where a future non-mechanical refactor would cut.

| File                                                                | Belongs to >1 package because…                                                                                                                                                                                             | M7 action                                                                                                                                        | Deferred split boundary (NOT done in M7)                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T3VoiceRuntimeService.kt` (5967)                                   | host shell + notification/MediaSession + loader + interpreter + hundreds of `*Locked` executors that reach into kernel/media/net/store                                                                                     | **MOVE WHOLE — stays root** (manifest FQCN). Splitting it means touching bodies → forbidden in M7.                                               | (future) extract `T3VoiceNotificationSnapshot` + the finalization/capture/recovered-authority policy `object`s to `host/`; leave `Service` subclass root.                                                                                                                     |
| `T3VoiceModule.kt` (1029)                                           | Expo `Module` (bridge) + `T3VoiceBinderOperationDispatcher` (bridge)                                                                                                                                                       | **MOVE WHOLE — stays root** (expo config FQCN). Both halves are bridge anyway; no conflict.                                                      | (future) `T3VoiceBinderOperationDispatcher`/`T3VoiceBinderOperationAdmission` → `bridge/` (pure cut-paste, but needs an import back to the module → defer).                                                                                                                   |
| `T3VoiceState.kt` (545)                                             | `T3VoiceStateStore` + state models (**kernel**) vs `T3VoiceBridgeCompletionStore/Actions` + `restoreBridgeRecordingCompletions` (**bridge**) + completion event bodies                                                     | **MOVE WHOLE → kernel/.** Compromise: bridge-completion store rides along in kernel/.                                                            | (future) cut `T3VoiceBridgeCompletionStore`, `T3VoiceBridgeCompletionActions`, `restoreBridgeRecordingCompletions`, `T3VoiceRecordingCompletion`, `T3VoicePlaybackCompletion` → `bridge/T3VoiceBridgeCompletion.kt` (pure top-level cut-paste; adds imports → defer past M7). |
| `T3VoiceReadiness.kt` (947)                                         | ~25 readiness/control **policies** + `T3VoiceControlPolicy/Command/Decision` (**kernel**) vs `T3VoiceReadinessStore(context)` durable (**store**) vs `T3VoiceControllerCommands`/`T3VoicePendingCommand` (**host/kernel**) | **MOVE WHOLE → kernel/.** Compromise: readiness store + controller commands ride along.                                                          | (future) `T3VoiceReadinessStore` + `T3VoiceReadinessStoreCheckpoint` → `store/`; `T3VoiceControllerCommands` → `host/`. Each is a clean top-level cut, but touches 3 test files' imports → defer.                                                                             |
| `VoiceRuntimeCoreModels.kt` (186)                                   | shared identity/cursor/snapshot/target/operation/event/exception types consumed by kernel **and** net **and** store **and** bridge                                                                                         | **MOVE WHOLE → kernel/.** It is the shared domain vocabulary; kernel is the natural owner and every other package imports from kernel. No split. | none recommended — a shared-models file is correct as-is.                                                                                                                                                                                                                     |
| `VoiceRuntimeStorage.kt` (287)                                      | key-value store + Keystore grant cipher + credential store + grant/target-identity models                                                                                                                                  | **MOVE WHOLE → store/.** All halves are durable-store concerns.                                                                                  | none needed for M7.                                                                                                                                                                                                                                                           |
| `VoiceRuntimeActiveThreadController.kt` (1227)                      | orchestrator (**kernel**) + `VoiceRuntimeDeviceIdentityStore(context)` durable (**store**)                                                                                                                                 | **MOVE WHOLE → kernel/.** Compromise: device-identity store rides along.                                                                         | (future) `VoiceRuntimeDeviceIdentityStore` → `store/`.                                                                                                                                                                                                                        |
| `VoiceRuntimeRealtime.kt` (923) / `VoiceRuntimeThreadTurn.kt` (961) | HTTP delegate (**net**) + a large family of wire model classes (could read as kernel domain)                                                                                                                               | **MOVE WHOLE → net/.** The delegate is the point of the file; models are its DTOs.                                                               | none — DTOs belong with their delegate.                                                                                                                                                                                                                                       |

---

## 3. Visibility / import / string-literal FQCN audit

### 3a. Visibility — nothing can break

- **`internal` is Gradle-**module**-scoped.** Every declaration in this module is `internal`
  except `class T3VoiceRuntimeService` and `class T3VoiceModule` (both `public`) and the
  handful of `public` kernel value types (`VoiceKernel*`, `VoiceKernelEpoch`…). Moving files
  among sub-packages of the **same** module leaves all `internal` symbols mutually visible.
  **A package move cannot break `internal` visibility.**
- **`private` is file-scoped** — a `private` top-level declaration has, by language rule, no
  cross-file users. There is therefore _nothing_ a package move could break at `private`
  scope. (The `private object AndroidCue*`, `private fun`, `private const`, `private data
object VoiceRuntimeHttpCancelledException`, etc. seen in the census are all file-local.)
- **Unit tests + androidTest see `internal`.** Both test source sets share the module's
  `internal` scope (already relied upon today), so a test file may reference a moved class
  from any sub-package with just an added `import`; it need not physically move to compile.

### 3b. `expo.modules.t3voice` as a STRING literal — the critical inventory

Grepped repo-wide (excluding `build/`). Every string-literal FQCN that a move would break:

| Location                                  | String                                                                                | Kind                                            | Effect of moving the named class                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android/src/main/AndroidManifest.xml:22` | `android:name="expo.modules.t3voice.T3VoiceRuntimeService"`                           | **class FQCN**                                  | If the Service moves, the manifest **must** be edited or `startForegroundService` throws `ClassNotFoundException` **at runtime on device** (not caught by pc gate).                                                                                                                                                                                                           |
| `expo-module.config.json:4`               | `"modules": ["expo.modules.t3voice.T3VoiceModule"]`                                   | **class FQCN**                                  | If the Module moves, the Expo module registry generated from this file won't find it → `requireOptionalNativeModule("T3Voice")` returns null **on device**; voice silently unavailable. Not caught by pc gate.                                                                                                                                                                |
| `package.json:9`                          | `"expo-module": { "android": { "modules": ["expo.modules.t3voice.T3VoiceModule"] } }` | **class FQCN**                                  | Same as above; this is the second registry source and must be kept in lockstep with the config json.                                                                                                                                                                                                                                                                          |
| `android/build.gradle:8`                  | `namespace 'expo.modules.t3voice'`                                                    | **package namespace root**                      | **No change.** Sub-packages live _under_ this namespace; the root is unaffected by the split.                                                                                                                                                                                                                                                                                 |
| `T3VoiceRuntimeService.kt:5940-5947`      | `ACTION_PRIMARY = "expo.modules.t3voice.action.PRIMARY"` … (8 constants)              | **Intent action identifiers** (NOT class names) | **PRESERVE VERBATIM.** These are opaque action-name strings shared between the notification `PendingIntent`s and the service's `onStartCommand` dispatch; they do **not** depend on the class's package. "Helpfully" renaming them to a new package prefix would be a **behavior change** (action-identity mismatch). Do not touch — regardless of where the service ends up. |

**Not FQCN-bound (safe):**

- JS side uses the Expo **registration name** `"T3Voice"` (`src/index.ts:47`
  `requireOptionalNativeModule("T3Voice")` ↔ `T3VoiceModule.kt:135` `Name(MODULE_NAME)`,
  `MODULE_NAME = "T3Voice"`). Package-independent — **no TS/JS edit ever.**
- All in-code class references are **type** references that follow imports, not strings:
  `ComponentName(context, T3VoiceRuntimeService::class.java)` (module + instrumented test),
  `Intent(this, T3VoiceRuntimeService::class.java)` (service self-intents),
  `value::class.java.name` (diagnostic string in `VoiceRuntimeContractFixtureTest:112`).
- **No `Class.forName`, no `setClassName`, no reflection-by-string, no ProGuard/consumer
  rules** exist in the module (only `build.gradle`, `AndroidManifest.xml`,
  `expo-module.config.json`, `package.json` — no `*.pro`). **No KSP/kapt** in `build.gradle`
  (Expo registers via the config-file FQCN list, not annotation processing) — so there is no
  generated-code FQCN to chase.

### 3c. Binding recommendation on the FQCN classes

**KEEP `T3VoiceRuntimeService` and `T3VoiceModule` in the root package `expo.modules.t3voice`.**

Rationale: the three FQCN edits (manifest, expo-module.config.json, package.json) are the
**only** changes in the entire M7 that (a) are not package/import lines and (b) **cannot be
verified by the pc gate** — a wrong FQCN string compiles clean, the unit tests pass, and the
androidTest compiles; it fails only when the app actually starts the service / loads the
module on a device. Given the kernel program's "one final device validation" posture, a
mistyped FQCN would surface only at that late gate. Keeping the two named classes at root
buys a diff whose **every hunk is a `package` line or an `import` line** — trivially
audited, nothing device-only. `host/` and `bridge/` still exist and hold their satellites;
the root package simply _is_ the Android-registered entry layer (a common, defensible Android
module shape).

**Alternative (higher-risk, if reviewers insist the entry classes live in sub-packages):**
move `T3VoiceRuntimeService`→`host/`, `T3VoiceModule`→`bridge/`, and make **exactly these
three edits** (and no others):

1. `AndroidManifest.xml:22` → `android:name="expo.modules.t3voice.host.T3VoiceRuntimeService"` (or relative `.host.T3VoiceRuntimeService`).
2. `expo-module.config.json:4` → `"expo.modules.t3voice.bridge.T3VoiceModule"`.
3. `package.json:9` → `"expo.modules.t3voice.bridge.T3VoiceModule"`.
   Then the **final device validation must additionally re-verify service start + module
   registration**, because the pc gate cannot. (The 8 `ACTION_*` strings still stay verbatim.)

---

## 4. Order + verification

### Commit structure — recommend ONE atomic move commit

Because the package is flat today (0 intra-module imports), _every_ cross-package reference
becomes a **newly added import** the moment the referenced file changes package. A
per-package commit sequence does **not** localize the blast radius: moving `store/` first
still forces added imports into files across kernel/net/media/host/root that reference a
store type. Per-package commits merely fragment one internally-consistent diff into several,
each still spanning the whole module.

**Recommendation:** a single commit `refactor(voice): split t3voice into host/kernel/media/net/store/bridge`
containing all 58 `git mv`s (60 files − 2 unmoved) + their `package`-line rewrites + all
added imports + the mirror moves of the 47 unit-test + 2 androidTest files. Under decision
§0.1 there are **no config hunks at all**, so the whole diff is package+import lines.

If a reviewer prefers smaller reviewable chunks, the only defensible seam is **two** commits:
(1) all Kotlin `git mv` + package/import rewrites; (2) — only under the §3c alternative — the
3 config-FQCN edits, isolated so the one non-mechanical, device-only-verifiable hunk-set is
reviewed alone. Under the binding recommendation, commit (2) does not exist.

**Test tree:** move each test file to the sub-package that mirrors its subject (parallel
`src/test/java/expo/modules/t3voice/<pkg>/`), rewriting its `package` line; same-package
subject references then need no import. `MemoryRuntimeStorage.kt` (test helper, no `Test`
suffix) → `store/`. Tests whose subject stays root (`T3VoiceRuntimeServiceRecoveryTest`,
`T3VoiceBinderOperationDispatcherTest`, and androidTest `T3VoiceRuntimeServiceInstrumentedTest`)
**stay root**. `VoiceKernelMailboxInstrumentedTest` → `kernel/`. Tests are `internal`-scoped
so this is tidiness, not a compile requirement — but doing it keeps the parallel tree and
avoids scattering imports.

### Greps that prove zero behavior change (diff-shape invariant)

The M7 diff is valid iff **every added/removed line** is one of:

- a `package expo.modules.t3voice…` line (one per moved file), or
- an `import expo.modules.t3voice.…` line (added where a seam is now crossed), or
- a `git`-rename header (pure path move, 100% similarity on body).

Verification recipe (run against the M7 diff):

```
# 1. Body must be identical across the rename — expect "similarity index 100%" (or only
#    the single package line changed) for every renamed file:
git diff -M --summary <base>..HEAD          # every entry is a rename R100/near-100
# 2. Every content hunk line (excluding rename headers) starts with package/import:
git diff -M -U0 <base>..HEAD | grep -E '^[+-]' | grep -vE '^[+-]{3} ' \
  | grep -vE '^[+-](package |import )expo\.modules\.t3voice' \
  | grep -vE '^[+-]\s*$'                     # EXPECT: empty output
# 3. No source line other than package/import moved (catches accidental body edits):
#    any non-empty result from #2 is a red flag to inspect.
# 4. Under the §3c alternative only, the 3 config lines are the *sole* allowed exception;
#    grep them explicitly and confirm no other config/manifest hunk exists.
# 5. The 8 ACTION_ strings must be byte-identical pre/post:
git show <base>:.../T3VoiceRuntimeService.kt | grep 'action\.' ;  # == HEAD version
```

Empty output from step 2 (modulo the 3 config lines only if the alternative is taken) is the
proof of "mechanical, no behavior change."

### pc-gate expectation

The pc gate here is the orchestrator-owned, post-park gate = **Kotlin compilation + the
module unit-test suite + androidTest _compile_**, with
`T3VoiceRuntimeServiceInstrumentedTest` passing (its assertions unchanged; under §0.1 it also
needs no edit since the service stays root). Expectation for M7:

- **Compiles** — the added imports resolve (guaranteed if the split is consistent; the
  compiler itself is the oracle that the import set is complete).
- **Identical unit-test results** — same tests, same pass/fail; no test _logic_ changes,
  only `package`/`import` lines and file paths. No new tests, none deleted.
- **androidTest compiles**; `T3VoiceRuntimeServiceInstrumentedTest` passes unmodified (root)
  or with a single added import (only under §3c). This is the closest the pc gate gets to
  catching a manifest FQCN mistake — and it only catches the _service_ one, never the Expo
  module registration, which is why §3c keeps both classes at root.

---

## 5. Risks — what could make M7 non-mechanical

1. **FQCN string drift (highest).** The manifest + 2 Expo config files name classes by
   string and are **not** compile-verified. Mitigated to zero by decision §0.1 (keep both
   classes at root). If the §3c alternative is taken, this becomes a real device-only risk
   carried to the final validation. (No KSP/kapt and no ProGuard means there are no _other_
   generated or reflective FQCNs to miss — the three config files are the complete set.)
2. **Intent action constants (subtle).** The 8 `ACTION_* = "expo.modules.t3voice.action.*"`
   look like they should track the package but must **not** — they are action identities, not
   class names. A well-intentioned rename is a behavior change. Called out in §3b; the
   grep in §4 step 5 guards it.
3. **Directory ↔ package coupling.** Android/Gradle expects the file path under
   `src/main/java/` to mirror the package. Each move is `git mv` **and** the `package` line
   edit together; doing one without the other (e.g. editing the package line but leaving the
   file in the old dir) compiles under Kotlin but breaks the mirror and confuses tooling —
   keep them atomic per file.
4. **Instrumented-test runner config.** `testInstrumentationRunner` is the stock
   `androidx.test.runner.AndroidJUnitRunner` (build.gradle) — no custom runner class named by
   string, so androidTest packaging is unaffected. The one FQCN the androidTest depends on
   (`T3VoiceRuntimeService` via `::class.java`) is a type ref (safe) and, under §0.1, does
   not move.
5. **Test resource paths.** No `src/*/resources` or `assets` fixtures in the module (tests
   build fixtures in-code; `VoiceRuntimeContractFixtureTest` uses inline canonical values).
   So no resource-path breakage from moving test files. Confirm with `find src -path '*/resources/*'`
   before the move (expected empty).
6. **`build/` staleness.** The stale `build/intermediates/**` still contains the old flat
   manifest/FQCNs; irrelevant (regenerated on next build) but will pollute repo-wide greps —
   always exclude `build/` when auditing.

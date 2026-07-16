# M5 Run 1 — Bridge Conversions (pending/ack → completion handles + retained records)

First of two M5 runs (`specs/native-voice-runtime-kernel.md` Bridge + Migration M5;
inventory: `specs/kernel-milestones/m5-seam-map.md`, anchors at `5a765febf` — the F2 commit
`2eb4e465d` shifted `T3VoiceRuntimeService.kt` by ~+40 lines; RE-LOCATE BY SYMBOL, never by
raw line). Scope: convert the four live pending/ack groups; rewire the live TS; bump
`nativeRevision` 15→16. NO deletions of the 17 ui-attached functions here (run 2). One
vertical switch per group — no aliases, no dual delivery paths.

## Drift rulings binding for this run (seam-map §8)

- D2: KEEP-protocol is 20 functions incl. `setVoiceRuntimeSessionCredentialAsync` (the M0
  pairing-session carrier). Do not touch it.
- D4: `recordingTerminated`/`playbackTerminated` events become WAKE-ONLY (payload: owner
  domain + operationId, nothing else). Results travel exclusively through the completion
  records. Post-M5 events: `playbackChunkConsumed`, `runtimeError`, `voiceRuntimeWake`,
  plus the two wakes = 5.
- D5: the dedicated revocation acknowledge dies (no TS caller anywhere). Its coordinator
  cleanup (`T3VoiceRevocationAcknowledgementCoordinator` — clears thread operation + fence)
  moves into the native handling of `acknowledgeVoiceRuntimeRetainedRecord` for the new
  `AuthorityRevocation` key, so the cleanup is preserved and gains the durable-ack model.

## Group A + B — per-operation completion records (composer recording, manual playback)

Replace the two global sticky slots (`T3VoiceStateStore.mutableRecordingTermination`
State.kt:208, `mutablePlaybackTermination` :210) with per-operation completion records:

- New `T3VoiceBridgeCompletionStore` (kernel-thread-only, in-memory — same durability as
  the slots it replaces): records keyed by (ownerDomain, operationId), holding the same
  terminal event body the slots carry today. Written where
  `T3VoiceStateStore.terminateRecording`/`terminatePlayback` write the slots today
  (State.kt:416/:497) for COMPOSER_DICTATION and MANUAL_PLAYBACK domains ONLY — thread/
  handoff/realtime-handoff/cue domains never produce bridge records (ownership
  spec:318-324: native-consumed).
- Bridge surface conversion (names may stay; shapes change — revision bump covers it):
  - `getPendingRecordingTerminationAsync` → returns ALL pending completion records for
    COMPOSER_DICTATION (list, includes pre-crash orphans of the domain).
  - `acknowledgeRecordingTerminationAsync` → acks by operationId.
  - `discardUnownedRecordingTerminationAsync` DIES in this run: orphan handling is now
    "get returns them, ack clears them" (the handoff-protection guard it carried is
    bridge-only and its machinery dies in run 2).
  - Same pattern for `getPendingPlaybackTerminationAsync`/`acknowledgePlaybackTerminationAsync`.
- `deleteRecordingAsync` (KEEP) re-source: its ownership/URI validation reads the sticky
  slot today (service `deleteRecording` binder, svc:606-613 at old anchors). Point it at
  the completion store record for (COMPOSER_DICTATION, recordingId's operation) — same
  data, per-operation. This MUST land in the same commit as the slot removal.
- Events: `recordingTerminated`/`playbackTerminated` emission points switch to wake-only
  payloads (domain + operationId). The module event collectors that swallow
  `PlaybackTerminated`/`RecordingTerminated` bodies (module:116-117) update accordingly.
- The realtime sticky slot (`mutableRealtimeTermination` State.kt:206) is NOT converted —
  it dies in run 2 with the `realtimeTerminated` event (its only reader is the binder
  getter). Do not touch it here.

## Group C + D — durable notices → retained records

- Add two `VoiceRuntimeRetainedRecordKey` variants (VoiceRuntimeCoreModels.kt:140-154,
  beside `ThreadReceipt`/`RealtimeTerminal`): `ReadinessDisabled(generation)` and
  `AuthorityRevocation(runtimeId, environmentOrigin)`.
- The two disable write sites emit them into the durable journal (redelivery via the
  existing rebase model, Journal.kt:56-71):
  - `disableReadinessLocked` → `writeDisabledWithPending` (svc:6007 old anchors) —
    currently sets pref `pending_disabled_generation` (Readiness.kt:524).
  - `disableRuntimeVoiceReadinessLocked` → `writeDisabledForRuntimeRevocation` (svc:369) —
    currently sets `pending_revocation_*` (Readiness.kt:532-534).
- The SharedPreferences pending flags and their read/ack API
  (`pendingDisabled`/`acknowledgePendingDisabled` Readiness.kt:446-450/:502-506;
  `pendingRuntimeRevocation`/`acknowledgeRuntimeRevocation` :392-400/:437-444) die in the
  SAME commit (no dual shape). The four bridge functions
  (`getPendingReadinessDisabledAsync`/`acknowledgeReadinessDisabledAsync`/
  `getPendingVoiceRuntimeAuthorityRevocationAsync`/`acknowledgeVoiceRuntimeAuthorityRevocationAsync`)
  die with them; consumers move to the journal read path.
- Native `acknowledgeVoiceRuntimeRetainedRecord` handling: on `AuthorityRevocation`, run
  the `T3VoiceRevocationAcknowledgementCoordinator` body (the clearDerived closure —
  recording delete + durable thread-operation clear + attempt retire) before clearing the
  record. VERIFY (implementer + reviewer): every cleanup step the coordinator performs is
  either preserved here or already performed by the autonomous retire path
  (`disableVoiceRuntimeReadinessAsync` + `clearVoiceRuntimeAuthorityIfIdleAsync`,
  provisioning ts:67/:71). Enumerate the steps in the run notes.
- The `readinessDisabled` event dies; its consumers wake via `voiceRuntimeWake` (journal
  append already fires it).

## TS rewires (same vertical change, live Android path only)

- `useComposerDictation`: pending/ack/discard trio + `recordingTerminated` full-payload
  listener → per-operation get/ack + wake listener (seam-map §6 anchors).
- `useThreadSpeech`: pending/ack + `playbackTerminated` listener → same pattern.
- `AutonomousAndroidMasterVoiceProvider.tsx`: readiness-disabled reconcile (:417/:423) and
  revocation consumption (:443) → retained records via the journal read path +
  `acknowledgeVoiceRuntimeRetainedRecordAsync` (already in the `androidVoiceRuntime.ts`
  Pick at :31, unwired).
- `nativeVoiceReadiness.ts` `reconcilePendingNativeReadinessDisable` (:134-137) reshapes
  accordingly.
- DO NOT touch the ui-attached seed (`MasterVoiceProvider` ui-attached body,
  `realtimeVoiceController`, `useAutoListenController`, `useThreadVoiceComposerController.ts`)
  or remove any `T3Voice.types.ts` interface member used only by it. Where the deleted
  group C/D functions have ui-attached callers (MasterVoiceProvider.tsx:1371/:1344/:1379),
  leave the interface members; runtime guards already prevent Android dispatch.
- `nativeRevision`: Kotlin module constant 15→16 (module:209) and TS `NATIVE_REVISION`
  (index.ts:48) in the SAME commit as the hook rewires; update the gate tests
  (index.test.ts:27/:37). Exact-equality stays.

## Forbidden

- No deletion of the 17 ui-attached bridge functions, the 5 legacy events, Scope-C
  classes, or handoff machinery (all run 2).
- No server/Effect-TS changes (retained records are native journal constructs).
- No new global sticky state of any kind.
- No behavior change to thread/handoff/realtime/cue terminal consumption (native-owned).

## Tests

- Port per seam-map §7 CONVERT list: the four State-store termination tests
  (T3VoiceStateStoreTest :226/:246/:266/:281/:309) re-expressed against the completion
  store; T3VoiceControlPolicyTest `ReadinessDisabled` (:299/:341) and
  VoiceRuntimeThreadOperationStoreTest revocation (:110) against retained records;
  useComposerDictation orphan-discard test (:68) against get-returns-orphans.
- New: completion-store per-operation isolation (two concurrent-domain records don't
  collide); retained-record redelivery via rebase for both new keys; revocation-ack
  coordinator cleanup runs on retained-record ack.
- TS: hook tests updated for wake-only events; index.test.ts revision gate 16.
- Test bodies must assert real behavior — name-preserving hollow stubs are a fix-round
  offense (M3 precedent).

## Done criteria

- Both slots gone; both pref pending flags gone; all four groups on the new model; JS
  drives recording/playback/notices end-to-end through it; revision 16 both sides;
  `pnpm run typecheck`, `pnpm run lint:mobile`, module unit tests green; tree clean.

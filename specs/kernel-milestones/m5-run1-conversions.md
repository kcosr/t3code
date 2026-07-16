# M5 Run 1 — Termination Conversions + Handoff Chain Removal

First of two M5 runs (`specs/native-voice-runtime-kernel.md` Bridge + Migration M5;
inventory: `specs/kernel-milestones/m5-seam-map.md`, anchors at `5a765febf` — HEAD has
shifted since; RE-LOCATE BY SYMBOL, never by raw line). Scope: convert the two
termination pending/ack groups (A/B) to per-operation completion records; delete the
entire thread-voice-handoff chain; bump `nativeRevision` 15→16. The tree must be
releasable after this run alone: typecheck + lint + module tests green, app functional.

## Review correspondence (pre-launch findings, binding rulings)

- F1 (FATAL): the composer termination slot is read by handoff machinery — the two
  cannot land in different runs. RULING: the full handoff chain (module fns, binders,
  state machinery, service reads/clears) moves INTO this run; see Part 2.
- F2 (FATAL) + F3 (HIGH): the retained-record protocol is a closed contracts-typed
  server-journal surface (ack union and rebase struct enumerate exactly `thread-receipt`
  and `realtime-terminal`; `parseRetainedRecordKey` throws on anything else). The kernel
  spec's premise that notices "become retained records… exactly how the contract models
  durable notices" is not supported by the cited contract sections. RULING: groups C/D
  (readiness-disabled, authority-revocation) are NOT converted in M5. They already have
  the durable+acknowledged model the conversion wanted; they stay exactly as-is except
  the caller-less `acknowledgeVoiceRuntimeAuthorityRevocationAsync` (run 2, dead code).
  A deviation note goes into the kernel spec (this run edits that one paragraph).
- F4/F5/M1/M2: folded into the design below (admission rule, orphan artifact deletion,
  slot-collector inventory, wake emission source).

## Part 1 — Groups A/B: per-operation completion records

Replace the two global sticky slots (`T3VoiceStateStore.mutableRecordingTermination`
State.kt:208, `mutablePlaybackTermination` :210) with per-operation completion records
(ownership spec ~:318-324).

**Store.** New `T3VoiceBridgeCompletionStore`, kernel-thread-only, in-memory, and
**PROCESS-GLOBAL** (re-verdict R1-A): the slots it replaces live on the process-global
`T3VoiceStateStore` and survive in-process service destroy/recreate — a service-instance
field would be a durability regression. Records keyed by (ownerDomain, operationId),
retained until acknowledged, carrying the SAME terminal event body the slots carry
today, PLUS the owner key. Written where `T3VoiceStateStore.terminateRecording`/
`terminatePlayback` write the slots today (State.kt:416/:497) for COMPOSER_DICTATION and
MANUAL_PLAYBACK domains ONLY (thread/realtime-handoff/cue terminals stay
native-consumed). Must support lookup by recordingId as well as by operationId
(`deleteRecordingAsync` addresses by recordingId + uri).

**Restore protection (R1-A — binding).** The service-restore read at svc:2230 (old
anchors), `recordingTermination.value?.recording?.let(recorder::restoreCompleted)`, is
NOT dead: on in-process service recreate the surviving slot re-registers the un-acked
recording via `restoreCompleted` BEFORE `sweepStaleCache()` runs, which is what keeps
the artifact from being swept. PORT it, do not delete it: on service restore,
re-register EVERY retained COMPOSER_DICTATION completion record's recording via
`restoreCompleted` before the sweep. Also delete the binder getters
`recordingTermination`/`playbackTermination` (svc:310-314) and the State exposures
(State.kt:222-225) with the slots (R1-B).

**Admission rule (F4 — replaces the slot guards).** `claimRecording` (State.kt:367-368)
and `claimPlayback` (:457-458) currently reject a new COMPOSER_DICTATION/MANUAL_PLAYBACK
claim while the slot is occupied. Post-conversion rule, verbatim: a new
COMPOSER_DICTATION recording claim (resp. MANUAL_PLAYBACK playback claim) is rejected
while ANY un-acknowledged completion record exists for that domain. Same observable
blocking semantics, per-domain.

**Bridge surface.**

- `getPendingRecordingTerminationAsync` → returns ALL pending COMPOSER_DICTATION
  completion records (list; includes pre-crash-era orphans of the domain).
- `acknowledgeRecordingTerminationAsync` → acks by operationId (clears the record only).
- `discardUnownedRecordingTerminationAsync` → KEPT, per-operation (F5): clears the
  record AND deletes the on-disk artifact (`recorder.delete(recordingId, uri)`), exactly
  what today's discard does at svc:645-667 minus the handoff-protection guard (which
  dies with the handoff chain in Part 2). The ack/discard distinction is load-bearing —
  ack must never delete the artifact.
- `getPendingPlaybackTerminationAsync` / `acknowledgePlaybackTerminationAsync` — same
  get-list/ack-by-operationId pattern (no discard; playback has no artifact).
- `deleteRecordingAsync` (KEEP) re-source: its validation reads the slot today
  (binder `deleteRecording`, svc:606-634 old anchors — needs recordingId→record lookup
  - uri). Point it at the completion store. MUST land in the same commit as slot removal.

**Events (D4, M2).** `recordingTerminated`/`playbackTerminated` become WAKE-ONLY:
payload exactly (ownerDomain, operationId). The wake is emitted at the completion-store
write (the only place the owner key exists) — NOT from the old event bodies. Delete the
slot collectors `recordingTerminationCollection`/`playbackTerminationCollection`
(module:132-145) + their field declarations + `cancelCollections()` references (M1), and
the events-flow swallows at module:116-117 adjust to the new wake emission. Results are
fetched via get + acked — never carried in the event.

**Not converted here:** `mutableRealtimeTermination` (dies in run 2 with its event);
groups C/D (deferred per F2 ruling — do not touch `T3VoiceReadinessStore` pending
flags, their bridge functions, or the `readinessDisabled` event).

## Part 2 — Handoff chain removal (F1 + D6, verified safe by F6)

Blocking verify FIRST (one grep, must be in the run notes):
`publishThreadVoiceHandoff` (State.kt:230) has NO production caller — test-only. That
makes the base handoff state dead at runtime on the autonomous path. If a production
caller exists, STOP and surface it instead of deleting.

Delete in this run, one commit with Part 1's slot removal:

- Module fns + their binder methods: `getPendingThreadVoiceHandoffAsync`,
  `acknowledgeThreadVoiceHandoffAsync`, `armThreadVoiceHandoffAsync`,
  `beginThreadVoiceHandoffAdoptionAsync`, `recordThreadVoiceHandoffClientStageAsync`;
  event `threadVoiceHandoff` + binder getter (svc:296) + module collector.
- State machinery: `mutableThreadVoiceHandoff` (:213) + publish/clear/pending/
  `isThreadVoiceHandoffRecordingProtected` (:229-/:245-/:299/:293), adoption
  claims/sets + `beginThreadVoiceHandoffAdoption`/`markThreadVoiceHandoffAdopted`/
  `isThreadVoiceHandoffAdoptionClaimed`/`isThreadVoiceHandoffAdopted`
  (:215-216/:257-/:272-/:280-/:288-), `realtimeHandoffRecordingTermination` var (:212)
  - its REALTIME_HANDOFF write (:417) + pending/clear (:425/:431), `ThreadVoiceHandoff`
    event body (:143).
- Service: shutdown clears (svc:2464/:2466 old anchors — relocate by symbol),
  protection reads (svc:648 dies inside the old discard body being replaced;
  `expireThreadVoiceHandoffLocked`, `discardRealtimeHandoffRecordingLocked`, and
  `cancelRealtimeHandoffRecordingLocked` with their now-dead call chains — VERIFY each
  remaining caller is itself handoff/bridge scoped before deleting; if a live autonomous
  caller exists, STOP and surface), the slot restore read at svc:2230 (PORTED into the
  completion store per Part 1's Restore protection — not deleted), `HANDOFF_CLIENT_*`
  diagnostic codes if nothing else references them.
- INTENTIONAL SURVIVORS (do NOT chase them into KEEP functions): the vestigial fields
  `handoffInProgress`, `awaitingHandoffAction`, `handoffEligibleSessionId`,
  `handoffEnvironmentOrigin` and helper `clearHandoffEligibilityLocked` remain after
  this run — they are written by run 2's `prepareRealtimeSession` binder and read
  inside KEEP realtime-terminal handling. Run 2 disposes of them.
- The nine `ThreadVoiceHandoff` tests in T3VoiceStateStoreTest + the
  `threadVoiceHandoffReconciler.test.ts` file (its subject dies).

## TS rewires (same vertical change, live Android path only)

- `useComposerDictation`: pending/ack/discard trio + `recordingTerminated` full-payload
  listener → per-operation get/ack/discard + wake listener (seam-map §6 anchors;
  `dictationTermination.ts` reshapes with it).
- `useThreadSpeech`: pending/ack + `playbackTerminated` listener → same pattern.
- DO NOT touch `AutonomousAndroidMasterVoiceProvider` C/D reconcilers (deferred), the
  ui-attached seed, or `T3Voice.types.ts` members used only by it. Handoff/termination
  interface members whose SHAPES change for the live path update; members serving only
  the ui-attached seed stay as-is.
- `nativeRevision` 15→16: Kotlin (module:209) + TS `NATIVE_REVISION` (index.ts:48) +
  gate tests (index.test.ts:27/:37), same commit as the hook rewires. Exact equality.
- The kernel spec's Bridge "Convert" paragraph already carries the F2 deviation note
  (made by the orchestrator) — do not re-edit it.

## Forbidden

- No contracts/server/Effect-TS changes of any kind.
- No touching groups C/D (beyond the kernel-spec deviation note).
- No deletion of the run-2 surface (the 12 remaining bridge fns, 4 events, Scope-C,
  realtime slot).
- No new global sticky state; no dual delivery (slot AND store) surviving the commit.
- No weakening of any KEPT test scenario.

## Tests

- Port: the four State-store termination tests (:226/:246/:266 + native-thread-slot
  :281/:309) to the completion store — :246's port asserts the F4 admission rule
  explicitly; useComposerDictation orphan-discard test (:68 area) asserts the artifact
  is DELETED on discard and NOT deleted on plain ack (F5).
- New: per-operation isolation (two records in one domain coexist; ack of one leaves
  the other); by-recordingId lookup; wake payload carries exactly (domain, operationId);
  restore-protects-unacked-record (R1-A: a retained record's recording is re-registered
  via `restoreCompleted` on service restore and survives `sweepStaleCache`).
- Delete: the nine handoff State-store tests + reconciler test file (Part 2).
- TS: hook tests to wake+get/ack model; index.test.ts revision 16.
- No hollow stubs — test BODIES are diffed at adjudication.

## Done criteria

- Both slots gone, handoff chain gone, per-operation model live end-to-end from both
  hooks; revision 16 both sides; C/D byte-identical except the spec note;
  `pnpm run typecheck`, `pnpm run lint:mobile`, module unit tests green; tree clean.

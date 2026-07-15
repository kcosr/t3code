# W0a — Remove Dead Voice Runtime Code

Milestone W0a of `specs/voice-kernel-orchestration.md`. Pure deletion; zero behavior change.

## Context

You are working in a git checkout already on the correct branch. Commit your work here with
ordinary git commits; do not push, do not create branches. The Android/Kotlin toolchain
(gradle, ktlint, detekt) is NOT available on this host — do not attempt gradle or any
Android build. Verification on this host is limited to the commands listed under
Verification.

## Scope — three deletion areas

### 1. Orphaned handoff executor (two files)

**Delete symbol-by-symbol, never by line range.** The dead functions are interleaved with
live functions in the same region of the file; deleting a contiguous range WILL break
compilation.

In `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/T3VoiceRuntimeService.kt`,
delete exactly these seven symbols:

- `executeRealtimeHandoff` (lines ~5515-5565) — zero callers repo-wide.
- `executeRealtimeHandoffLocked` (~5574-5657) — sole caller is `executeRealtimeHandoff`.
- `abortRealtimeHandoffRealtimeLocked` (~5659) — only callers are the two above.
- `continueRealtimeHandoffAfterDrainLocked` (~5666-5714) — only callers are inside
  `executeRealtimeHandoffLocked`.
- `emitThreadVoiceHandoff` (~5738-5775) — only callers are the functions above.
- Private const `HANDOFF_COMMAND_TIMEOUT_MILLIS` (~6311) — only use is in
  `executeRealtimeHandoff`.
- The function-local `completed` CountDownLatch (~5516) and `completionLock` monitor
  (~5517) disappear with `executeRealtimeHandoff` — no separate step.

These functions sit in the SAME region and are LIVE — they MUST be preserved untouched:
`clearHandoffEligibilityLocked` (~5567, called at ~5455),
`cancelRealtimeHandoffRecordingLocked` (~5716), `discardRealtimeHandoffRecordingLocked`
(~5726, called at ~704/~755/~2522), `isThreadVoiceHandoffProtected` (~5777),
`expireThreadVoiceHandoffLocked` (~5781, called at ~702/~721/~739).

In `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/VoiceRuntimeControl.kt`,
delete as a unit (they reference each other and are dead only together, since their only
consumers are the service functions deleted above):

- `VoiceRealtimeHandoffAction` (~148-156)
- `VoiceRealtimeHandoffOutcome` (~158-161)
- `VoiceRealtimeHandoffPolicy` (~163-168)

Verify each symbol's zero-caller status by grep BEFORE deleting it, and re-grep each name
AFTER deleting to confirm zero remaining references.

### 2. `setReadinessSnapshotAsync` bridge function (no JS callers)

- Expo `AsyncFunction("setReadinessSnapshotAsync")` in
  `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/T3VoiceModule.kt`
  (~line 566).
- The `VoiceBinder.setReadinessSnapshot` binder method in `T3VoiceRuntimeService.kt`
  (~line 194 region) — delete ONLY the binder entry point and any parsing/validation helper
  used solely by it. The readiness store and every internal readiness write path it shares
  must remain untouched.
- The corresponding method signature and input types in
  `apps/mobile/modules/t3-voice/src/T3Voice.types.ts` — remove the function from the module
  interface; remove input/result types only if nothing else references them.

### 3. Bluetooth permission bridge functions (no JS callers)

- `AsyncFunction("getBluetoothPermissionAsync")` (~line 677) and
  `AsyncFunction("requestBluetoothPermissionAsync")` (~line 685) in `T3VoiceModule.kt`,
  plus any binder methods or permission helpers used solely by them.
- Their entries and types in `T3Voice.types.ts`, same only-if-unreferenced rule.
- Do NOT touch `AndroidManifest.xml` — `BLUETOOTH_CONNECT` stays; the audio router still
  uses the permission at runtime when it is already granted. Do NOT touch the microphone or
  notification permission functions.

## Forbidden

- Any change other than the deletions above and the minimal test/type fallout they force.
- Refactoring, renaming, reformatting of surrounding code, or import reordering beyond what
  the deletions require.
- Bumping `nativeRevision` (in `T3VoiceModule.kt` Constants and
  `apps/mobile/modules/t3-voice/src/index.ts`) — deleting never-called functions is not a
  contract change.
- Touching `AndroidManifest.xml`, any readiness/authority store logic, or any file outside
  `apps/mobile/modules/t3-voice/`.
- Weakening or broadening any test assertion. Tests that reference deleted symbols are
  updated by deleting those references only.

## Verification (run all; all must pass)

1. Caller proofs before deleting, recorded in the commit message:
   - `grep -rn "executeRealtimeHandoff" apps/mobile` → only the definitions being deleted.
   - `grep -rn "setReadinessSnapshotAsync\|getBluetoothPermissionAsync\|requestBluetoothPermissionAsync" apps/mobile packages` →
     only the module definition, binder, and type entries being deleted (no callers in
     `apps/mobile/src`, `packages/`).
2. After deleting, zero remaining references (excluding `specs/` docs):
   `grep -rn "executeRealtimeHandoff\|abortRealtimeHandoffRealtimeLocked\|continueRealtimeHandoffAfterDrainLocked\|emitThreadVoiceHandoff\|HANDOFF_COMMAND_TIMEOUT_MILLIS\|VoiceRealtimeHandoffAction\|VoiceRealtimeHandoffOutcome\|VoiceRealtimeHandoffPolicy" apps/mobile packages`
   returns nothing, and
   `grep -rn "setReadinessSnapshot\|getBluetoothPermission\|requestBluetoothPermission" apps/mobile packages`
   returns nothing except internal readiness-snapshot reads that were explicitly kept —
   list any survivors in the commit message with one-line justification.
3. `pnpm run typecheck` — passes.
4. `pnpm run lint:mobile` — passes.
5. `pnpm --filter @t3tools/mobile test` — passes. Note: the module's `index.test.ts` only
   covers native-module resolution by `nativeRevision` and does not exercise the deleted
   functions; it must stay green (do not change `nativeRevision`).

## Done criteria

- One commit (or two: Kotlin deletion, TS types/tests) with conventional-commit subject
  `chore(voice): remove dead voice runtime code`, body containing the caller-proof greps and
  a deletion inventory (symbol → file → why dead).
- Working tree clean; no untracked files introduced.
- Line counts only go down in every touched file.

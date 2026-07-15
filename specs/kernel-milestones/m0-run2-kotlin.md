# M0 Run 2 — Kotlin Native Runtime onto Session Auth

Second and final run delivering `specs/voice-auth-unification.md` (authoritative design —
READ IT FIRST, including the Review correspondence section, which records the adjudicated
deviations from run 1). Run 1 (`f1b2fc75d`, `5bcfb8c41`, `de429079e`) already moved the
server, contracts, and every TypeScript surface onto session auth. This run cuts over the
Kotlin native runtime and completes the vertical.

## Authoritative wire shapes

The server and contracts on this branch ARE the truth. Before writing any Kotlin, read the
run-1 commits (`git show f1b2fc75d`, focusing on `realtimeControlHttp.ts`,
`threadTurnHttp.ts`, `voice/http.ts`, `packages/contracts/src/voiceRuntime.ts`) for the
exact request/response shapes: session auth via `Authorization: Bearer <token>`, target in
create bodies, `canonicalFence` fields unchanged, protocol-major header now `2`, no
`x-t3-voice-*` auth headers anywhere. Do not guess shapes from the spec prose when the
committed TypeScript disagrees — the TypeScript wins.

## Context

The Kotlin toolchain is NOT available on this host — you cannot compile. Mitigate by
mirroring existing module idioms exactly, re-reading every seam you touch, and keeping the
change mechanical. Tests compile/run later on another host; expect a follow-up fix round
from that gate.

## Scope — all inside `apps/mobile/modules/t3-voice/`

### 1. Session credential accessor (native half; TS half exists)

Run 1 already added the bridge type and the provisioning call
(`setVoiceRuntimeSessionCredentialAsync` — see `T3Voice.types.ts` and
`nativeVoiceRuntimeProvisioning.ts` on this branch). Implement the native side:

- Module `AsyncFunction` + binder method receiving the bearer token and environment origin;
  a clear counterpart clears it.
- Persist the copy with the module's EXISTING Keystore cipher plumbing
  (`T3VoiceRuntimeGrantCipher` / `T3VoiceAndroidKeystoreGrantCipher` in
  `VoiceRuntimeStorage.kt`) in a small dedicated store — token ciphertext, origin as
  authenticated metadata. No rotation, no expiry fields, no hashes.
- Never read expo-secure-store's storage; the React side supplies and refreshes the copy.

### 2. Header cutover

- `VoiceRuntimeHttp.kt`: requests attach `Authorization: Bearer <token>` from the accessor.
  REWORK the `VoiceRuntimeAuthority` token validation — the `length <= 128` /
  no-whitespace checks (~line 90) were sized for grant digests and reject bearer tokens;
  the credential accessor replaces that abstraction rather than re-pointing it. Protocol
  major constant `"1"` → `"2"` (~lines 271, 400).
- `VoiceRuntimeRealtime.kt`, `VoiceRuntimeThreadTurn.kt`, `VoiceRuntimeControl.kt`: remove
  the `x-t3-voice-runtime` / `x-t3-voice-control` / `x-t3-voice-operation` /
  `x-t3-voice-transition` header attachment and the per-call grant-token parameters they
  threaded; calls authenticate via the shared credential. Fence fields keep traveling in
  bodies/queries exactly as today.

### 3. Refresh subsystem deletion

- Delete `VoiceRuntimeAuthorityRefresh.kt`, `VoiceRuntimeAuthorityRefreshWorker.kt`
  (worker + scheduler), their WorkManager wiring, and the
  `ACTION_AUTHORITY_REFRESH_PENDING/REFRESHED/REFRESH_REJECTED` intent constants plus their
  `onStartCommand` handlers and `reconcileRefreshedAuthorityLocked` /
  `reconcileRejectedAuthorityLocked` service paths.
- Delete the refresh-admission policies in `T3VoiceReadiness.kt`
  (`T3VoiceAuthorityRefreshAdmissionPolicy` and the disabled-refresh-recovery paths) and
  the `scheduleDisabledRefreshRecoveryLocked` startup step.

### 4. Authority store shrink

`VoiceRuntimeAuthorityStore.kt`: remove the prepared-refresh-credential and rotation
halves (refresh begin/promote/reject, rotation counters, disabled-recovery variants). What
remains: the persisted target/generation/readiness record (tokenless — the credential now
lives in the accessor store), prepare/activate/clear lifecycle, `Locked` fail-closed
behavior, and legacy retirement. Startup fence resolution
(`T3VoiceStartupAuthorityFencePolicy`) loses its refresh-credential and prepared-rotation
inputs; simplify its inputs accordingly, preserving the discard/commit decision semantics
for what remains.

### 5. Revision + protocol

- `nativeRevision` 14 → 15 in `T3VoiceModule.kt` Constants AND `NATIVE_REVISION` in
  `apps/mobile/modules/t3-voice/src/index.ts` AND the resolution test's expected value.
- The TS bridge surface needs no other changes (run 1 already reshaped it).

### 6. Tests

Rewrite/delete Kotlin tests pinned to the deleted machinery: delete
`VoiceRuntimeAuthorityRefreshTest`; strip rotation/refresh cases from
`VoiceRuntimeAuthorityStoreTest` (keep persistence/tamper/lifecycle cases, adjusted to the
shrunk record); update header assertions in `VoiceRuntimeRealtimeTest` /
`VoiceRuntimeThreadTurnTest` / `VoiceRuntimeHttpTest` to Authorization-bearer + protocol
major 2; strip refresh-admission cases from readiness policy tests; add credential-accessor
store tests (set/clear/persist-across-restart/tamper→Locked) mirroring the existing store
test idioms (JUnit4 only, hand-written fakes, per-file fake conventions).

## Forbidden

- Touching any TypeScript besides the `nativeRevision` constant and its test.
- Touching server or contracts (run 1 finished them).
- Any bridge-surface change beyond the credential accessor functions (M5 owns the rest).
- New dependencies, `build.gradle` changes, mocking frameworks, Android imports in tests.
- Keeping any deleted mechanism as a stub, alias, or commented block (hard-removal rule).

## Verification (all possible on this host)

1. `grep -rn "x-t3-voice-runtime\|x-t3-voice-control\|x-t3-voice-operation\|x-t3-voice-transition\|x-t3-voice-refresh" apps/mobile/modules/t3-voice/android` →
   only the protocol-major header remains (substring caveat: `x-t3-voice-runtime-protocol-major` stays).
2. `grep -rn "AuthorityRefresh\|refreshRotation\|rotationCounter\|prepared.*[Rr]efresh" apps/mobile/modules/t3-voice/android/src` → zero.
3. `grep -rn "\"2\"" apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/VoiceRuntimeHttp.kt` shows the protocol major; no `"1"` protocol remnants.
4. `pnpm run typecheck` and `pnpm run lint:mobile` — green.
5. Self-review read-twice on every touched seam (no compile available).
6. Commit message: deletion inventory (symbol → file), header cutover table, and the
   read-run-1-commit shapes you matched against.

## Done criteria

- Commits present, tree clean, subject `feat(voice): move native runtime onto session auth`.
- After this run: pc gate (module tests), then the M0 device gate (background thread-turn
  with React dead on bearer only; revoke → `paused(reason=authority)` + media release;
  pause survives service restart; re-pair + credential re-supply resumes), then
  merge-forward and supersession edits — all orchestrator-owned, not this run.

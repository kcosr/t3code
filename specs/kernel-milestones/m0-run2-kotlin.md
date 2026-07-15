# M0 Run 2 — Kotlin Native Runtime onto Session Auth

Second and final run delivering `specs/voice-auth-unification.md` (authoritative design —
READ IT FIRST, including Review correspondence). Run 1 (`f1b2fc75d`, `5bcfb8c41`,
`de429079e`) moved the server, contracts, and every TypeScript surface onto session auth.
This run cuts over the Kotlin native runtime and completes the vertical.

## Authoritative wire shapes

The committed TypeScript on this branch IS the truth. Before writing Kotlin, read
`git show f1b2fc75d` for `realtimeControlHttp.ts`, `threadTurnHttp.ts`, `voice/http.ts`,
and `packages/contracts/src/voiceRuntime.ts`: session auth via `Authorization: Bearer`,
target in create bodies, `canonicalFence` unchanged, protocol-major header `"2"`, tokenless
7-field authority reservation, tokenless handoff reservation. When spec prose and committed
TypeScript disagree, the TypeScript wins.

## Context

No Kotlin toolchain on this host — you cannot compile. Mirror existing module idioms
exactly; re-read every seam twice; expect a fix round from the later compile/test gate.

## Scope — all inside `apps/mobile/modules/t3-voice/` (+ the two TS revision constants)

### 1. Session credential accessor (native half; TS half exists)

Run 1 added `setVoiceRuntimeSessionCredentialAsync({environmentOrigin, credential})`
(`T3Voice.types.ts:443`) and its caller (`nativeVoiceRuntimeProvisioning.ts:64`). Implement
the native side:

- Module `AsyncFunction` + binder method storing the bearer token + origin.
- Persist with the module's EXISTING Keystore cipher plumbing (`VoiceRuntimeStorage.kt`):
  token ciphertext, origin as authenticated metadata. No rotation, expiry, or hash fields.
- Clearing is NATIVE-INTERNAL only (store clear on legacy retirement / readiness disable);
  there is no JS-wired clear function — JS overwrites by calling set again.
- Credential injection: the service reads this store and supplies the bearer to the HTTP
  delegates at the same call-construction sites where per-call grant tokens are threaded
  today. Delegates take one credential value in place of their current
  `controlToken`/`runtimeGrantToken`/`operationGrantToken` parameters.

### 2. Authority ingestion cutover (CRITICAL — currently hard-throwing)

Run 1 shrank the JS→native configure payload to seven tokenless fields
(`VoiceRuntimeAuthorityReservation`, `voiceRuntime.ts:303-322`), but native
`VoiceRuntimeBridge.parseAuthority` (`VoiceRuntimeBridge.kt:69-116`) enforces exact key-set
equality including `token`, `refreshRotationCounter`, `issuedAt`, `expiresAt`, `operation`
— so `configureVoiceRuntimeAuthorityAsync` throws on every call on this branch. Fix as
core scope:

- `parseAuthority` + `ParsedAuthority` (`VoiceRuntimeBridge.kt:7-14`): accept exactly the
  run-1 seven-field shape; discriminate the target from the payload's own union (no
  `operation` string); re-derive `targetDigest` natively (the derivation already exists at
  the old prepare path, service ~:1037-1041 — reuse it).
- Native `VoiceRuntimeAuthorityReservation` (`VoiceRuntimeAuthority.kt:3-11`): drop
  `issuedAt`/`expiresAt` (and their CAS/filter uses at `:48-52`, `:60`) and the token.
- `T3VoiceRuntimeService.configureVoiceRuntimeAuthority` (~:914-926) and
  `VoiceRuntimeRealtimeAuthority` construction (`VoiceRuntimeRealtimeEngine.kt:3`,
  ~:933-939): tokenless; realtime engine authority carries identity/generation/target
  only, credential comes from the accessor at request time.
- **`provisioningOperationId` decision (do not improvise differently):** JS no longer
  sends one. Drop it from the persisted record and RE-KEY the configure idempotency
  ledger on `(generation, targetDigest)`: replaying a configure with the same generation
  and target returns the stored outcome; same generation with a different target is a
  conflict. This mirrors the server-side CAS semantics exactly.

### 3. JS-facing prepare path deletion

Run 1 removed `prepareVoiceRuntimeAuthorityAsync` from the TS interface and its JS caller
(reserve() now configures directly). Delete the dead native path: the module
`AsyncFunction` (`T3VoiceModule.kt:287`), its binder method, and
`T3VoiceRuntimeService.prepareVoiceRuntimeAuthority` (~:1026-1170) — it references store
methods deleted below and cannot survive. RETAIN `inspectPreparedAttachedAuthority` and the
startup attached-preparation read (it is not refresh machinery; it simply reads absent
going forward — full retirement belongs to M6 recovery rework; note this in the commit).

### 4. Header cutover

- `VoiceRuntimeHttp.kt`: attach `Authorization: Bearer <token>` (attach site ~:273).
  REWORK the `VoiceRuntimeAuthority` header abstraction — the `length <= 128` /
  no-whitespace validation (~:90) rejects bearer values; the credential accessor replaces
  it. Protocol constant `"1"` → `"2"` at ~:271 and ~:400.
- `VoiceRuntimeRealtime.kt` (~:946-948), `VoiceRuntimeThreadTurn.kt` (~:967-968): remove
  RUNTIME/CONTROL/TRANSITION/OPERATION header constants and attachment; fence fields keep
  traveling in bodies/queries unchanged.
- `VoiceRuntimeControl.kt` is NOT a simple header swap: its heartbeat transport sets
  `x-t3-voice-control` directly (`:172`) and `VoiceRuntimeControlGrant` (`:16-23`) mixes
  one auth field (`token` — dies) with lifecycle fields that SURVIVE (`sessionId`,
  `leaseGeneration`, `heartbeatIntervalMillis`, `failureGraceMillis`). The local
  `expiresAtEpochMillis`-driven termination (~:305, :336) dies with the grant: under
  session auth there is no control expiry — heartbeat termination comes from server
  responses (SESSION_ENDED / CONTROL_REJECTED on 401/403), which already exist. The
  transport takes the bearer from the accessor.
- Handoff wire alignment: run 1 made the transition reservation tokenless
  (`voiceRuntime.ts` handoff-exchange result carries no grant token). Native
  `exchangeHandoff` response decode drops the transition token field and `commitHandoff`
  (`VoiceRuntimeRealtime.kt:844-857`) sends no transition header — commit is authorized by
  session + fence like every other route. Handoff must remain a working flow after this
  run.
- `VoiceRuntimeBridge.descriptorBody()` `protocolMajor` `1` → `2` (`VoiceRuntimeBridge.kt:52`).

### 5. Refresh subsystem deletion (full cascade)

- Files: `VoiceRuntimeAuthorityRefresh.kt`, `VoiceRuntimeAuthorityRefreshWorker.kt`
  (worker + scheduler object). No manifest wiring exists. `androidx.work` remains in
  build.gradle as dead weight — leave it (no build.gradle changes) and note it.
- Service: `ACTION_AUTHORITY_REFRESH_*` constants (~:6046-6050), their `onStartCommand`
  arms (~:2434-2439), `reconcileRefreshedAuthorityLocked` (~:5250),
  `reconcileRejectedAuthorityLocked` (~:5303), `scheduleDisabledRefreshRecoveryLocked`
  (~:5791) and its call sites (~:2327, :5714, :5782).
- Policies: `T3VoiceAuthorityRefreshAdmissionPolicy` (`T3VoiceReadiness.kt:202`).
- Orphan cascade (delete-and-grep, hard-removal rule):
  `VoiceRuntimeActiveThreadController.refreshAuthority` (:248, sole caller deleted) and
  `VoiceRuntimeAuthorityRegistry.refresh` (`VoiceRuntimeAuthority.kt:70-83`, sole caller
  is the former).

### 6. Authority store shrink (`VoiceRuntimeAuthorityStore.kt`) — precise residue

DELETE: the refresh-credential family `beginRefresh` (:332), `resumeDisabledRefresh`
(:371), `promoteRefresh` (:431), `promoteDisabledRefresh` (:475), `hasPendingRefresh`
(:503), `rejectRefresh` (:506), `rejectDisabledRefresh` (:518), `isRefreshRejected` (:532),
`loadForRefresh` (:585), `loadRejectedAuthority` (:589), `prepareRefreshCredential`,
`inspectPreparedRefreshCredential`, rotation counters, and — from
`VoiceRuntimePersistedAuthority` (:17-29) — `token`, `issuedAtEpochMillis`,
`expiresAtEpochMillis`, `refreshRotationCounter`, `provisioningOperationId` (re-keyed per
section 2). `targetDigest` STAYS (natively derived; consumed by committed-readiness
reconcile at ~:974/:986 and the startup cross-check).

RETAIN (do not touch beyond mechanical fallout): `Locked`/`Missing`/`Available` load
results and tamper fail-closed; `retireLegacyV2` (:554); the ENTIRE prepared-TRANSITION
family `prepareTransition`/`activatePreparedTransition`/`discardPreparedTransition`/
`inspectPreparedTransition` (:262-331, `PREPARED_TRANSITION_PREFIX`) — this is the
realtime→thread handoff two-phase commit, NOT refresh machinery; the prefix families are
the tell (`PREPARED_TRANSITION_` stays; refresh `PREPARED_`/`CANDIDATE_`/`CURRENT_`
credential entries go).

REWORK: `load()` (:539-549) keeps tamper→Locked but drops its `isRefreshRejected` (:543)
and expiry (:546) gates; `activate()` (:211-260) stops reading/writing credential
ciphertexts (currently a credential-promotion step) and just persists the tokenless
record; `disableReadiness` (:396-428) is RETAINED-BUT-REWORKED — strip
`preserveRefreshRecovery` and the token encryption, keep the runtimeId/generation-fenced
`readinessEnabled=false` write. This method backs the device gate's revoke→paused
behavior; it must keep working.

Startup fence resolution (`T3VoiceStartupAuthorityFencePolicy`, `T3VoiceReadiness.kt:100`;
service ~:1920-1977): drop `startupPreparedRefresh`/`startupPreparedRefreshResult` and the
refresh cross-checks (:109-117, service :1956/:1959) and the refresh fence in
`selectRuntimeId` (:1974). Retained inputs: persistent readiness, attached preparation,
recovered fences. `selectPreparation`/`resolve` discard/commit semantics unchanged.

### 7. Revision

`nativeRevision` 14 → 15: `T3VoiceModule.kt:216`, `index.ts:48` (`NATIVE_REVISION`),
`index.test.ts:27`. No other TS changes.

### 8. Tests

Delete `VoiceRuntimeAuthorityRefreshTest`. Strip rotation/refresh/expiry cases from
`VoiceRuntimeAuthorityStoreTest` (keep persistence/tamper/lifecycle/transition cases,
adjusted to the shrunk record). Update header assertions in `VoiceRuntimeRealtimeTest` /
`VoiceRuntimeThreadTurnTest` / `VoiceRuntimeHttpTest` to bearer + protocol 2 + tokenless
handoff decode. Strip refresh-admission cases from readiness policy tests. Add
credential-accessor store tests (set/overwrite/persist-across-restart/tamper→Locked) and
configure-idempotency re-key tests ((generation,target) replay → stored outcome;
same-generation-different-target → conflict), mirroring existing idioms (JUnit4 only,
per-file fakes).

## Forbidden

- Touching TypeScript beyond the two revision constants and the revision test value.
- Touching server or contracts.
- Any bridge-surface change beyond the credential accessor set function (M5 owns the
  legacy pending/ack surface; the authority-configure and prepare changes above are
  EXEMPT from this rule — they are this run's core).
- Deleting or altering the prepared-TRANSITION family or `T3VoiceControllerCommands` /
  readiness reservation generations (live non-refresh flows).
- New dependencies, build.gradle changes, mocking frameworks, Android imports in tests.
- Stubs, aliases, commented-out remnants (hard-removal rule).

## Verification

1. `grep -rn "x-t3-voice-" apps/mobile/modules/t3-voice/android/src` → ONLY
   `x-t3-voice-runtime-protocol-major` remains.
2. `grep -rniE "\brefresh" apps/mobile/modules/t3-voice/android/src` → empty allowlist:
   every remaining match must be listed in the commit message with a one-line reason
   (expected: none).
3. `grep -rn "protocolMajor\|protocol-major\|PROTOCOL_MAJOR" apps/mobile/modules/t3-voice/android/src`
   → every site advertises/sends 2; no `"1"` remnants in those contexts.
4. `grep -rn "provisioningOperationId\|targetDigest" apps/mobile/modules/t3-voice` →
   `targetDigest` only in native derivation/reconcile sites; `provisioningOperationId`
   zero.
5. `pnpm run typecheck` and `pnpm run lint:mobile` — green.
6. Self-review read-twice on every touched seam; commit message carries the deletion
   inventory, the header cutover table, the idempotency re-key note, and the run-1 commits
   consulted for wire shapes.

## Done criteria

- Commits present, tree clean, subject `feat(voice): move native runtime onto session auth`.
- After this run (orchestrator-owned, not yours): pc gate → M0 device gate (background
  thread-turn on bearer with React dead; revoke → `paused(reason=authority)` + media
  release; pause survives service restart; re-pair + credential re-supply resumes) →
  merge-forward + supersession edits.

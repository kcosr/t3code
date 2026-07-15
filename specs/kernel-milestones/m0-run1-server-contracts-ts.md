# M0 Run 1 — Server, Contracts, and TypeScript Clients onto Session Auth

First of two sequenced runs delivering `specs/voice-auth-unification.md` (READ IT FIRST —
it is the authoritative design; this packet adds only execution sequencing and boundaries).
Run 2 cuts over the Kotlin native runtime. The M0 branch lands as one vertical cutover;
between run 1 and run 2 the Kotlin runtime intentionally still sends the old headers and is
runtime-incompatible with this server — that is expected mid-branch state, gated from
shipping by the branch boundary and the protocol-major bump.

## Scope of THIS run

Every TypeScript surface, coherently:

1. **Server route auth** (`apps/server/src/voice/`): raw runtime routes
   (`realtimeControlHttp.ts`, `threadTurnHttp.ts`) and media routes (`http.ts`) switch to
   `authenticateRawRouteWithScope(AuthVoiceUseScope)`; custom token headers removed;
   ownership checks per the spec's Route auth section, including the close-only lifecycle
   flag on the retained lease/binding record and the two-level thread-turn ownership check.
2. **Grant surface deletion** (`controlHttp.ts` + services + persistence): both grant
   registries, media tickets, the refresh endpoint, per the spec's Deletion inventory —
   including `VoiceSessionService.ts` (18 `VoiceRuntimeControlGrantRegistry` call sites;
   `createSession` stops issuing `runtimeControlGrant`; revoke/complete/release paths map
   onto the close-only lifecycle flag) and `runtimeLayer.ts` (drop the six deleted
   layer/registry wirings). Forward drop-migrations as NEW migration files (existing
   032-055 immutable; new files are 056+ in `apps/server/src/persistence/Migrations/`),
   and REGISTER each new migration in `apps/server/src/persistence/Migrations.ts`
   (import + `[id, name, migration]` array entry) — an unregistered migration silently
   never runs. `VoiceRuntimeRealtimeStarts` SURVIVES; its purges re-home per the spec's
   cascade section. The transition-grants table is ALTERED to the tokenless reservation,
   not dropped.
3. **Slim authority record + reservation**: tokenless authority CAS; handoff reservation
   with the atomic consume+CAS transaction and `sourceLeaseGeneration` commit fence, per
   the spec's Handoff exactly-once section — mirror the existing `transition` transaction's
   atomicity exactly.
4. **Both cascades** (auth-session revocation; target replacement/clear) per the spec,
   including cancel-pre-dispatch/detach-post-dispatch and realtime-starts purges.
5. **Contracts** (`packages/contracts/src/voiceRuntime.ts`, `voice.ts`, `baseSchemas.ts`,
   `environmentHttp.ts`): delete grant/ticket schemas and endpoints — explicitly including
   `VoiceRuntimeControlGrant` (voice.ts:271), `VoiceThreadTurnCreateResult.operationGrant`
   (voice.ts:325), `VoiceSessionCreateResult.runtimeControlGrant` (voice.ts:433-440),
   `VoiceMediaTicket`/`Request`/`Operation` (voice.ts:799-820), and `VoiceMediaTicketId`
   (baseSchemas.ts:113); `VOICE_RUNTIME_PROTOCOL_MAJOR` 1 → 2. Command
   fence/snapshot/lease/journal/event schemas untouched (wire shapes; the server-side
   record change is internal).
6. **TS clients**: `packages/client-runtime/src/voice/client.ts` (drop grant/ticket
   methods + ticket header injection), `runtime.ts`/`fakeRuntime.ts`/`runtimeConformance.ts`
   (`configureAuthority` carries target + expected generation, no token),
   `apps/mobile/src/features/voice/nativeVoiceRuntimeProvisioning.ts` (shrinks to
   configure-target + shared-credential currency), `useThreadSpeech.ts` /
   `useComposerDictation.ts` (drop ticket acquisition; their requests already carry session
   auth), `mobileVoiceClient.ts` (bearer path primary),
   `apps/mobile/src/features/voice/realtimeVoiceController.ts` (drop the
   `runtimeControlGrant` read/pass at :397-405), and the native bridge TYPE surface
   `apps/mobile/modules/t3-voice/src/T3Voice.types.ts` (remove
   `T3VoiceRealtimePrepareInput.runtimeControlGrant`, a required field, plus any `index.ts`
   re-exports) — these bridge TYPE edits are unavoidable in run 1 for `apps/mobile`
   typecheck to stay green once the contract fields die.
7. **Server + contracts + client tests**: rewrite/delete tests pinned to grant/ticket wire
   shapes; add the spec's Verification items that are server-side (session-authenticated
   full cycles, scope denial, fence rejection, handoff exactly-once under redelivery and
   crash-between-exchange-and-commit, both cascades, media session-only). Named fallout the
   generic instruction must not miss: `apps/server/src/server.test.ts` contains a full
   grant provision/refresh integration block (~lines 3300-3400, testing
   `refreshRotationCounter`/`refreshCredentialHash`) — delete/rewrite it, but the adjacent
   `/api/auth/websocket-ticket` tests are UNRELATED and stay; `apps/server/src/httpCors.ts`
   and `packages/shared/src/httpObservability.ts` hardcode the `x-t3-voice-*` header names
   as string literals and `httpObservability.test.ts` asserts their presence — all three
   must be updated, making `packages/shared` a touched package whose suite must pass.

## Explicitly OUT of this run

- Any Kotlin file (`apps/mobile/modules/t3-voice/android/**`) — run 2.
- The `nativeRevision` NUMBER bump (`index.ts` NATIVE_REVISION and the Kotlin constant) —
  run 2. Note this deferral covers only the number: the bridge TYPE edits in
  `T3Voice.types.ts` happen in THIS run (see item 6); the revision gate line itself
  references no contract symbol and stays green.
- Docs supersession edits to other specs — orchestrator handles after M0 lands.

## Hard constraints

- No alias routes, no dual-shape parsers, no compatibility fallbacks (repo migration rule).
- Effect-style and idioms: match the surrounding Effect-TS service/layer patterns; new
  persistence goes through the existing migration + layer conventions.
- The TS world must be fully coherent at the end of this run: `pnpm run typecheck` green,
  all touched package test suites green. Test commands are uniform: `vp test run` from each
  package directory (`apps/server`, `packages/contracts`, `packages/client-runtime`,
  `packages/shared`, `apps/mobile`); the root gate is `pnpm run typecheck`. Record which
  you ran in the commit messages.
- Multiple commits are fine (server core / contracts / clients / tests); each commit
  message states what moved and why in the spec's terms.
- If the spec is ambiguous or wrong against the code you find, STOP that item, implement
  the rest, and report the discrepancy in your final summary rather than improvising a
  design decision.

## Verification

1. `pnpm run typecheck` — green.
2. Touched-package test suites — green; commands recorded.
3. `grep -rn "x-t3-voice-runtime\|x-t3-voice-control\|x-t3-voice-operation\|x-t3-voice-transition\|x-t3-voice-refresh\|x-t3-voice-ticket" apps/server packages apps/mobile/src apps/mobile/modules/t3-voice/src` → zero matches (Kotlin files under `android/` keep theirs until run 2).
4. `grep -rn "provisionVoiceRuntimeGrant\|revokeVoiceRuntimeGrant\|refreshVoiceRuntimeGrant\|createMediaTicket\|VoiceRuntimeGrantRegistry\|VoiceRuntimeControlGrantRegistry\|VoiceMediaTicketRegistry\|VoiceRuntimeControlGrant\|VoiceMediaTicket\|operationGrant\|runtimeControlGrant\|refreshRotationCounter\|refreshCredentialHash\|VoiceRuntimeCredentialHash" apps/server packages apps/mobile/src apps/mobile/modules/t3-voice/src` → zero matches outside immutable migration files (032-055) and specs/.
5. `VOICE_RUNTIME_PROTOCOL_MAJOR` is 2 everywhere TS references it; the Kotlin hardcoded
   "1" (VoiceRuntimeHttp.kt) is intentionally untouched this run.
6. `vp check` — no NEW errors versus the branch base (pre-existing warnings tolerated).

## Done criteria

- Working tree clean; commits present; every verification item recorded.
- Final summary lists: files deleted (with LOC), migrations added, any spec discrepancies
  found, and the exact test commands run.

# Voice Auth Unification (M0)

Status: Draft for review. Precedes the kernel rework
(`specs/native-voice-runtime-kernel.md`; execution order in
`specs/voice-kernel-orchestration.md`). Supersedes the grant/refresh/rotation and media
ticket sections of `specs/native-voice-runtime-ownership.md` and the media ticket section of
`docs/architecture/voice.md` once accepted.

## Decision

There is exactly one client identity per device: the pairing state. The Android native voice
runtime authenticates to the T3 server as the paired client itself — attaching the same
stored session credential React uses — and every voice runtime and media
endpoint authenticates with standard session auth plus the `voice:use` scope. The parallel
voice credential system (runtime grants, control grants, per-operation tokens, transition
grant tokens, media tickets, refresh rotation) is deleted, not re-derived.

What the deleted machinery carried that is not authentication survives as plain data:

- the voice **target** (conversation or project/thread plus policies) moves into request
  bodies, validated server-side exactly as grant provisioning validates it today;
- **runtime authority generation** (which device owns voice for which target) survives as a
  tokenless server-side authority record plus the existing lease-generation fencing whose
  inputs already travel in every request;
- **exactly-once handoff activation** survives as an idempotent reservation row rather than
  a one-use HMAC token.

## Rationale (decision record)

- The native service and React run in one app: same UID, same sandbox, same Keystore
  namespace. A credential boundary between them is not enforceable by the platform; the
  grant system was a second identity for the same trust domain.
- The residual benefit of the derived credentials was scope minimization for a compromised
  native process (realistically: the WebRTC library). This is explicitly accepted as lost:
  the full client credential is readable from the same sandbox regardless, so the
  minimization never held against the threat it named. T3 deployments in scope are
  single-user environments where the operator owns both endpoints.
- Provider credentials are unaffected: the OpenAI key remains server-side in
  `ServerSecretStore`; nothing in this change moves any provider secret toward a client.
- The background-execution problem the refresh-rotation subsystem solved disappears with the
  right session method: paired bearer-token sessions default to a 30-day TTL
  (`SessionStore.ts` `DEFAULT_SESSION_TTL`; the bearer path of
  `exchangeBootstrapCredentialForAccessToken` passes no TTL). The durable credential IS the
  bearer session token — the bearer client performs no ongoing token exchange
  (`authorizeBearer` attaches the stored token directly), so there is nothing for native to
  refresh. Only DPoP access tokens are capped at one hour; see Credential model.

## Credential model

- The app holds one shared credential in Keystore-backed app storage readable by both React
  and the native service: the durable bearer session token
  (`SavedRemoteConnection.bearerToken` — the credential the paired client already persists).
- The native runtime attaches that token (`Authorization: Bearer ...`) to its server calls.
  There is no native-side refresh because none exists to mirror: the bearer path performs no
  token exchange (`authorizeBearer` attaches the stored token directly; the pairing one-time
  token is consumed at pairing and is not reusable). On bearer expiry (30-day session TTL)
  the affected mode enters `paused(reason=authority)` until the user re-pairs from React —
  accepted for single-user local deployments.
- Environments using DPoP are explicitly deferred: DPoP access tokens are one-hour and DO
  require the `/oauth/token` exchange plus the DPoP signing key and a reusable relay
  bootstrap credential. Supporting native DPoP means sharing that key and exchange flow with
  the service process — follow-up hardening, not part of M0. The deployment in scope pairs
  with bearer sessions.
- Nothing voice-specific is minted, hashed, rotated, or refreshed. `voice:use` is already in
  `AuthStandardClientScopes`; no scope changes.

## Server changes

### Route auth

- The raw runtime routes (`realtimeControlHttp.ts`, `threadTurnHttp.ts`) and media routes
  (`voice/http.ts`) adopt `authenticateRawRouteWithScope(AuthVoiceUseScope)` — the primitive
  the media routes already use as their session fallback. The custom headers
  `x-t3-voice-runtime`, `x-t3-voice-control`, `x-t3-voice-operation`,
  `x-t3-voice-transition`, `x-t3-voice-refresh`, and `x-t3-voice-ticket` are removed.
- Authorization beyond authentication becomes ownership checks against server state:
  - realtime child routes: the authenticated session must be the session that created the
    voice session, and the request's fence fields (`runtimeId`, `runtimeInstanceId`,
    `generation`, `leaseGeneration`, `modeSessionId`) — which already travel in every
    request body/query (`canonicalFence`) — are validated against the stored lease exactly
    as the control grant cross-checked them;
  - **close-only lifecycle flag**: after a voice session's bound generation is superseded
    (handoff consumed or target replaced), the ownership check admits ONLY `close` for that
    `voiceSessionId` and rejects every other child route, independent of the request's
    generation. This is an explicit per-session lifecycle flag on the retained lease/binding
    record — it cannot be derived from fence-vs-current-authority comparison, which either
    leaks non-close operations through the cached binding or wrongly rejects a legitimate
    close carrying the superseded generation. For the handoff path this reproduces the
    control-grant `preserveSessionClose` downgrade exactly; for target replacement it is a
    deliberate, strictly more graceful behavior change — today `replace` fully revokes with
    no close preserved (`revokeDerived(..., false)`), and preserving close there is an
    intentional improvement, not a reproduction;
  - thread-turn operation routes: the operation row records the creating auth session and
    runtime identity; requests must match. The per-operation HMAC token tier is deleted;
    draft read/consume keeps its existing operation-scoped semantics under the ownership
    check (drafts were gated by the operation token, not the runtime grant).
- `refreshVoiceRuntimeGrant` — the one endpoint outside `EnvironmentAuthenticatedAuth` — is
  deleted with the rest of the grant surface: `provisionVoiceRuntimeGrant`,
  `revokeVoiceRuntimeGrant`, and `mediaTicket` in `controlHttp.ts` and their contract
  entries.

### Target and authority state

- Session-create and thread-turn-create requests carry the full target (realtime
  conversation, or project/thread plus speech preset, autoRearm, endpoint policy). The
  server validates it with the same checks grant provisioning performs today
  (`controlHttp.ts:190-209` moves, not disappears).
- A slim authority record replaces the grant table's non-credential columns: `runtimeId`,
  `authSessionId`, `generation` (strictly increasing, CAS on expected current), `target`,
  timestamps. No token hash, no rotation counter, no expiry ceremony — authority lives
  exactly as long as its auth session unless explicitly replaced or cleared. The CAS
  semantics (reserve with expected generation, reject reuse and jumps) are unchanged; they
  are coordination, not auth.

### Handoff exactly-once

The realtime→thread transition grant (one-use HMAC token consumed by `commitHandoff` to
atomically advance the authority generation) is replaced by an idempotent reservation keyed
`(voiceSessionId, actionId, nextGeneration)` with a `consumedAt` mark, created at exchange
and consumed at commit under the same session ownership check. `sourceLeaseGeneration`
remains a validated fence field on commit (it disambiguates the reservation today).

Exactly-once is carried by transactionality, not the key alone: consuming the reservation
(`consumedAt` CAS from NULL) and advancing the authority generation (CAS
`expected == nextGeneration - 1 → nextGeneration`) occur in ONE atomic transaction,
mirroring the existing `transition` transaction. Redelivery re-reads the reservation by its
key; when `consumedAt` is set and the authority is already at `nextGeneration`, the stored
outcome is returned. A crash between exchange and commit leaves an unconsumed reservation
that commit can still consume; a crash cannot separate the consume-mark from the generation
advance.

### Revocation and replacement cascades (must not regress)

Two distinct cascades exist today and both are rewired, not removed:

**Auth-session revocation** (`VoiceSessionLifecycleLive` on `clientRemoved`): end resident
voice sessions, cancel PRE-dispatch thread turns and DETACH already-dispatched coding turns
(the accepted coding turn continues server-side, per the ownership spec), remove authority
records, and purge `VoiceRuntimeRealtimeStarts` rows for that `authSessionId`. An
integration test asserts revoking the paired client ends native-held realtime work and
detaches (not kills) a dispatched coding turn.

**Target replacement / clear** (currently driven by `revokeRuntime` + `revokeDerived`,
which the grant-registry deletion removes): on a generation-advancing `configureAuthority`
or a `clearAuthority`, the server must (a) end resident realtime/thread voice sessions
bound to the prior generation (today `sessions.revokeRuntimeAuthority`), (b) cancel
pre-dispatch thread turns for that runtime, and (c) purge superseded
`VoiceRuntimeRealtimeStarts` rows. The retained starts table has no other purge trigger
once the registry is deleted; both cascades above must re-home it explicitly.

## Deletion inventory

Server (~2,800 LOC plus contracts):

- `VoiceRuntimeGrantRegistry` service + layer + tests; `VoiceRuntimeGrants` persistence.
- `VoiceRuntimeControlGrantRegistry` service + layer + tests; `VoiceRuntimeControlGrants`
  persistence.
- `VoiceMediaTicketRegistry` + tests (media session fallback already exists; JS already
  prefers session auth and falls back to tickets only when unauthenticated).
- `VoiceRealtimeTransitionGrants` token machinery (table survives as the reservation, minus
  token columns).
- Grant/ticket handlers in `controlHttp.ts`; header constants and token plumbing in the
  three raw HTTP files; the grant-dominated portions of `VoiceRealtimeControlService.ts` and
  `VoiceThreadTurnService.ts` (operation token issuance/validation).
- Forward drop-migrations for the grant/control-grant tables (new migrations; existing
  032-055 are immutable). `VoiceRuntimeRealtimeStarts` is reviewed separately — it is
  binding bookkeeping, not auth, and is expected to survive.

Contracts (`packages/contracts/src/voiceRuntime.ts`): `VoiceRuntimeGrant`,
`VoiceRuntimeGrantProvisionInput`, `VoiceRuntimeGrantRefreshInput`, revocation shapes,
`VoiceRuntimeCredentialHash`, `refreshRotationCounter`, target-digest fields tied to
provisioning; `environmentHttp.ts` grant/ticket endpoints. The command fence, snapshot,
lease, journal, and event schemas are untouched. ("Untouched" refers to the wire
contracts; the server-side lease/binding record gains the close-only lifecycle field
described under Route auth.)

Kotlin:

- `VoiceRuntimeAuthorityRefresh.kt`, `VoiceRuntimeAuthorityRefreshWorker.kt` + scheduler —
  the entire background rotation subsystem.
- The prepared-refresh-credential and rotation halves of `VoiceRuntimeAuthorityStore.kt`;
  the store shrinks to the persisted target/generation/readiness record plus the shared
  credential accessor. Startup fence resolution loses the refresh-credential and
  prepared-rotation inputs.
- Grant header attachment in `VoiceRuntimeHttp.kt`, `VoiceRuntimeRealtime.kt`,
  `VoiceRuntimeThreadTurn.kt`, `VoiceRuntimeControl.kt` → replaced by the session
  credential accessor.
- Tests pinned to the grant wire shape (`VoiceRuntimeAuthorityRefreshTest`, refresh/rotation
  cases in `VoiceRuntimeAuthorityStoreTest`, grant headers in `VoiceRuntimeRealtimeTest` /
  `VoiceRuntimeThreadTurnTest` / `VoiceRuntimeHttpTest`, refresh-admission cases in
  readiness policy tests) are rewritten to the session model.

JS:

- `nativeVoiceRuntimeProvisioning.ts` shrinks from grant choreography
  (prepare → provision → configure → refresh, target digests, credential hashes) to
  "configure target + ensure shared credential is current".
- `client.ts` drops `provisionVoiceRuntimeGrant` / `revokeVoiceRuntimeGrant` /
  `createMediaTicket` and ticket header injection; `useThreadSpeech` / `useComposerDictation`
  drop ticket acquisition (their requests already carry session auth when available).
- The `VoiceRuntime` facade's `configureAuthority` carries target + expected generation
  only; no raw token field.

## Explicitly retained

- Lease-generation fencing on realtime child routes and the journal/cursor/consumer-lease
  protocol — coordination, unchanged.
- Command idempotency ledgers and fingerprints — unchanged.
- The authority generation CAS — unchanged semantics, tokenless storage.
- `VoiceSessionLifecycleLive` revocation trigger — rewired as above.
- Keystore-backed storage for the shared credential copy — the cipher plumbing already in
  `VoiceRuntimeStorage.kt` is reused for the credential accessor; everything
  rotation-specific goes.
- Provider-side security posture (server-held OpenAI key, allowlisted tools, confirmation
  policy) — untouched.

## Migration

One vertical cutover, per the repo's no-alias rule: server route auth, contract removal,
Kotlin credential attachment, and JS provisioning simplification land together; the old
headers are rejected, not aliased. `VOICE_RUNTIME_PROTOCOL_MAJOR` bumps 1 → 2 (removing the
four runtime-route auth headers changes the native↔server protocol shape on the
protocol-gated routes (`x-t3-voice-ticket` lives on media routes outside the gate and
degrades to session auth; `x-t3-voice-refresh` dies with its endpoint); a mismatched pair must
refuse voice cleanly via the protocol gate, not fail with opaque 401s), and `nativeRevision`
bumps (the native↔JS provisioning contract changes shape). Kotlin note: the
`VoiceRuntimeAuthority` token validation (length ≤ 128, no whitespace, `VoiceRuntimeHttp.kt`)
was sized for compact grant digests and is incompatible with `Authorization: Bearer <token>`
values — the credential accessor replaces that header abstraction rather than re-pointing
it. Local deployments cut over in a maintenance window with a rebuilt
dev client; grant tables are drop-migrated after the cutover release. No data migration:
authority records are re-established on first native attach (target reconfiguration), and
in-flight voice sessions do not survive the maintenance window — acceptable for ephemeral
realtime sessions by the ownership spec's own process-failure rules.

## Verification

- Server integration: session-authenticated create/offer/heartbeat/actions/focus/close and
  thread-turn cycle; scope denial without `voice:use`; fence rejection with stale
  generation/lease; handoff exchange+commit exactly-once under redelivery and crash between
  exchange and commit; revocation cascade ends realtime and thread-turn work; media routes
  session-only (ticket path removed).
- Kotlin: credential accessor attaches the shared bearer token; startup with absent /
  stale / revoked credential converges to `unavailable`/`locked` without capture; expiry or
  revocation mid-mode pauses with `paused(reason=authority)` (no refresh path exists on
  bearer); deleted rotation paths have no surviving references.
- Conformance fixtures updated once (`configureAuthority` shape) and shared TS/Kotlin
  fixtures re-exported.
- Device: background thread-turn completes with React dead using only the shared bearer
  credential; revoking the client mid-mode pauses the runtime and releases media; recovery
  requires re-pairing from React, and the paused state survives service restart.

## Supersessions

On acceptance: mark the grant/rotation/ticket sections of
`specs/native-voice-runtime-ownership.md` (authority model, refresh protocol, media tickets)
as superseded by this spec; amend `specs/native-voice-runtime-kernel.md` (StoreDriver store
list, `Recover` inputs, fencing tables — the distributed authority chain reduces to the
tokenless CAS record); update `docs/architecture/voice.md` media-ticket and credential
boundary sections.

## Review correspondence

- **2026-07-14 — Opus review cycle 1 — verdict: needs-rework.** Applied: credential model
  rewritten to shared-bearer-token-no-refresh (the bearer path performs no `/oauth/token`
  exchange and the pairing token is one-time; findings 4.1/4.2); close-only lifecycle flag
  added to route auth (1.1); handoff exactly-once tightened to atomic
  consume+CAS with `sourceLeaseGeneration` fence retained (2.1/2.2); target-replacement and
  clear cascade added with `VoiceRuntimeRealtimeStarts` purge re-homing and
  cancel-pre-dispatch/detach-post-dispatch distinction (3.1/3.2/6.3); migration gains the
  `VOICE_RUNTIME_PROTOCOL_MAJOR` 1→2 bump and the Kotlin token-validation rework note
  (5.1/5.2). Confirmed sound by review: single-trust-domain rationale, `canonicalFence`
  claim, media session fallback, refresh-endpoint-outside-auth claim (6.2), thread-turn
  session-scoping (1.2), media-ticket removal viability (6.1).
- **2026-07-14 — Opus review cycle 2 — verdict: ready-with-amendments.** All cycle-1
  finding groups verified as resolved with code-grounded evidence; amendments mutually
  consistent with unchanged sections. Applied polish: close-only-for-replacement framed as
  deliberate behavior change (N2), protocol-shape claim narrowed to the four gated runtime
  headers (N3), wire-vs-server-record clarification on "lease schema untouched" (N4),
  6.2 disposition numbering (N1). Spec is implementable as written.

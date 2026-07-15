# Voice Auth Unification (M0)

Status: Draft for review. Precedes the kernel rework
(`specs/native-voice-runtime-kernel.md`; execution order in
`specs/voice-kernel-orchestration.md`). Supersedes the grant/refresh/rotation and media
ticket sections of `specs/native-voice-runtime-ownership.md` and the media ticket section of
`docs/architecture/voice.md` once accepted.

## Decision

There is exactly one client identity per device: the pairing state. The Android native voice
runtime authenticates to the T3 server as the paired client itself — the same durable client
session and the same access-token exchange React uses — and every voice runtime and media
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
  `exchangeBootstrapCredentialForAccessToken` passes no TTL), and renewal is the same token
  exchange every client already performs. Only DPoP access tokens are capped at one hour;
  see Credential model.

## Credential model

- The app holds one credential set in Keystore-backed app storage readable by both React and
  the native service: the pairing bootstrap credential and the current access token.
- The native runtime attaches the current access token (`Authorization: Bearer ...`) to its
  server calls. When stale, it performs the existing `/oauth/token` exchange with the shared
  bootstrap credential — the same flow, not a voice-specific one.
- Environments using DPoP: the DPoP signing key lives in the same app Keystore and is usable
  by the service process; native performs the same DPoP proof as React. The initial
  implementation targets the bearer path (local single-user deployments); DPoP-bound native
  calls are follow-up hardening, not a blocker, because the deployment in scope pairs with
  bearer sessions.
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
and consumed at commit under the same session ownership check. Same table shape minus the
token; same exactly-once guarantee; redelivery returns the stored outcome.

### Revocation cascade (must not regress)

`VoiceSessionLifecycleLive` already subscribes to `SessionStore.streamChanges` and fans
`clientRemoved` out to voice sessions and grant registries. The cascade is rewired, not
removed: on session revocation, terminate resident voice sessions, in-flight thread turns,
and authority records for that `authSessionId` directly. An integration test asserts
revoking the paired client ends native-held realtime and thread-turn work.

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
lease, journal, and event schemas are untouched.

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
headers are rejected, not aliased. `nativeRevision` bumps (the native↔JS provisioning
contract changes shape). Local deployments cut over in a maintenance window with a rebuilt
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
- Kotlin: credential accessor attach/refresh (mock token exchange), startup with absent /
  stale / revoked credential converges to `unavailable`/`locked` without capture; deleted
  rotation paths have no surviving references.
- Conformance fixtures updated once (`configureAuthority` shape) and shared TS/Kotlin
  fixtures re-exported.
- Device: background thread-turn completes with React dead using only the shared bearer
  credential; token expiry mid-mode pauses with `paused(reason=authority)` and recovers
  after refresh.

## Supersessions

On acceptance: mark the grant/rotation/ticket sections of
`specs/native-voice-runtime-ownership.md` (authority model, refresh protocol, media tickets)
as superseded by this spec; amend `specs/native-voice-runtime-kernel.md` (StoreDriver store
list, `Recover` inputs, fencing tables — the distributed authority chain reduces to the
tokenless CAS record); update `docs/architecture/voice.md` media-ticket and credential
boundary sections.

## Review correspondence

(appended by review cycles)

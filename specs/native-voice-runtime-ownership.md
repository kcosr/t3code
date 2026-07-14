# Unified Native Voice Runtime Ownership

Status: Proposed implementation specification

## Decision

On Android, one native runtime owns every Realtime conversation and every Active Thread
Auto Listen operation, regardless of whether the React activity is visible, backgrounded,
suspended, recreated, or absent. React is a command and presentation client of that runtime. It
must never start a competing Realtime peer, Auto Listen recorder, response waiter, or automatic
response TTS pipeline.

Persistent notification and headset readiness remains opt-in. Readiness controls whether Android
keeps enough foreground-service state and scoped authority to start new work while React is absent;
it does not select a different execution implementation. A foreground start and a notification
start enter the same state machine through the same command API.

The server contracts and client runtime interface remain platform-neutral. A future iOS native
adapter and desktop adapter implement the same semantic interface. A desktop adapter may initially
be React-backed, but exactly one adapter owns any operation.

This specification supersedes `specs/voice-background-execution.md`. The background-specific
contract and dual foreground/background execution model are obsolete and must not remain as
fallbacks or aliases.

## Motivation

The current Android implementation can complete an Active Thread turn natively when started from
the notification, while the foreground React tree still contains its original Auto Listen,
response-waiting, and thread-speech pipelines. When React attaches during or after native work,
both sides can act on the same assistant response. Observed consequences include duplicate TTS,
audio-owner conflicts, a stale busy state, UI state that only corrects after a conflicting Resume,
and foreground behavior that differs from notification behavior.

Realtime media is already largely service-owned, but session selection, provisioning, start,
recovery, and attachment are split between `MasterVoiceProvider`, `RealtimeVoiceController`, and
the Android service. This permits the UI to mistake a healthy native session for an idle session
and attempt another start.

Foreground and background are lifecycle states, not voice implementations. Moving all Android
voice-mode execution behind one native runtime removes that distinction and makes locking the
screen during an interaction an ordinary UI detachment.

## Goals

- Use one Android runtime and one media arbiter for Realtime and Active Thread voice in every app
  lifecycle state.
- Make React attachment and detachment observational: neither transition restarts, duplicates, or
  cancels healthy voice work.
- Give notification, headset, in-app, and Realtime tool actions the same command semantics.
- Preserve complete Active Thread execution without React: capture, endpointing, upload,
  transcription, deterministic dispatch, response correlation, streaming TTS, playback, and Auto
  Rearm.
- Preserve complete Realtime execution without React: conversation selection, session creation,
  WebRTC negotiation, media, heartbeat, tools, handoff drain, stop, and recovery.
- Provide durable operation and message correlation so React can reconcile after arbitrary delay
  without replaying submission or TTS.
- Keep manual composer dictation explicitly separate because it produces an editable local draft.
- Define a platform-neutral runtime boundary suitable for Android, iOS, desktop shells, and a
  single-owner React adapter.
- Remove obsolete dual-owner APIs and state after the new path is active.

## Non-goals

- Replacing the existing OpenAI Realtime provider or agent-tool implementation.
- Implementing the future iOS adapter in this workstream; no iOS build environment is available.
- Implementing desktop background services or OS media controls in this workstream.
- Making manual composer dictation survive UI destruction.
- Starting work after Android force-stop. Android requires the user to launch the app again.
- Retaining raw audio, transcripts, assistant text, SDP, provider payloads, or credentials in
  diagnostic logs.
- Adding compatibility routes, alias fields, dual-shape parsers, or a feature flag that restores
  the old foreground execution path.

## Terminology

- **Voice runtime**: the single platform adapter that accepts commands, owns voice-mode execution,
  and publishes a replayable state snapshot and ordered events.
- **Attached UI**: a React client currently subscribed to the runtime. Attachment does not imply
  ownership.
- **Readiness**: permission for the platform runtime to remain startable from notification or
  MediaSession controls while no UI is attached.
- **Voice mode**: either `realtime` or `thread` (Active Thread Auto Listen).
- **Composer dictation**: explicit microphone capture that appends transcription to an editable
  composer draft. It is not a voice mode.
- **Manual playback**: user-requested TTS for a thread message outside a native Active Thread turn.
- **Operation receipt**: durable, privacy-safe correlation proving which native operation submitted
  and/or spoke which projected messages.

## Ownership Invariants

1. At most one voice-mode operation owns capture, playback, audio focus, routing, wake locks, and
   foreground-service active-work state on a device.
2. On Android, only `T3VoiceRuntimeService` and its delegates execute Realtime or Active Thread
   operations. React never executes either pipeline.
3. A UI command returns after the runtime has accepted or rejected it; UI state comes from runtime
   snapshots and events, never from optimistic local ownership flags.
4. UI attachment cannot stop a matching healthy native operation. It may request retirement only
   when environment, runtime generation, conversation, target, or authority cannot reconcile.
5. Active Thread user-message dispatch is exactly once per native operation ID. Network retry,
   process recreation, UI recreation, and event replay cannot redispatch it.
6. One native pipeline attempts automatic response TTS. React suppresses automatic playback from
   Thread-mode command acceptance through terminal reconciliation and for every message named by an
   unexpired operation receipt. Audible exactly-once playback across process death is not promised.
7. Realtime and Active Thread are mutually exclusive. A transition is an acknowledged, ordered
   stop/drain/start operation, not two independent toggles.
8. Composer dictation can interrupt a voice mode only through the runtime arbiter. It remains
   React-owned after the runtime grants the capture lease.
9. Manual playback is admitted only when no voice mode owns output. Starting a voice mode cancels
   manual playback before capture begins.
10. Screen lock, Activity recreation, navigation, and React suspension never alter a healthy
    operation merely because presentation disappeared.

## Platform-neutral Runtime Contract

Add a client-runtime interface that describes semantics, not Android implementation details. Keep
its serializable schemas in `packages/contracts` and its typed facade, conformance fixtures, and
fake implementation in `@t3tools/client-runtime/voice`. The Android Expo module adapter implements
the facade. Other platforms supply exactly one adapter at app composition time.

```ts
interface VoiceRuntime {
  describe(): Promise<VoiceRuntimeDescriptor>;
  getSnapshot(): Promise<VoiceRuntimeSnapshot>;
  attach(input: VoiceRuntimeAttachRequest): Promise<VoiceRuntimeConsumerLease>;
  updateAttachment(input: VoiceRuntimeAttachmentUpdate): Promise<VoiceRuntimeConsumerLease>;
  detach(input: VoiceRuntimeConsumerLease): Promise<void>;
  subscribe(
    input: { lease: VoiceRuntimeConsumerLease; after: VoiceRuntimeCursor | null },
    listener: (event: VoiceRuntimeEvent | VoiceRuntimeRebase) => void,
  ): () => void;
  acknowledge(input: {
    lease: VoiceRuntimeConsumerLease;
    through: VoiceRuntimeCursor;
  }): Promise<void>;

  configureAuthority(input: VoiceRuntimeAuthorityReservation): Promise<VoiceRuntimeSnapshot>;
  clearAuthority(input: VoiceRuntimeAuthorityClearCommand): Promise<VoiceRuntimeSnapshot>;
  dispatch(command: VoiceRuntimeCommand): Promise<VoiceCommandReceipt>;
  readDraftArtifact(input: VoiceDraftArtifactRead): Promise<VoiceDraftArtifact>;
  acknowledgeDraftArtifact(input: VoiceDraftArtifactAcknowledgement): Promise<void>;
}
```

The descriptor declares `autonomous` or `ui-attached` execution, recording/endpointing support,
playback formats, Realtime WebRTC, persistent readiness, notification/headset control, and route
selection. Methods are not optional. An unsupported command returns a typed
`unsupported-capability` outcome.

All commands carry a caller-generated command ID, expected runtime ID, expected runtime-instance ID,
and authority generation. A mode start carries a stable `modeSessionId`; each Auto Rearm cycle has a
separate `turnClientOperationId`, and the server returns its distinct `turnOperationId`. Stop, mute,
route, and focus commands target an existing mode session rather than pretending to create a new
operation. Operation-specific variants carry only their exact identity and explicit interruption
policy.

Commands are idempotent. The runtime persists a canonical request fingerprint with each identity
for at least the operation/receipt retention window. Repeating the same ID and fingerprint returns
the original outcome; reusing an ID with a different kind, target, generation, or policy returns
`idempotency-conflict`. A stale runtime instance or generation is rejected before touching media.

`VoiceRuntimeSnapshot` uses independent axes because durable work can be waiting on the server while
no media resource is owned:

```text
availability: unavailable | locked | ready
operation: none | realtime | thread-turn | composer-dictation | manual-playback
operation phase: operation-specific strict union
media owner: none | recorder | player | realtime-peer | cue-player
readiness: disabled | ready | active
```

Realtime phases are `preparing -> negotiating -> cueing -> connected -> draining -> stopping ->
completed`, with `retrying`, `recovering`, `failed`, and `cancelled` terminal/recovery branches.
Thread phases are `arming -> recording -> finalizing -> uploading -> transcribing -> dispatching ->
waiting -> attention-required -> playing -> playback-drained -> guarding -> rearming`, with
`draft-ready`, `paused`, `retrying`, `recovering`, `completed`, `failed`, and `cancelled` branches.
`paused` has the strict reason union `user | authority | network`; `attention-required` has
`approval | user-input | inaccessible-target | draft-review` and may suspend a mid-turn or rearm
boundary until explicit resolution. Reducer fixtures cover every phase/reason combination.
Composer and manual playback have their own exhaustive smaller unions. The
snapshot contains runtime ID, a new runtime-instance ID generated at native process start,
generation, operation and media axes, target identity, mute and route state, current operation ID,
last ordered event sequence, and a typed sanitized failure. It does not contain transcript, message
text, audio, SDP, tokens, or provider-native identifiers.

Every event contains runtime ID, runtime-instance ID, authority generation, root mode/operation ID,
monotonically increasing sequence, kind, typed terminal outcome where applicable, and an optional
`causedByCommandId`. Timer, network, provider, permission, and process-recovery events do not invent
command IDs. Events are retained in a bounded native journal. The instance ID prevents a native
process restart from being mistaken for a sequence rollback.

`attach` creates an expiring consumer lease fenced by runtime/instance/generation. React recreation
may briefly produce overlapping leases, but only the current elected presentation lease may claim
navigation or draft artifacts. A subscription starts after an exact
`{runtimeId, runtimeInstanceId, generation, sequence}` cursor. If the cursor belongs to an old
instance or has fallen behind the bounded journal, the runtime returns `cursor-too-old` with an
atomic snapshot rebase and all durable unacknowledged receipts/actions. Ephemeral event sequence
resets for each runtime instance; durable receipts, draft artifacts, and pending UI actions live in
separate stores and cannot be evicted before acknowledgement or expiry. Acknowledgement includes
the consumer lease and full cursor, so an old Activity cannot advance a replacement journal.

Presentation election is deterministic. Each attachment has a service-issued monotonic attach
ordinal and reports `foreground-active | visible-inactive | background`. The newest non-expired
`foreground-active` lease wins; if none exists, no lease may consume presentation work. State
changes use `updateAttachment` with the current lease generation. Election changes publish an event
to all leases, and action/draft claims use a native compare-and-swap against the elected lease ID.
When the winner detaches, expires, or leaves foreground, the next newest eligible lease wins.

## Authority And Readiness

Use one `VoiceRuntimeGrant` contract for both attached and detached execution. React provisions
it while authenticated; the grant is bound to:

- runtime ID and strictly increasing authority generation;
- issuing auth session and immutable granted scopes;
- exact target: durable Realtime conversation, or exact environment/project/thread;
- allowed operation: `realtime-start` or `thread-turn-start`;
- thread speech preset and Auto Rearm policy where applicable;
- endpoint policy (`endSilenceMs`, nullable no-speech timeout, maximum utterance duration), speech
  enabled, and post-playback rearm guard for a thread target;
- issued and expiry timestamps.

The server persists only a SHA-256 token hash. Android stores the token encrypted with an AES-GCM
key in Android Keystore. The same runtime path is used while attached and detached:

```text
PUT    /api/voice/runtime/runtimes/:runtimeId/grant
DELETE /api/voice/runtime/runtimes/:runtimeId/grant
POST   /api/voice/runtime/runtimes/:runtimeId/grant/refresh
```

- While React is attached, a current grant may be provisioned on demand before a start command.
- While an operation is active, its required authority remains available until it reaches a safe
  terminal state, even if React detaches.
- If notification/headset readiness is enabled, Android retains encrypted start authority and the
  service stays eligible to accept detached start commands.
- If readiness is disabled, Android removes idle start authority after the last attached client and
  active operation are gone. It does not interrupt an already accepted server turn.

Replacing a target rotates the generation and revokes older start authority atomically. Disabling
readiness or revoking the paired auth session revokes the runtime grant and all unaccepted child
work. Raw T3 bearer, DPoP, provider, and OpenAI credentials never enter the native runtime.

Authority installation is a compare-and-swap. React first reserves the next generation with an
expected current generation, provisioning operation ID, and canonical target digest. A slow response
for an older reservation cannot overwrite a newer target or generation. Clearing authority carries
the same runtime/instance/current-generation fence and its own command ID.

Indefinite detached readiness cannot depend on React waking before every runtime-grant expiry. When
readiness is enabled, provisioning also issues a revocable, narrowly scoped refresh credential
bound to the same runtime ID, generation, auth session, exact target, and operation. Refresh is
crash-safe and idempotent: Android generates at least 256 bits from the platform CSPRNG for the next
raw token, sends its hash with a
refresh request ID and expected rotation counter, and stores the candidate under Keystore before
the request. The server atomically installs the hash and records the request outcome. A lost success
response can be retried with the old credential and same request ID to confirm the already-installed
candidate; it cannot rotate twice. The prior credential may only confirm that same request/hash for
five minutes or until the candidate credential is first used, whichever comes first. Replay with a
different hash, concurrent counter mismatch, target change, auth revocation, readiness disable, or
stale generation fails closed. When readiness is
disabled there is no refresh credential, and an attached authenticated UI must provision authority
on demand.

Initial runtime-grant and refresh tokens use the same entropy floor. The authenticated React client
receives the initial raw runtime token only in memory and immediately installs it through the native
adapter; it never writes, logs, caches, or places it in application state. Child and refreshed
credentials are exchanged directly by the native runtime.

The exact Realtime conversation is created or selected while an authenticated UI enables readiness
or starts Realtime for the first time. Notification/headset Start is unavailable until that exact
conversation authority exists. Deletion or inaccessibility locks readiness and requires an attached
UI; there is no open-ended `new conversation` grant shape.

Runtime authority, accepted child authority, and emergency revocation have different lifetimes:

- Readiness Disable revokes idle start and refresh credentials but does not itself stop an active
  operation. The user may issue Stop separately.
- Target replacement prevents new work under the old generation; an active mode must be explicitly
  drained/stopped before the new target activates.
- Auth-session or emergency revocation immediately closes Realtime and detaches local Thread audio.
  A coding turn already accepted by orchestration continues server-side without further local TTS.
- An accepted Thread child grant survives ordinary runtime-grant expiry only long enough to
  reconcile/cancel/detach that exact turn; it cannot start the next Auto Rearm cycle.

The preference formerly named as background controls is replaced by a notification/headset
readiness preference. There is no old-name fallback. Existing installations default the new
preference to disabled and require an explicit user choice.

## Android Runtime Architecture

`T3VoiceRuntimeService` remains the Android owner but delegates responsibilities to focused
components:

- `VoiceRuntimeReducer`: pure transition validation and command admission.
- `VoiceRuntimeAuthorityStore`: Keystore-backed grants, generations, and revocation fencing.
- `VoiceRuntimeEventJournal`: bounded ordered events, snapshot, acknowledgements, and receipts.
- `VoiceMediaArbiter`: exclusive capture/output/audio-focus ownership and interruption ordering.
- `VoiceOperationTerminalRouter`: sends bridge-owned terminal results only to their requesting
  bridge lease and native-owned results only to their native operation coordinator.
- `RealtimeOperation`: native server start, WebRTC negotiation, heartbeat, tool/client-action poll,
  handoff drain, and close.
- `ThreadModeOperation`: recording, endpointing, durable server turn, streaming speech playback,
  and Auto Rearm.
- `ComposerCaptureOperation`: operation-scoped recorder lease whose result is returned to React.
- `ManualPlaybackOperation`: operation-scoped native playback outside voice modes.
- `VoiceRuntimeNotificationController`: readiness and current-operation actions derived only from
  the runtime snapshot.
- `VoiceRuntimeMediaSessionController`: headset/media buttons translated to the same commands.

The service must not retain an Activity, React context, Expo module instance, or JavaScript promise.
The Expo module binds, sends commands, and projects the journal to typed events. Binder disconnect
does not stop runtime work.

Current classes named `Background*` are renamed or folded into these runtime components as they are
touched. No separate foreground coordinator remains.

The current global sticky recording/playback termination slots are removed. Every recorder/player
claim carries a typed owner domain and operation ID: `composer-dictation`, `manual-playback`,
`thread-mode`, `realtime-handoff`, or `cue`. Only composer/manual bridge results are exposed through
bridge completion handles and require bridge acknowledgement. Thread, handoff, and cue terminals
are consumed exactly once by their native coordinator and persisted where recovery requires it.
React can neither acknowledge nor delete an artifact owned by a native operation. Owner identity is
never inferred from an ID prefix.

## Realtime Execution

Both in-app Resume and notification/headset Start call `startRealtime`.

1. The runtime validates authority, permission, exclusivity, and generation.
2. It retires manual playback or composer capture according to the interruption matrix.
3. It creates or idempotently resumes the grant-bound durable conversation through
   `POST /api/voice/runtime/realtime-sessions`.
4. It prepares the WebRTC peer without enabling the microphone track.
5. It exchanges SDP through the session child grant and waits for connected media state.
6. Immediately before enabling capture it plays the configured start cue, waits for cue release,
   enables the microphone track, and publishes `connected`.
7. Native heartbeat, handoff polling, audio routing, and media continue without React.
8. Every terminal path disables the microphone track immediately. An explicit app/notification/
   headset Stop then closes immediately. An agent `stop_realtime` tool or Thread handoff performs a
   bounded drain of already-produced remote audio with capture disabled, then closes. Network or
   provider failure uses its typed recovery/terminal policy. All paths release media, play the stop
   cue when configured and meaningful, and publish terminal state.

Repeated start commands adopt the same matching session or return a typed conflict; they never
create a second provider call. React renders the native session. It does not run a parallel
`RealtimeVoiceController` media lifecycle on Android.

Realtime child authority exposes platform-neutral control routes:

```text
POST /api/voice/runtime/realtime-sessions
POST /api/voice/runtime/realtime-sessions/:sessionId/webrtc-offer
POST /api/voice/runtime/realtime-sessions/:sessionId/heartbeat
GET  /api/voice/runtime/realtime-sessions/:sessionId/actions
POST /api/voice/runtime/realtime-sessions/:sessionId/actions/:actionId/ack
PUT  /api/voice/runtime/realtime-sessions/:sessionId/focus
POST /api/voice/runtime/realtime-sessions/:sessionId/handoffs/:actionId/exchange
POST /api/voice/runtime/realtime-sessions/:sessionId/close
```

Actions are ordered, replayable, and retained until acknowledged or expired. Navigation actions are
emitted as durable runtime presentation actions. The elected attached React lease executes
navigation, then asks native to update validated server focus and acknowledge the action. If React
is absent, the action remains pending and Realtime tools continue with the last acknowledged focus.
UI navigation alone never changes tool focus.

Actions that require no UI, including `stop_realtime` and Active Thread handoff, execute inside the
runtime. Realtime-to-Thread handoff uses a server-minted one-use transition capability: the source
session child grant exchanges an accepted handoff action for authority bound to source session and
lease, runtime generation, action ID, exact destination project/thread, and `thread-turn-start`.
The old child remains close-only through capture disable and bounded playout drain. The new
authority is reserved but inactive until native admits the Thread mode session. Before activation,
failure leaves the old close authority valid and reports handoff failure; after activation, the new
generation is authoritative and the old session can only be closed idempotently.

Provider tool acceptance, durable device-action activation, and native completion are distinct.
The provider may say the handoff was accepted, but must not claim that capture is armed. Native
publishes completion after Thread capture arms; that result is durable for UI diagnostics even if
the provider session has already closed.

Starting Realtime while Thread mode is active is an explicit attached-UI replacement command. The
authenticated UI first reserves exact Realtime conversation authority with compare-and-swap against
the Thread generation. Native then prevents rearm, cancels an undispatched recording, or detaches an
already-dispatched turn and stops local speech, releases Thread media, atomically activates the new
authority generation, and starts Realtime. If authority reservation or media release fails, Realtime
does not start and Thread mode remains paused with a typed recovery action; it never runs both.
Detached notification/headset commands cannot perform this open-ended target switch and return
`authority-replacement-required`. Successful replacement also changes the configured readiness mode
and exact target to Realtime, so later detached Start resumes that conversation.

## Active Thread Execution

Foreground waveform, notification/headset Thread Start, and Realtime handoff all dispatch a
`start-thread-mode` command against the same exact target grant. The persistent Auto Listen owner is
a `modeSessionId`. Each capture/rearm cycle generates a new `turnClientOperationId`; the server
returns a separate `turnOperationId`. Stop and recovery target the mode session, while dispatch,
speech, and receipts target the individual turn.

The existing durable server behavior remains the only operation path, but the public contract is
renamed from Android-specific native terminology to platform-neutral runtime terminology:

```text
POST /api/voice/runtime/thread-turns
PUT  /api/voice/runtime/thread-turns/:operationId/audio
GET  /api/voice/runtime/thread-turns/:operationId/events
POST /api/voice/runtime/thread-turns/:operationId/events/ack
GET  /api/voice/runtime/thread-turns/:operationId/speech/:segmentIndex
GET  /api/voice/runtime/thread-turns/:operationId/draft
POST /api/voice/runtime/thread-turns/:operationId/draft/consume
POST /api/voice/runtime/thread-turns/:operationId/detach
POST /api/voice/runtime/thread-turns/:operationId/cancel
```

Native does not create the server turn until capture terminates and its submission policy is known.
Create accepts strict `submissionPolicy: auto-submit | draft`; it is immutable for that operation.
Native retains the finalized recording until the server acknowledges deterministic message
dispatch. The server transcribes once, derives deterministic command/message IDs, persists dispatch
identity before acceptance, correlates the exact turn, creates stable streaming speech segments,
and publishes ordered sanitized events. Retrying the operation cannot retranscribe or redispatch
after acceptance.

For `draft`, upload transcribes but never calls orchestration dispatch. The server enters
`draft-ready`, retains the transcript encrypted under short expiry, and exposes it once through the
operation child grant. Native turns it into an opaque local artifact handle for the elected exact-
target UI lease. `draft/consume` deletes the server copy after the UI acknowledges append; cancel or
expiry deletes it without dispatch. Crash/retry may re-fetch the same artifact but cannot submit it.

Native plays each immutable speech segment in order. It persists `highestStartedSegment` before
audible playback and `highestDrainedSegment` after confirmed drain, plus a per-segment disposition
of `drained | interrupted | skipped | failed`. After process death it does not automatically replay
a segment that may already have been audible; it marks a started-but-not-drained segment
`interrupted` and continues recovery from the next safe boundary. This is at-most-one automatic
attempt with possible omission, not exactly-once audible output. Explicit manual replay remains
available later.

Coding-turn completion and speech-terminal are independent. Auto Rearm occurs only after turn
terminal, explicit speech terminal (including no-speech), all advertised speech reaches a terminal
disposition, and the configured guard actually elapses.

If runtime authority is unavailable at rearm, the mode enters `paused(reason=authority)`; it does not reuse
the prior turn child grant. With detached readiness, native attempts the crash-safe exact-scope
refresh under bounded backoff and the notification shows `Waiting to renew voice access` with Stop.
With an attached authenticated UI, the adapter requests compare-and-swap reprovisioning. With
readiness disabled and no attached UI, the mode enters
`attention-required(reason=inaccessible-target)` and the notification says `Open T3 to continue`;
opening T3 reprovisions and requires an explicit Resume.

`attention-required` also represents a coding-agent approval, user-input request, inaccessible
target, or draft artifact that cannot be applied automatically. It blocks Auto Rearm. The
notification primary action opens the exact T3 surface; Stop and readiness Disable remain available.
Resolution is an explicit server/UI acknowledgement followed by Resume, never timer-driven retry.

Speech responses are streamed with bounded backpressure from the HTTP response into the PCM player;
the runtime does not buffer an unbounded or entire multi-minute segment in memory before playback.

Stop is phase-aware:

- A foreground waveform `finish-to-draft` command finalizes and transcribes the current recording,
  prevents dispatch, and publishes an opaque draft artifact handle to the attached UI. React reads
  the artifact once through an authenticated runtime method, appends it to the matching composer,
  and acknowledges deletion. Transcript text is never written to the event journal or diagnostic
  log. If the UI detaches before consumption, the encrypted artifact remains bounded by a short
  expiry and is offered only when the exact target UI reattaches.
- Notification/headset primary action while recording is `finish-and-submit`, not Stop: it finalizes
  the current utterance under `auto-submit` and pauses after that turn unless Auto Rearm remains
  explicitly enabled. A separate Cancel action discards pre-dispatch audio.
- Before deterministic dispatch, stop cancels the server operation when safe.
- After dispatch, `pause-after-turn` prevents rearm but lets current speech drain. Immediate local
  Stop calls `detach`, suppresses future speech synthesis/retention, ends polling/playback, and does
  not cancel accepted coding work. The server keeps only correlation/terminal state until normal
  operation retention expiry.
- Realtime handoff drains Realtime, rotates authority to the exact thread, starts Thread mode, and
  reports success only after native capture is armed. Navigation acknowledgement is independent of
  audio execution and cannot cause the handoff to fail after capture started.

## Durable Correlation And Duplicate Suppression

Each Active Thread operation produces a durable receipt containing:

```text
runtimeGeneration
operationId
target environment/project/thread IDs
userMessageId
turnId
assistantMessageIds[]
speechPlanId
highestAdvertisedSegment
highestStartedSegment
highestDrainedSegment
segmentDispositions[]
speechTerminal
terminalOutcome
createdAt / expiresAt
```

Receipts contain IDs and counters only. Server events publish assistant message IDs as soon as they
are correlated, but projection delivery may still win that race. Android persists current and
recently terminal receipts in the native journal. The server operation snapshot is authoritative
if local recovery is incomplete.
React acknowledges a receipt only after the named ordinary projections are visible locally. The
runtime retains unacknowledged receipts across Activity and process recreation, subject to bounded
expiry of at least 30 days. Automatic thread TTS also has a five-minute freshness limit measured by
the client's monotonic clock from a locally observed active turn/submission anchor, not server or
device wall-clock message timestamps. A response without that local anchor is historical. The
client never speaks messages first observed during initial load, cache restoration, or gap
resynchronization. Therefore a projection arriving after receipt expiry cannot resurrect automatic
playback or exploit clock skew.

From Thread-mode command acceptance until the mode is terminal, React suppresses all automatic TTS
for the exact target and cancels any queued target playback when the native command is accepted.
This closes the projection-before-receipt race. `useThreadSpeech` and any successor planner also
receive the active/recent receipt set. They must not automatically synthesize a message named by a
receipt whose native speech outcome is pending,
played, skipped, or terminally failed. A native TTS failure is shown as a native operation status;
React does not silently retry through a second TTS pipeline. Explicit user-initiated replay is a new
manual playback operation and is allowed after voice-mode ownership is released.

## Composer Dictation And Manual Playback

Composer dictation remains UI-owned because the user expects an editable draft and manual submit.
It must acquire a native composer-capture lease through the runtime arbiter. The runtime returns a
recording result or typed termination; React uploads it for transcription and edits the draft.
Destroying the composer cancels its lease. Composer capture never uses the Active Thread durable
operation or auto-submits.

`finish-to-draft` preserves the established waveform behavior without retaining the React Auto
Listen implementation. It is an explicit Thread-mode command, not a generic stop fallback. Normal
endpoint completion continues to auto-submit the full utterance.

Foreground waveform start supplies a `draftContext` containing exact environment/thread and the
current composer revision; `finish-to-draft` is unavailable if no visible composer supplied that
context. Consumption never overwrites newer edits: when the exact target composer is mounted, React
appends the transcript to its current draft using normal separator rules and preserves attachments,
regardless of later revision changes. If the target is deleted/inaccessible or the composer update
fails, the operation enters review-required `attention-required` and leaves the artifact unconsumed.

Interruption rules are deterministic:

| Current owner          | Requested operation              | Result                                                          |
| ---------------------- | -------------------------------- | --------------------------------------------------------------- |
| Manual playback        | Realtime or Thread               | Stop playback, release focus, then start voice mode             |
| Composer capture       | Realtime or Thread               | Cancel capture, wait for release, then start voice mode         |
| Realtime               | Composer capture                 | Drain/stop Realtime, then grant capture                         |
| Thread recording       | Composer capture                 | Stop Thread mode without draft, then grant capture              |
| Thread waiting/playing | Composer capture                 | Stop local Thread mode; accepted server turn continues          |
| Any voice mode         | Automatic thread TTS             | Suppress; native operation owns response audio                  |
| Any voice mode         | Manual replay                    | Reject with typed busy state                                    |
| Realtime               | Thread handoff                   | Drain Realtime, rotate exact target, arm Thread capture         |
| Thread mode            | Attached-UI Realtime replacement | Stop/detach Thread, CAS authority, start Realtime               |
| Thread mode            | Detached Realtime start          | Reject with authority-replacement-required                      |
| Thread recording       | Foreground finish-to-draft       | Finalize/STT, do not dispatch, return one-time draft artifact   |
| Thread recording       | Headset/notification primary     | Finish-and-submit; then rearm or pause per policy               |
| Thread operation       | Explicit Cancel                  | Discard only before dispatch; detach local audio after dispatch |

All release/start sequences run on one serialized native command queue. UI alerts are reserved for
actionable failures, not expected stop or interruption outcomes.

## React Responsibilities

React owns:

- authentication and on-demand authority provisioning;
- preference editing and target selection;
- issuing idempotent commands;
- subscribing before snapshot, replaying ordered events, and acknowledging sequences;
- rendering runtime state on thread, picker, notification-settings, and global voice surfaces;
- navigation and acknowledgement for UI client actions;
- manual composer-dictation transcription after obtaining its capture result;
- explicit manual replay requests;
- correlating native receipts with ordinary thread projections.

React does not own:

- Realtime session/media lifecycle on Android;
- Active Thread recording, transcription dispatch, response waiting, TTS, or Auto Rearm;
- a second timer-based state machine for foreground Auto Listen;
- stopping operations because `AppState` changed;
- inferring active state from whether a React controller object exists.

`MasterVoiceProvider` becomes a runtime adapter/provider rather than the owner. Thread screens render
the global snapshot and issue commands. The Android path removes foreground command gates whose
purpose was to wake React to execute native commands. Notification and MediaSession commands execute
directly in the runtime; React receives their resulting state like any other observer.

## Lifecycle And Recovery

A Realtime operation writes a bounded `RealtimeTerminalSummary`, distinct from an Active Thread
receipt. It contains runtime/instance/generation, mode session ID, durable conversation ID, T3
session ID, `completed | stopped | interrupted | failed` outcome, sanitized reason, last connected
timestamp, terminal timestamp, and whether server cleanup is pending. It is retained for 30 days or
until the UI acknowledges it after reconciliation, whichever comes first. It contains no provider
ID, transcript, SDP, media, or token.

- Activity recreation: the new provider subscribes, reads snapshot, replays after its cursor, and
  renders the existing operation. It does not start or stop anything implicitly.
- Screen lock/background: no execution transition occurs. Foreground-service notification remains
  while active work requires it.
- React suspension: native continues media and server polling. Projection sync catches up later.
- Android process death during Thread mode: validate Keystore authority/generation, restore the
  durable operation cursor, resume upload/poll/playback when allowed, and never redispatch.
- Android process death during Realtime: a WebRTC peer cannot survive. Publish an `interrupted`
  Realtime terminal summary; if readiness remains valid, a later explicit Start creates a new provider call
  for the same durable conversation. Do not claim transparent media continuation.
- Network loss: keep one operation identity, publish retrying state, and resume from acknowledged
  server/native cursors. Never create a second turn or call merely because a request timed out.
- Permission loss, authority revocation, target replacement, or explicit Disable: fence new work,
  converge to a coherent stopped/locked state, and release media, focus, locks, and foreground
  ownership.
- Server restart: Active Thread resumes from durable operation state. Realtime terminates and can
  explicitly reconnect to the same durable conversation.

## Notification And MediaSession

Notification actions are derived from the runtime snapshot:

- Idle and ready: Start using the configured mode and exact target.
- Preparing/active/recovering: Stop.
- Realtime connected: Mute/unmute where space permits.
- Thread recording: Finish-and-submit as primary; Cancel is a distinct secondary action.
- Readiness enabled with no work: Disable readiness.

The headset/media button invokes the same state-derived primary action. No action launches React
merely to execute voice work. Opening the app only attaches presentation. Notification dismissal
cannot stop active work; explicit Stop or Disable is required.

## Cross-platform Adapters

The shared interface and state/event schemas contain no Android service, notification, Binder,
Keystore, or URI types.

- Android: native service adapter implemented in this workstream.
- iOS: future native adapter using AVAudioSession/AVAudioEngine/native WebRTC and iOS background
  capabilities. It must pass the same contract and reducer tests; it is not build-tested here.
- Desktop native shells: future process/service adapter with OS media integration.
- Browser/React desktop: allowed as a single adapter when the page is the execution environment.
  It must implement the same idempotent commands, snapshot/events, arbiter, and receipts. It cannot
  coexist with another adapter for the same device runtime.

Provider-specific OpenAI logic remains on the T3 server. Platform adapters speak only T3 runtime
voice contracts, so future voice providers do not require client-specific control paths.

## Security, Privacy, And Observability

- Native origins must be HTTPS, contain no embedded credentials/query/fragment, and reject
  authenticated redirects.
- Runtime and operation tokens are redacted with authorization headers.
- Persist only encrypted authority, operation identity, target generation, upload/dispatch
  acknowledgement, event/playback cursors, receipts, bounded terminal summaries, and encrypted
  short-lived draft artifacts explicitly requested by the foreground user.
- Delete finalized local audio after dispatch acknowledgement or terminal pre-dispatch cleanup.
- Diagnostics contain curated IDs, mode/phase, generation, counts, timings, route class, retry count,
  and stable error codes only.
- Never log audio, transcript/message text, speech bytes, tool arguments/results, SDP, tokens,
  provider events, or raw provider IDs.
- Extend the existing bounded native diagnostic ring rather than adding an in-app telemetry UI or
  unbounded Android logging.
- Record phase timings for command acceptance, authority validation, media release, Realtime create,
  SDP, peer connected, microphone enable, thread create/upload/dispatch, first response, first
  speech, drain, stop, and resource release.

## Migration And Removal

This is a direct end-state migration on Android, delivered as vertical milestones:

1. **Foundations:** add the descriptor/snapshot/event/command/receipt schemas, fake runtime,
   conformance fixtures, Android adapter, owner-scoped terminal routing, durable presentation
   actions, target-wide automatic TTS suppression, grant PUT/DELETE/refresh routes, CAS authority
   reservation/installation, generation fencing, and base child-grant issuance. The old execution
   paths remain the sole owners during this milestone.
2. **Active Thread switch:** add mode/turn identities, draft/detach server behavior, endpoint/speech/
   guard policy, Thread child authority, receipt projection, and native foreground commands.
   Atomically switch waveform and handoff to native execution, then delete React Auto Listen,
   handoff recording adoption, and the thread command fallback. Suppression and terminal routing
   are active before the first native foreground response can project.
3. **Realtime switch:** move create/offer/actions/focus/heartbeat/drain/stop/recovery behind the
   adapter with Realtime child authority, atomically switch all Android in-app controls, then delete
   Android React Realtime lifecycle ownership. Web/desktop keep their own single adapter.
4. **Detached readiness:** replace background-control preference with notification/headset
   readiness and add the crash-safe exact-scope refresh credential. Attached and detached starts
   already use the same runtime before this milestone.
5. **Protocol and naming cutover:** rename `VoiceNativeRuntime*`, `VoiceNativeThreadTurn*`, and
   `/api/voice/native-*` to `VoiceRuntime*`, `VoiceThreadTurn*`, and `/api/voice/runtime/*` across
   contracts, server, client runtime, Android, persistence service names, and tests. Fold obsolete
   `Background*` classes into runtime components and remove old contracts/routes.

No deployed/test candidate may contain two enabled execution owners for the same operation path.
Intermediate commits keep the old path solely active or complete one vertical switch.

The canonical namespace is `/api/voice/runtime/*`; there are no `runtime-*` or plural-root variants.
The protocol cutover is strict but operationally staged. The environment descriptor advertises a
new required voice-runtime protocol major. Before cutover, drain or explicitly terminate active
voice sessions/turns, revoke old grants/refresh credentials, and fence their generations. Install
the new app build and deploy the new server during one maintenance window; either side refuses voice
commands while the advertised major is incompatible. The server exposes only the new routes after
restart. A one-time database migration preserves compatible durable conversation/turn records but
invalidates old runtime authority and cursors. There are no alias routes, dual parsers, or silent
fallbacks.

## Verification

### Contract and shared tests

- Strict schema round trips reject excess fields, mixed targets, stale generation, and invalid
  command/receipt IDs.
- Runtime descriptor and conformance fixtures cover autonomous and UI-attached adapters without
  optional-method ambiguity.
- Runtime reducer covers every phase and forbidden transition.
- Command IDs are idempotent and event sequences remain monotonic across replay.
- Runtime-instance replacement rejects stale cursors and late callbacks.
- Shared JSON fixtures are decoded by TypeScript and Kotlin for every command, state, event, receipt,
  and terminal owner domain.
- Receipt retention/acknowledgement closes delayed projection and Activity-recreation races.
- Interruption matrix has exhaustive table-driven tests.

### Server tests

- Grant issue/compare-and-swap install/rotation/revocation and exact target/operation fencing.
- Refresh tests cover request replay, body conflict, concurrent counters, lost response, crash before
  and after local candidate commit, expiry, auth revocation, target replacement, and Disable.
- Fresh Realtime create, idempotent retry, SDP, heartbeat, ordered action poll/ack, focus update,
  one-use handoff exchange, close, conflict, and cleanup.
- Protocol-major migration tests preserve compatible conversation/turn records, invalidate old
  grants/refresh credentials/cursors, reject old routes, and advertise the new major atomically.
- Thread upload validation, processing-lease recovery, duplicate upload, deterministic one-time
  dispatch, restart before/after dispatch, ordered event replay/ack, attention state, cancellation,
  detach/speech suppression, draft without dispatch/consume/expiry, and speech segment retry.
- Streaming speech begins before response completion and publishes explicit speech terminal.

### Android tests

- Pure reducer and arbiter tests for every command, interruption, failure, and release order.
- Service/Binder tests prove disconnect and Activity recreation do not stop work.
- Realtime tests prove the microphone stays disabled until peer connection and start cue complete.
- Realtime tests disable capture at drain entry and distinguish explicit immediate Stop from bounded
  agent-tool/handoff drain.
- Realtime process-death tests close orphan server state, publish one interrupted terminal summary,
  and never claim transparent WebRTC continuation.
- Thread tests cover record/upload/wait/stream/play/rearm, process snapshot, duplicate event/segment,
  target replacement, retry, Stop in every phase, and receipt persistence.
- No-React Thread tests complete capture, upload, two speech segments, drain, guard, and a second
  recording; native terminals never occupy bridge slots and a mounted bridge observer cannot delete
  native artifacts.
- Foreground finish-to-draft tests prove transcription is not dispatched, is exposed only to the
  exact elected target lease, appends without overwriting concurrent edits, and is deleted after
  acknowledgement or expiry.
- Process death during a speech segment produces `interrupted` without automatic replay; death
  between segments resumes at the next safe boundary.
- `speechEnabled=false` reaches completion/rearm without waiting for speech, configured endpoint
  values reach the recorder, and guarding waits the configured duration.
- Runtime grant expiry during an accepted turn and between rearm cycles follows the documented child
  and refresh authority rules.
- `attention-required` blocks rearm and exposes only Open/Resume-after-resolution, Stop, and Disable.
- Notification/MediaSession tests derive actions only from runtime snapshot and never require React.
- Resource tests prove audio focus, route, wake/Wi-Fi locks, peer, recorder, player, and foreground
  ownership release on every terminal path.

### React tests

- Subscribe-before-snapshot and ordered replay/acknowledgement.
- Old-instance and old-consumer acknowledgements fail, while journal overflow returns a snapshot
  rebase with durable pending actions/receipts.
- In-app Realtime and waveform controls issue runtime commands without starting local pipelines.
- Matching native Realtime adoption never sends a second start.
- Active Thread projections never trigger duplicate submission or automatic TTS.
- Projection-before-receipt suppresses/cancels queued target playback from native command acceptance.
- Automatic TTS requires a non-expired local monotonic active-turn anchor and suppresses responses
  first observed during initial load, cache restoration, and cursor-gap resynchronization.
- Explicit manual replay remains available after native ownership releases.
- Composer dictation stays editable/manual and obeys the native capture lease.
- Navigation/client-action acknowledgement does not determine voice-operation success.

### Connected Android validation

Before implementation review, build and install the exact committed branch revision and have the
user validate:

1. Start/stop Realtime from app, notification, and headset; verify UI reflects native state without
   pressing Resume.
2. Lock/background/restore during Realtime speaking and listening; verify no interruption or second
   session.
3. Start Active Thread from foreground waveform, notification, and headset; verify identical
   record/submit/streaming TTS/Auto Rearm behavior.
4. Open/close/recreate the Activity during Thread recording, waiting, playback, and rearm; verify no
   duplicate message or TTS.
5. Switch between Realtime and Thread via in-app controls and Realtime tool handoff; verify drain,
   navigation, armed capture, submission, and no busy leak.
6. Start typed thread work while Realtime is active; verify automatic thread TTS is suppressed.
7. Exercise composer dictation and manual replay around both voice modes; verify interruption rules.
8. Interrupt Wi-Fi during Realtime negotiation and Thread upload/wait/playback; verify one operation
   identity and coherent retry/stop behavior.
9. Validate screen-off notification/headset control, permission denial/grant, route selection, cues,
   and readiness disable.
10. Mount overlapping React activities during recording completion and presentation actions; verify
    only the elected lease consumes navigation/draft work and neither can delete native artifacts.

Record any user-only validation failures in `scratch/voice-roadmap-user-validation.md`. Do not run
the final Keel implementation review until this hands-on validation has completed and resulting
fixes are incorporated.

## Completion Criteria

- Android has one voice runtime owner in foreground and background.
- Realtime and Active Thread execute completely without React and attach cleanly when React returns.
- Foreground waveform and Resume use the same native paths as notification/headset controls.
- No native Active Thread response can trigger duplicate React submission or automatic TTS.
- Composer dictation and manual replay retain their intended behavior under explicit arbitration.
- Obsolete dual-owner paths, names, contracts, and preference shape are removed.
- Required repository, server, mobile lint, native unit/instrumented, and connected-device tests pass.
- The exact committed build is installed and passes the user validation checkpoint.
- Only after that checkpoint, the implementation receives a clean `claude-fable-5` Keel iterative
  review.

## Correspondence

### 2026-07-14T03:26:45.362Z - Reviewer: claude-fable-5

Reviewed the full specification against the stated product requirement (one Android native
runtime owner for Realtime and Active Thread voice in foreground and background, React limited
to commands and presentation, manual composer dictation preserved). The end-state design is
coherent: the ownership invariants, idempotent fenced command model, instance-scoped journal
with rebase, receipt-based duplicate-TTS suppression, CAS authority with crash-safe refresh,
and the strict no-fallback migration are all well constructed and mutually consistent. Status:
changes requested on the following points.

1. **[high] Thread→Realtime transition is unspecified.** The interruption matrix and Realtime
   Execution cover Realtime→Thread handoff in depth, but no row or sequence defines starting
   Realtime while a Thread mode session is active (any phase), even though connected validation
   step 5 requires switching "between Realtime and Thread via in-app controls" in both
   directions. Because a grant binds one allowed operation and one exact target, the switch
   implies stop/drain of the mode session plus a generation-rotating authority replacement —
   specify that sequence, whether `startRealtime` auto-stops Thread mode or returns a typed
   conflict, and what the rotation does to the configured readiness/notification start mode
   afterward.

2. **[medium] Route naming is internally inconsistent.** Grant routes use
   `/api/voice/runtimes/:runtimeId/grant` (plural), operation routes use
   `/api/voice/runtime/...` (singular), and Milestone 5 says the cutover target is
   `/api/voice/runtime-*` (hyphenated). Pick one canonical shape. The Realtime child-route list
   also omits the SDP exchange and heartbeat routes that steps 5 and 7 require — list them or
   state they are renamed existing routes.

3. **[medium] Realtime "interrupted terminal receipt" is undefined.** The durable receipt
   schema is Active-Thread-only ("Each Active Thread operation produces a durable receipt"),
   but Lifecycle And Recovery requires publishing "a typed interrupted terminal receipt" for
   Realtime process death. Define the Realtime terminal record (or rename it to a terminal
   event/summary) and its retention, and add an Android test for process death during Realtime.

4. **[medium] Presentation-lease election is undeclared.** Overlapping leases during React
   recreation are acknowledged and only the "elected" lease may claim navigation and draft
   artifacts, but the election rule (e.g., newest attach wins, foreground wins), how a losing
   lease learns it lost, and how election interacts with lease expiry are not defined. This is
   directly load-bearing for connected validation step 10 and for draft-artifact safety.

5. **[medium] Authority provisioning routes have no milestone home.** Milestone 4 adds only the
   refresh credential, yet Milestones 2 and 3 already require the grant PUT/DELETE, CAS
   reservation, generation fencing, and child-grant issuance for attached starts. Assign that
   server/authority work explicitly (likely Milestone 1 or split across 2/3) so no milestone
   silently depends on unbuilt authority infrastructure.

6. **[medium] Receipt expiry vs long-delayed projection.** Suppression is scoped to "an
   unexpired operation receipt" and retention is "longer than projection resynchronization",
   but no bound is stated and the behavior when projections first arrive after receipt expiry
   (device offline for days) is undefined — that path can resurrect duplicate automatic TTS.
   State the retention bound and a rule for post-expiry arrivals (e.g., never auto-speak
   messages older than a freshness threshold or delivered during initial resync).

7. **[medium] Rearm-time authority loss behavior is referenced but not documented.** Android
   tests require that grant expiry "between rearm cycles follows the documented child and
   refresh authority rules", but the Authority section only says the child grant cannot start
   the next cycle. Specify the mode-session outcome when rearm-time authority is missing
   (typed paused/attention state vs terminal), the notification presentation, and the recovery
   path for attached vs detached readiness-disabled cases.

8. **[low] `attention-required` phase has no semantics.** It appears in the Thread phase union
   and in server tests but is never defined: what triggers it, whether it blocks Auto Rearm,
   and what notification/headset actions it exposes.

9. **[low] Token-generation and grace-window parameters unspecified.** Client-generated refresh
   rotation means the server can only verify a hash — state the entropy requirement (e.g.,
   ≥256-bit CSPRNG) for grant/refresh tokens, the bounded window in which the old credential
   may confirm an installed candidate, and whether the raw runtime-grant token transits React
   JS during provisioning or is delivered directly to the native module.

10. **[low] Milestone 5 database migration lacks verification.** The one-time migration that
    preserves durable conversation/turn records while invalidating old authority and cursors
    has no corresponding entry in the server test list; add migration tests (old-record
    compatibility, authority invalidation, cursor rejection post-cutover).

11. **[low] Draft-artifact revision reconciliation is underspecified.** "Composer revision
    observed when capture began" is ambiguous for waveform-initiated capture where the composer
    may be unmounted or empty, and "cannot reconcile automatically" has no defined criteria for
    entering review state. Define both so Milestone 2's finish-to-draft tests are writable.

### 2026-07-14T03:31:50.430Z - Reviewer: claude-fable-5

Re-reviewed the full specification after the creator's update. All eleven prior findings are
resolved in the main design and each resolution is internally consistent with the rest of the
document:

- Thread→Realtime is now an explicit attached-UI replacement command with CAS authority
  reservation, ordered stop/detach → activate → start, typed failure leaving Thread paused,
  detached rejection via `authority-replacement-required`, readiness-target rotation, and
  matching interruption-matrix rows.
- All routes are unified under `/api/voice/runtime/*` with an explicit canonical-namespace
  statement, and the Realtime child-route list now includes create, `webrtc-offer`, and
  heartbeat.
- `RealtimeTerminalSummary` is defined with fields, 30-day/acknowledgement retention, privacy
  bounds, and a dedicated process-death Android test.
- Presentation-lease election is deterministic (monotonic attach ordinal, newest non-expired
  `foreground-active` wins, `updateAttachment`, election-change events, CAS claims, succession).
- Grant/CAS/fencing infrastructure moved to Foundations with child authority assigned to each
  switch milestone; refresh credential remains Milestone 4.
- Receipts retain ≥30 days, and the five-minute TTS freshness limit plus never-speak on initial
  load/cache restoration/resync closes the post-expiry duplicate-TTS path.
- `paused-authority` rearm behavior, `attention-required` semantics/controls, ≥256-bit CSPRNG
  tokens, five-minute same-request confirmation grace, memory-only JS token transit,
  protocol-major migration tests, and `draftContext`-gated append-only finish-to-draft
  reconciliation are all specified and covered by the verification sections.

Two low-severity consistency items introduced by the new text remain:

1. **[low] Thread phase union not reconciled with new states.** The normative Thread phase
   union lists `paused` among its branches, but the Authority-loss rearm text says the mode
   enters `paused-authority`, and both the rearm section and the finish-to-draft reconciliation
   use `attention-required` as a terminal/review outcome while the union places it only in the
   mid-turn flow. Because the union is declared strict and reducer tests must cover every phase
   and forbidden transition, either add `paused-authority` (and terminal `attention-required`)
   to the union or define them as typed sub-reasons of the existing `paused`/`attention-required`
   phases.

2. **[low] Freshness rules lack explicit React test coverage and a reference clock.** The
   five-minute automatic-TTS freshness limit and the never-speak-on-initial-load/cache
   restoration/gap-resync rule are now load-bearing for post-receipt-expiry safety, but the
   React test list does not name them, and the five-minute window's reference timestamp
   (server message creation vs local first observation) is unstated. Name the reference clock
   and add explicit React tests for both rules.

Everything else is ready for implementation; no unresolved disagreements remain.

### 2026-07-14T03:34:09.297Z - Reviewer: claude-fable-5

Re-reviewed the full specification after the creator's update. Both remaining low findings are
resolved and consistent with the rest of the document:

1. **Thread phase union reconciled.** `paused` now carries the strict reason union
   `user | authority | network` and `attention-required` carries
   `approval | user-input | inaccessible-target | draft-review`, with explicit allowance for
   suspending a mid-turn or rearm boundary until explicit resolution and reducer fixtures
   covering every phase/reason combination. The authority-loss rearm path now uses the typed
   states `paused(reason=authority)` and `attention-required(reason=inaccessible-target)`, and
   the finish-to-draft review path maps onto `draft-review`. No undeclared states remain.

2. **TTS freshness anchored and tested.** The five-minute automatic-TTS freshness limit is now
   measured by the client's monotonic clock from a locally observed active turn/submission
   anchor rather than server or device wall-clock timestamps; a response without a local anchor
   is historical, and initial load, cache restoration, and gap resynchronization are explicitly
   suppressed. This fails safe across reboot and process death (a lost monotonic anchor
   suppresses rather than resurrects playback) and closes the clock-skew avenue. The React test
   list names both the anchor requirement and the initial-load/resync suppression.

Full-document re-check found no new inconsistencies: the reason unions align with the Android
test expectations for `attention-required`, the notification presentations for
`paused(reason=authority)` are defined for both attached and detached cases, and the
verification sections cover the new rules. All eleven findings from the first review and both
follow-up findings are resolved. The specification is ready for implementation: status clean,
no findings.

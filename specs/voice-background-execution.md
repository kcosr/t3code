# React-Independent Voice Background Execution

Status: Approved implementation specification

## Objective

An opted-in Android foreground service can start or continue the global Realtime voice agent and
complete Active Thread voice turns while React is suspended, unmounted, or absent. React remains a
presentation and control surface rather than an execution dependency. Server contracts and
operation semantics remain platform-neutral so desktop and iOS adapters can implement the same
protocol later.

Force-stop remains Android-defined: the application cannot restart background work until the user
launches it again.

## Ownership

- Android owns microphone capture, endpointing, WebRTC, PCM playback, audio focus, routing,
  notification and MediaSession controls, operation retry, and Auto Rearm.
- T3 server owns authorization, target validation, transcription, deterministic thread dispatch,
  response correlation, stable speech segmentation, synthesis, Realtime conversation selection,
  signaling, and durable operation state.
- React provisions and rotates native authority while authenticated, displays native/server state,
  and reconciles projections and native events after remount. It does not execute a second Auto
  Listen pipeline.
- Manual composer dictation remains React-owned because it intentionally edits a visible draft.

## Authority Model

### Runtime grant

Add a `VoiceNativeRuntimeGrant` distinct from the existing session-bound
`VoiceNativeControlGrant`. A paired authenticated client provisions it only while background voice
readiness is enabled.

The grant is bound to:

- native runtime ID and strictly increasing readiness generation;
- issuing auth session and its immutable granted scopes;
- one strict target shape: Realtime conversation selection or exact project/thread target;
- allowed operation (`realtime-start` or `thread-turn-start`);
- speech preset and Auto Rearm policy for a thread target;
- issued and expiry timestamps.

The server persists only a SHA-256 token hash. Android encrypts the raw token with an AES-GCM key
held by Android Keystore and stores only ciphertext and non-secret scope metadata. A token cannot
choose a different target at execution time.

Replacing readiness rotates the generation and revokes older runtime grants atomically. Disabling
readiness or revoking the paired auth session revokes the runtime grant and all child grants. An
expired grant cannot renew itself; React must provision a replacement while authenticated.

### Child authority

- Fresh Realtime creation returns the existing session-bound native control grant, extended only
  with native signaling and close authority for that exact session and lease generation.
- An accepted thread turn returns an operation-bound token. Runtime-grant rotation does not strand
  accepted work, but explicit readiness disable or auth revocation terminates its remaining native
  access.
- Raw T3 bearer, DPoP, and provider credentials never cross into the native service.

## Runtime Grant Management

Authenticated environment operations provision and revoke a runtime grant. Inputs are strict
discriminated unions; there is no optional mixed target shape or compatibility route.

```text
PUT    /api/voice/native-runtimes/:runtimeId/grant
DELETE /api/voice/native-runtimes/:runtimeId/grant
```

Issuance validates `voice:use` plus the required orchestration scopes, verifies that the target is
current and accessible, and returns the raw token once. Realtime authority always names one exact
durable conversation ID. If no conversation exists, React creates it through the existing
authenticated conversation API before provisioning native authority. Grant issuance does not
create conversations or retain a second, open-ended target shape.

## Fresh Realtime

```text
POST /api/voice/native/realtime-sessions
POST /api/voice/native/realtime-sessions/:sessionId/webrtc-offer
POST /api/voice/native/realtime-sessions/:sessionId/close
```

1. Android sends the runtime ID, generation, and a client operation ID under the runtime grant.
2. T3 derives the session idempotency key and continues only the exact grant-bound conversation
   and focus.
3. T3 returns the normal session result and a session child grant.
4. Android prepares its native WebRTC peer and SDP offer.
5. The child grant exchanges the offer for an answer under exact session and lease fencing.
6. Android applies the answer; existing native heartbeat and handoff polling own liveness.

Native requests cannot choose takeover. A conflicting active lease returns a typed conflict that
requires foreground resolution. Repeated client operation IDs return the same live session and do
not create another provider call.

React reattachment adopts a matching native session. It stops a peer only when its environment,
conversation, session, lease, or runtime generation cannot be reconciled.

## Active Thread Operation

Use one durable `VoiceNativeThreadTurnOperation` for foreground and background Auto Listen. Native
captures and retains the finalized M4A until T3 acknowledges deterministic message dispatch.

```text
POST /api/voice/native/thread-turns
PUT  /api/voice/native/thread-turns/:operationId/audio
GET  /api/voice/native/thread-turns/:operationId/events
GET  /api/voice/native/thread-turns/:operationId/speech/:segmentIndex
POST /api/voice/native/thread-turns/:operationId/cancel
```

The first request accepts only the runtime ID, generation, and a client operation ID. It claims the
operation idempotently and returns a child operation token before any audio transfer. Retrying the
same create request returns the existing operation and rotates its child token; the server stores
only the current token hash. The upload request then accepts only bounded audio, media type, and
optional language under that child token. Project, thread, preset, and Auto Rearm come exclusively
from the runtime grant.

### Server flow

1. Claim the operation ID and processing lease idempotently.
2. Validate media using the existing duration, container, byte, quota, and concurrency policy.
3. Transcribe through `VoiceProviderRegistry`.
4. Derive deterministic command and message IDs from the operation identity.
5. Dispatch `thread.turn.start` using the thread's authoritative provider configuration.
6. Persist dispatch identity before reporting acceptance. A retry first reconciles deterministic
   IDs against projections and never retranscribes or redispatches accepted work.
7. Correlate the exact turn through `ProjectionTurnStartRepository` and normalized message
   projections.
8. Convert full assistant-text snapshots into stable phrase segments using one chunker in
   `packages/shared` used by both foreground React presentation and server operations.
9. Persist each immutable speech segment before advertising it. Native fetches and plays segments
   in order while the response is still streaming.
10. Mark the turn terminal independently from speech playback. A TTS failure cannot turn a
    successfully completed coding-agent turn into a failed turn.

T3 does not durably store raw audio or a spool path. Temporary request buffering is bounded and
deleted on every exit. If T3 fails before dispatch acceptance, Android retains and re-uploads the
recording under the same operation ID after the processing lease expires. After dispatch
acceptance, Android deletes the recording and recovery uses deterministic IDs and projections.

Transcript text is not duplicated in the operation journal after dispatch; the ordinary thread
message is authoritative. Stable speech segments may be retained only until operation expiry to
support ordered retry, then are deleted by bounded retention.

### Ordered events

Events use a monotonically increasing sequence and long polling. Content-bearing thread text is
rendered from ordinary projections; the native operation stream carries state, correlation IDs,
speech availability, and sanitized failures.

```text
created -> transcribing -> dispatching -> waiting -> speaking -> completed
                                           |          |
                                           +-> attention-required
                                           +-> failed
```

Events include:

- phase changes;
- message and turn correlation IDs;
- immutable `speech-ready` segment index and finality;
- an explicit speech-terminal signal, including an explicit no-speech terminal state, so coding
  turn completion never implies that delayed speech synthesis has finished;
- approval-required or user-input-required attention;
- terminal completion, cancellation, or typed retryable/permanent failure.

Native acknowledges an applied sequence. Snapshot plus events after the acknowledged sequence
close subscribe-before-snapshot and reconnect races.

## Native State And Recovery

Implement native delegates instead of adding network orchestration directly to
`T3VoiceRuntimeService`:

- Keystore-backed runtime credential store;
- strict HTTPS background client with redirects disabled and bounded bodies/streams;
- pure background voice reducer;
- Realtime starter;
- Active Thread operation coordinator and durable cursor store.

The thread state machine is:

```text
idle -> recording -> finalized -> uploading -> transcribing -> waiting
     -> playing -> playback-drained -> rearming
```

Stop is phase-aware. It may finish a manual recording into a draft only in the visible composer
flow; background Auto Listen stop cancels listening/playback and prevents rearm without cancelling
an already-dispatched coding-agent turn. Auto Rearm starts only after terminal response state, all
advertised speech drains, and the configured guard elapses.

Persist only encrypted grant material, operation identity, target generation, upload/dispatch
acknowledgement, event cursor, playback cursor, and a bounded terminal summary. Do not persist raw
audio outside the recorder's existing private file, transcript text, assistant text, SDP, or
provider data.

After Android process recreation, readiness is locked until the Keystore credential and server
generation validate. An in-flight thread operation resumes polling/playback. A live WebRTC peer
cannot survive process death; native starts a new provider call for the same durable conversation.

## React Reconciliation

On attachment React:

1. subscribes to native events;
2. reads the native operation snapshot;
3. replays events after its last acknowledged sequence;
4. correlates message and turn IDs with ordinary projections;
5. acknowledges applied native sequences;
6. adopts a matching Realtime session or presents a typed recovery state.

Foreground Auto Listen uses the same native/server operation. React must not enqueue a duplicate
outbox message, run its own response waiter, synthesize duplicate TTS, or pause the operation solely
because `AppState` becomes background. Existing composer dictation remains separate.

## Security And Failure Invariants

- Native operation origins must be HTTPS, contain no embedded credentials, query, or fragment, and
  must not redirect authenticated requests.
- Runtime and operation tokens are redacted alongside authorization headers.
- Logs contain only curated IDs, phases, counts, timings, and stable error codes. They never contain
  audio, transcripts, assistant text, speech segments, SDP, or tokens.
- Network loss never redispatches a coding turn. Native resumes from acknowledged operation/event
  cursors.
- Auth revocation prevents new work and access to undispatched operations. It does not interrupt a
  coding-agent turn already accepted by orchestration.
- At most one Active Thread operation runs per runtime generation.
- Permission loss, explicit Disable, target replacement, and stale generations converge to a
  coherent stopped or locked state and release media, focus, wake/Wi-Fi locks, and foreground
  ownership.

## Verification

- Exact contract round trips and rejection of excess/mixed fields.
- Token hashing, Keystore encryption, expiry, generation fencing, rotation, disable, and auth
  revocation.
- Fresh native Realtime create, idempotent retry, offer/answer, heartbeat, close, conflict, and
  foreground adoption.
- Thread upload validation, processing-lease recovery, duplicate upload, deterministic single
  dispatch, server restart before/after dispatch, ordered event replay, attention states,
  cancellation, and segment retry.
- Streaming TTS begins before the response completes and survives a retryable segment failure
  without changing turn completion.
- Android reducer/JVM tests cover every phase, Stop, network retry, stale event, duplicate segment,
  process snapshot, target replacement, and Auto Rearm only after drain.
- React tests cover subscribe-before-snapshot, replay/acknowledgement, projection correlation,
  matching Realtime adoption, and absence of duplicate submission/TTS.
- ADB validation covers screen off, React suspension, notification/headset start and stop,
  multi-cycle Auto Rearm, Wi-Fi interruption during upload/wait/playback, activity recreation,
  permissions, service restart, speaker/wired/Bluetooth routes, and Android 14/15 foreground-service
  restrictions.
- iOS and desktop adapters are not implemented or device-tested in this environment, but must be
  able to consume the same grant and operation contracts without Android-specific fields.

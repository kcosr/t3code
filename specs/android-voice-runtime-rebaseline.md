# Android Voice Runtime Rebaseline

Status: Accepted and implemented product and architecture contract. Release acceptance remains
governed by the repository, native, artifact, and connected-device gates below. This document
supersedes the Android ownership, process-death recovery, hands-free ownership, and
background-control direction in older voice milestone and workstream documents.

## Why this rebaseline exists

The current convergence work interpreted the Android voice runtime as a durable distributed state
machine that could reconcile ambiguous work and resume after Android process death. That is a
stronger requirement than the product needs.

The product needs Realtime and non-Realtime Thread voice interactions that continue while the user
moves the app between foreground and background. It also needs an explicit Realtime-to-Thread mode
switch initiated from either React UI or an Android notification action.
The React UI also lets the user resume a Realtime conversation while Thread voice is active; that
is the inverse native mode transition rather than a stop followed by a React-coordinated restart.

It does not need to resurrect an active voice session after Android terminates the application
process. Ordinary Activity foreground/background transitions and process termination are different
events: a foreground service can remain active when the Activity is backgrounded, but the service,
audio resources, sockets, and React Native runtime all disappear when their shared application
process is terminated.

The implementation history and current code were therefore evaluated against this narrower
requirement before the new branch was created.

## Authoritative product requirements

1. The app supports two native-owned voice modes:
   - Realtime, using the existing live voice transport and duplex audio path.
   - Thread, using recording, endpointing, upload/transcription, agent execution, and optional
     response playback.
2. React can start, control, observe, and stop either mode through a typed native interface.
3. Android notification and MediaSession actions use the same native command path as React.
4. Moving the Activity between foreground and background does not interrupt an active operation.
5. Recreating the Activity or remounting React presentation does not take ownership from the native
   runtime. React reads the current native snapshot when it reconnects.
6. An active native voice operation runs in an Android microphone foreground service with an
   appropriate persistent notification.
7. Realtime can switch to Thread mode through one serialized in-process transition.
8. Thread can switch to Realtime through one serialized in-process transition when the user resumes
   Realtime from the app.
9. Only one mode owns microphone, playback, audio focus, and routing resources at a time.
10. Failures are bounded, visible, and leave resources in a known state. The user can stop a failed
    operation from the UI or notification and then retry explicitly.
11. React/web parity is preserved through a platform-neutral semantic adapter and shared
    presentation behavior, not by retaining a second React-owned Android state machine.

## Explicit non-goals

Unless a later product decision adds them explicitly, the runtime does not support:

- resuming an active session after Android kills the application process;
- resuming across force-stop, reboot, application update, or native crash;
- durable multi-stage Realtime-to-Thread recovery;
- distributed Realtime-to-Thread prepare/commit/rollback semantics;
- restoring an ambiguous Realtime peer or recorder after process death;
- durable effect journals, generic compensation ledgers, or persisted timer ownership solely for
  process-death recovery;
- multiple simultaneous native voice owners;
- compatibility with obsolete native bridge revisions or legacy runtime shapes.

If the process terminates, the in-flight operation terminates. On the next application launch, the
runtime may clean up local temporary files and report that the prior session ended, but it does not
claim to resume that session.

## Resolved product decisions

- Background continuity covers Home/app switching, screen lock, Activity recreation, React
  detachment, and best-effort task removal while the application process and foreground service
  remain alive. `stopWithTask=false` keeps task removal from being an explicit stop, but it is not a
  process-survival guarantee.
- The complete Thread cycle remains native-owned in the background: recording, endpointing,
  transcription, ordinary thread dispatch, exact response waiting, optional speech playback, and
  configured rearming.
- Realtime-to-Thread uses the currently selected existing Thread, including its project, runtime
  mode, interaction mode, and voice settings. It does not create a Thread or copy the Realtime
  transcript into the Thread.
- The mode switch uses ordinary Realtime close and ordinary Thread dispatch contracts. There is no
  server-side mode-switch prepare/commit/rollback endpoint.
- Realtime notification controls are mute/unmute, switch to the prepared Thread target when one is
  available, and stop. Thread controls are finish utterance while recording, submit the current
  transcript while reviewing, and stop. MediaSession transport actions map to the same commands.
- Realtime control polling and Thread dispatch/outcome polling tolerate bounded transient network
  failures. Exhausted retries produce a sanitized failed snapshot and release live resources;
  retrying the product operation is explicit.
- Automatic endpointing and optional rearming are part of the Thread end state. Review versus
  auto-submit, response playback, endpoint windows, and timeouts are explicit settings.
- Realtime exposes native route selection. One-shot dictation and speech controls may retain their
  existing bounded APIs, but they share the same exclusive media-ownership gate.
- The persistent bottom call bar is exclusively the Realtime surface. While Thread voice owns the
  runtime, that bar shows the resumable Realtime conversation rather than Thread phase, transcript,
  finish, or stop controls. The Thread composer waveform owns Auto Listen state and controls; the
  adjacent microphone remains one-shot dictation into the draft without submission.
- A completed recording is deleted after its bounded transcription attempt, including failure or
  cancellation. A bounded startup sweep removes abandoned cache files; recordings are not retained
  as resumable work.

## Runtime shape

```text
React commands --------------------+
                                    |
Notification / MediaSession actions +--> Android voice foreground service
                                              |
                                              v
                                      serialized state machine
                                              |
                     +------------------------+------------------------+
                     v                        v                        v
               Realtime controller      Thread controller       media resources
               WebRTC / live API        record / upload /       mic / player /
                                        wait / playback          focus / routes
                                              |
                                              v
                                   snapshot and events to React
```

The foreground service owns one in-memory state machine. Its process-local controller serializes
commands and native callbacks. The implementation does not need a general-purpose effect runtime;
it needs explicit mode transitions and exact callback correlation for the small set of live
resources.

A representative top-level state is:

```text
Idle
Realtime(Starting | Connected | Stopping)
SwitchingToThread(ClosingRealtime | StartingRecorder)
SwitchingToRealtime(StoppingThread)
Thread(Starting | Recording | Finalizing | Transcribing | Reviewing |
       Submitting | Waiting | Playing | Rearming | Stopping)
Failed
```

Substates may carry operation IDs, target context, and resource handles outside the immutable
public snapshot. A monotonically increasing in-memory session generation is sufficient to reject
late callbacks from a previous mode. It does not need to be durable.

## Realtime-to-Thread mode switch

React and the notification invoke the same native `switchRealtimeToThread` entry point.

1. Admit the command only while Realtime owns the active session.
2. Enter `SwitchingToThread` immediately and update the notification/public snapshot.
3. Reject or coalesce duplicate switch commands while the transition is active.
4. Stop accepting new Realtime controls that conflict with shutdown.
5. Close the Realtime peer and live transport.
6. Wait for the exact peer/microphone release callback, with a bounded timeout.
7. Release or transfer audio focus and route ownership explicitly.
8. Start Thread recording using the selected Thread target and context.
9. Enter `Thread.Recording` and publish the new state.

If peer shutdown times out, release locally controllable resources and fail the transition while
retaining ownership until the peer actually exits. If Thread recording cannot start, end in `Idle`
or `Failed`, release all media resources, and allow an explicit retry. The runtime does not roll
back into Realtime and does not persist a mode-switch transaction for later recovery.

A bounded shutdown deadline may publish `Failed` before a blocking platform peer has fully exited.
That state releases audio focus, routing, wake lock, and ordinary controls, but retains the native
owner slot, foreground service, and Stop-only notification until the terminal worker reports exact
quiescence. Stop cannot publish `Idle`, and a new mode cannot start, while that drain is pending.

The server sees an ordinary Realtime close followed by ordinary Thread work. Conversation history
remains in its original durable Realtime conversation; no transition record or copied context is
needed for the mode switch.

## Thread-to-Realtime mode switch

Pressing Realtime Resume while Thread voice is active invokes the native
`switchThreadToRealtime` entry point with the selected durable Realtime conversation and a fresh
bounded native child credential.

1. React performs permission and credential preparation, then admits one typed command to the
   foreground service. React is not responsible for the transition after admission.
2. Android enters `SwitchingToRealtime.StoppingThread` and keeps the foreground service alive.
3. The Thread recorder, request, wait, or playback owner is stopped through its ordinary native
   stop path.
4. Android waits for the exact Thread release callback. Realtime cannot acquire the microphone,
   playback, focus, or route owner before that callback.
5. Android advances the process-local generation and starts Realtime with the already admitted
   target and credential.
6. Duplicate commands are coalesced. Stop during the transition cancels the pending Realtime start
   and reaches `Idle` after Thread release.

The Android notification continues to describe Thread voice while Thread resources are stopping,
then changes to Realtime when Realtime starts. Activity backgrounding or React detachment after
native admission does not interrupt the transition.

## Agent-initiated terminal Realtime actions

The Realtime agent may end the live interaction or request the same native Realtime-to-Thread mode
switch that React and the notification expose. These are terminal voice actions, not general tool
calls that produce another assistant response.

The end-state tool contract is:

| Tool                     | Meaning                                                                       | Arguments        |
| ------------------------ | ----------------------------------------------------------------------------- | ---------------- |
| `activate_thread`        | Navigate or focus an existing Thread while Realtime continues.                | Exact Thread ID. |
| `stop_realtime_voice`    | End Realtime and return the native runtime to `Idle`.                         | None.            |
| `switch_to_thread_voice` | End Realtime and start Thread voice for the currently prepared Thread target. | None.            |

`activate_thread` remains a non-terminal client action with an acknowledged success or failure. It
does not transfer microphone ownership or change voice modes. `switch_to_thread_voice` is a distinct
terminal action and uses the complete native `threadSwitch` target and settings already held by the
active Realtime state. The model does not reconstruct project, runtime, model, interaction, or voice
settings. The switch tool is available only when a prepared target exists.

The implementation uses the new end-state names directly. It does not restore
`handoff_to_thread_voice`, add a compatibility alias, or describe the in-process switch as a durable
handoff.

### Provider and native ordering

For either terminal tool, the model may speak one brief completion or transition sentence. That
sentence must precede the tool call, and the tool call must be the final output action. Provider
instructions explicitly prohibit speech after the terminal call. A suitable switch sentence is
"I'm switching you to the voice thread now; go ahead and continue there." It must not claim that
the switch already completed.

The terminal sequence is:

1. The model emits the brief final speech and then calls the terminal tool.
2. The server submits a deterministic function-call result and waits for the provider to
   acknowledge it. It does not issue `response.create` or otherwise invite another response.
3. The server publishes one sequenced terminal action to the owning client. Session ID, lease
   generation, event sequence, and a bounded deterministic action ID make duplicate delivery
   harmless.
4. Android admits the action only for the current Realtime generation, immediately enters the
   stopping or switching state, and fences microphone input so no new user audio reaches the model.
5. Android drains already queued WebRTC playout before closing the peer.
6. Stop closes Realtime and proceeds to `Idle`. Switch closes Realtime and invokes the existing
   native `SwitchingToThread` transition with the prepared target and settings.

React does not acknowledge, adopt, or coordinate either terminal transition. It observes the native
snapshot if attached. The same behavior therefore works while the Activity is backgrounded or
React is detached, provided the application process and foreground service remain alive.

### Realtime playout drain

The function call can reach the server and Android before previously generated speech has finished
playing on the device. Closing the peer immediately would truncate the final sentence, so the
WebRTC session maintains a process-local PCM playout activity monitor for its lifetime.

After a terminal action is admitted:

- microphone input is fenced before waiting for playback;
- playout is considered drained after approximately 400 milliseconds without an audible PCM
  sample;
- the policy is evaluated approximately every 100 milliseconds;
- five seconds from native admission is the absolute drain deadline; and
- reaching the deadline records a privacy-safe diagnostic and continues teardown rather than
  leaving the voice owner stuck.

Five seconds is a fail-safe, not a fixed delay. Ordinary speech transitions as soon as its queued
playout finishes and the silence window elapses. A provider/session close or exact playout
termination may complete the drain sooner. The server's last-resort provider termination deadline
must exceed the native five-second drain plus normal terminal-action delivery margin so it does not
cut off healthy playback.

### Failure and ownership rules

- A terminal action is idempotent for its session generation and action ID. Replayed polling
  results cannot start a second recording or close a replacement session.
- If the prepared Thread target disappears before the switch is admitted, the runtime does not
  guess or synthesize settings. It closes Realtime and publishes a sanitized failed switch outcome
  that permits an explicit retry.
- Once a terminal action is admitted, conflicting Realtime controls and additional terminal actions
  are rejected or coalesced through the existing serialized native controller.
- A drain timeout permits teardown but does not weaken the exact native quiescence rule: Thread
  recording still cannot start until the Realtime peer and microphone owner have released.
- Failure to start Thread after Realtime closes follows the existing switch failure semantics; it
  does not roll back into Realtime.
- Provider-side fallback termination is bounded and exists only to clean up an abandoned session.
  Under normal operation, the native client closes the ordinary Realtime session after its playout
  drain.

The reusable donor behavior comes from `3ce4c4bec` (playout monitoring and drained switch),
`9eea7d8b9` (input fencing), and `e7fbca373` (terminal stop and provider completion). Those commits
are design donors rather than cherry-pick units because they also depend on the discarded durable
handoff and React adoption topology.

This design intentionally does not restore handoff database rows, native-control grants, heartbeat
handoff state, React recording adoption or acknowledgement, pending-handoff restore, process-death
recovery, or server-side prepare/commit/rollback routes.

## Android lifecycle contract

- The user starts microphone work from a visible Activity so Android foreground-service and
  microphone permission rules can be satisfied.
- The service promotes itself promptly and remains active after `Activity.onStop`.
- React detachment, navigation, or Activity recreation does not stop the session.
- React attachment reads a complete current snapshot before consuming subsequent events.
- The foreground notification exposes only controls valid for the current state.
- A failed operation retains a Stop-only foreground notification until native ownership has
  quiesced; failure never implies that media ownership was already released.
- The service stops itself after returning to `Idle` and completing bounded cleanup.
- The service declares `stopWithTask=false`; task removal is tested as best-effort continuity while
  the process remains alive. Force-stop and process termination remain non-recoverable.
- A sticky service restart must not pretend that an old socket, WebRTC peer, or recorder survived.
  Unless a concrete non-session task requires restart, non-sticky behavior is preferable.

## Persistence boundary

Persistence is allowed for product data that is useful independently of session resurrection:

- user voice settings and preferred route;
- durable Thread/agent records already required by the server contract;
- bounded temporary recording files until upload, acknowledgement, or cleanup;
- privacy-safe diagnostics needed during validation and later troubleshooting.

Persistence should not model a live peer, live recorder, in-flight callback, active timer, or
partially completed local mode switch. On fresh process startup, the native runtime starts in
`Idle`.

## Native interface

The platform-neutral semantic interface exposes:

- `getSnapshot()` and `subscribe(listener)`, where subscription delivers one complete current
  snapshot before subsequent publications;
- `startRealtime(target)`;
- `startThread({ target, settings })`;
- `switchRealtimeToThread({ target, settings })`;
- `switchThreadToRealtime(target)`;
- `stop()`;
- `setRealtimeMuted(muted)`;
- `setRealtimeAudioRoute(routeId)`;
- `updateRealtimeContext({ focus, threadSwitch })`;
- Realtime confirmation and client-action completion controls;
- `finishThreadRecording()`;
- `updateThreadReviewTranscript({ generation, reviewId }, transcript)`; and
- `submitThreadTranscript({ generation, reviewId }, transcript)`.

The generation plus per-cycle review ID fences delayed edits and Submit actions even when automatic
rearming keeps the same top-level generation. Initial Realtime and Thread starts share one React
admission gate and one serialized Android command queue, including permission checks, traditional
media interruption, credential issuance, and native admission. A losing concurrent start does not
interrupt media or mint a child credential.

Commands are typed and serialized within the live process. The bridge does not need durable command
replay after process termination. Obsolete bridge methods are deleted rather than retained as
aliases.

## History and baseline decision

The history investigation selected `f83577b035592feec1b772ded9f0e73f3625422d`
(`fix(voice): distinguish diagnostic copy failures`) as the implementation base. At that revision,
the application had the working React-owned foreground Realtime and Thread/Auto Listen flows plus
the hardened recorder, endpoint detector, PCM player, WebRTC peer, audio focus/routes, bounded media
server APIs, and foreground-service host needed as reusable primitives.

The later topology is intentionally donor-only:

```text
f83577b03  working foreground Realtime + Thread behavior and native media primitives
    |
    +-- feature/voice-kernel-m1             durable-kernel migration
            +-- debug/realtime-trace        temporary offer/ICE instrumentation
            +-- feature/voice-kernel-convergence
                                             revision-19 durable convergence
```

The kernel branches contain useful fixes and tests, particularly around WebRTC shutdown, bounded
network lanes, notification/MediaSession rendering, callback fencing, and privacy-safe diagnostics.
Their journals, elections, recovery workflows, legacy mode-switch transactions, and process-death
authority model are not implementation ancestry for this runtime.

No production backend contract requires a durable Realtime-to-Thread mode-switch protocol. Native
Thread mode does require two small server seams: a bounded, scoped native child session and an exact
thread-message outcome query. Both support ordinary live-process work and do not introduce recovery
authority.

## Implemented lineage and server seams

The rebaseline reuses the proven recorder, PCM player, audio-focus/routes, WebRTC peer, bounded
network lanes, foreground notification/MediaSession host, strict bridge validation, and privacy-safe
diagnostic ring from the selected baseline and inspected donor work. Durable recovery workflows,
legacy mode-switch journals, authority migration transactions, persisted retry timers, generic
compensation, and consumer election were not imported.

Native background work uses two general server seams:

- `POST /api/voice/native-session` issues a bearer child with exactly `voice:use`,
  `orchestration:read`, and `orchestration:operate`. Its lifetime is the lesser of 12 hours and
  the parent session's remaining lifetime. A child cannot issue another child, and the response is
  non-cacheable.
- `GET /api/orchestration/threads/:threadId/messages/:messageId/turn` validates the exact
  dispatched user message and thread. It reports `pending`, `running`, `approval-required`,
  `user-input-required`, `completed`, `interrupted`, `failed`, or `ambiguous`, with the
  correlated turn ID and at most 32,000 characters of settled assistant text.

Thread dispatch retries preserve the same command and message identifiers. Outcome polling never
redispatches an accepted turn. Native code uses its child bearer to request one-use transcription
and speech tickets while React is detached; traditional one-shot React dictation and playback
continue to request their own media tickets.

## Acceptance criteria

The lean runtime is complete when device tests prove:

1. React starts and stops Realtime and Thread operations.
2. Pressing Home, switching apps, locking/unlocking the screen, and returning to the Activity do not
   interrupt an active supported operation.
3. React remount reads the correct native state without creating a second owner.
4. Notification actions operate without React being mounted.
5. Notification and React commands cannot create overlapping microphone owners.
6. Realtime-to-Thread switching closes the peer before starting the recorder.
7. Duplicate switch taps do not start duplicate recordings.
8. Realtime Resume while Thread voice is active waits for exact Thread quiescence, then starts one
   Realtime session even if React detaches after admission.
9. The bottom call bar renders only Realtime state; Thread Auto Listen remains controlled by the
   composer waveform, and composer microphone dictation remains one-shot draft capture.
10. Slow or failed peer shutdown reaches a bounded, resource-safe outcome.
11. Permission denial, audio-focus loss, route loss, network failure, and user cancellation release
    resources and produce an understandable state.
12. Thread recording/upload/waiting/playback behavior matches the last known-good foreground UX.
13. No live operation is claimed after deliberate process termination and relaunch.
14. Temporary tracing is removed after the traced device pass, followed by a clean rebuild and
    affected-device revalidation.
15. Agent stop speech remains audible through its final sentence, then Realtime reaches `Idle`
    without another provider response.
16. Agent switch speech remains audible through its final sentence, then exactly one prepared
    Thread recording starts after the Realtime owner quiesces.
17. Terminal action admission fences microphone input immediately; speech or noise during the
    playout drain is not sent as a new Realtime turn.
18. Silent, actively playing, already closed, duplicated, and five-second-timeout drain paths all
    reach their bounded native outcome.
19. Agent stop and switch work while React is detached and the Activity is backgrounded, and a
    later React remount observes the resulting native snapshot.

Repository-required typecheck, lint, native compilation, unit tests, instrumented-source
compilation, APK inspection, signing verification, and in-place installation remain release gates.

## Release verification

Delivery requires:

1. Run focused TypeScript/server and Android unit tests, native compilation, `vp check`,
   `vp run typecheck`, `vp run lint:mobile`, and `vp test`.
2. Commit and push the complete implementation before producing release artifacts.
3. Build the server and preview Android client from the same committed SHA.
4. Inspect the APK package, signature, archive contents, and checksum before installation.
5. Install in place and exercise Realtime, Thread, background/return, React remount, notification,
   MediaSession, permission/focus loss, user-initiated and agent-initiated stop, and user-initiated
   and agent-initiated Realtime-to-Thread mode switches, plus user-initiated Thread-to-Realtime
   switching, on the connected device.
6. Use temporary privacy-safe milestone tracing for the first Realtime device pass, then delete only
   that temporary milestone layer, rerun affected gates, rebuild, reinstall, and revalidate. The
   bounded generic diagnostic ring remains for troubleshooting.

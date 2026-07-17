# Android Voice Runtime Rebaseline

Status: Proposed product and architecture rebaseline. Investigation is required before implementation
resumes. This document is intentionally narrower than `native-voice-runtime-kernel.md` and should
not yet be treated as a claim about what the current tree implements.

## Why this rebaseline exists

The current convergence work interpreted the Android voice runtime as a durable distributed state
machine that could reconcile ambiguous work and resume after Android process death. That is a
stronger requirement than the product needs.

The product needs Realtime and non-Realtime Thread voice interactions that continue while the user
moves the app between foreground and background. It also needs an explicit Realtime-to-Thread mode
switch initiated from either React UI or an Android notification action.

It does not need to resurrect an active voice session after Android terminates the application
process. Ordinary Activity foreground/background transitions and process termination are different
events: a foreground service can remain active when the Activity is backgrounded, but the service,
audio resources, sockets, and React Native runtime all disappear when their shared application
process is terminated.

Before more work lands, the implementation history and current code must be evaluated against this
narrower requirement.

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
8. Only one mode owns microphone, playback, audio focus, and routing resources at a time.
9. Failures are bounded, visible, and leave resources in a known state. The user can retry from the
   UI or notification where appropriate.

## Explicit non-goals

Unless a later product decision adds them explicitly, the runtime does not support:

- resuming an active session after Android kills the application process;
- resuming across force-stop, reboot, application update, or native crash;
- durable multi-stage handoff recovery;
- distributed handoff prepare/commit/rollback semantics;
- restoring an ambiguous Realtime peer or recorder after process death;
- durable effect journals, generic compensation ledgers, or persisted timer ownership solely for
  process-death recovery;
- multiple simultaneous native voice owners;
- compatibility with obsolete native bridge revisions or legacy runtime shapes.

If the process terminates, the in-flight operation terminates. On the next application launch, the
runtime may clean up local temporary files and report that the prior session ended, but it does not
claim to resume that session.

## Proposed runtime shape

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

The foreground service owns one in-memory state machine. A `HandlerThread`, actor, or single
coroutine dispatcher may serialize commands and native callbacks. The implementation does not need
a general-purpose effect runtime; it needs explicit mode transitions and exact callback correlation
for the small set of live resources.

A representative top-level state is:

```text
Idle
Realtime(Starting | Connected | Stopping)
SwitchingToThread(ClosingRealtime | StartingRecorder)
Thread(Recording | Finalizing | Uploading | Waiting | Playing | Stopping)
Failed
```

Substates may carry operation IDs, target context, and resource handles outside the immutable
public snapshot. A monotonically increasing in-memory session generation is sufficient to reject
late callbacks from a previous mode. It does not need to be durable.

## Realtime-to-Thread transition

The handoff is equivalent to a native mode-switch command. React and the notification invoke the
same `switchRealtimeToThread` entry point.

1. Admit the command only while Realtime owns the active session.
2. Enter `SwitchingToThread` immediately and update the notification/public snapshot.
3. Reject or coalesce duplicate switch commands while the transition is active.
4. Stop accepting new Realtime controls that conflict with shutdown.
5. Close the Realtime peer and live transport.
6. Wait for the exact peer/microphone release callback, with a bounded timeout.
7. Release or transfer audio focus and route ownership explicitly.
8. Start Thread recording using the selected Thread target and context.
9. Enter `Thread.Recording` and publish the new state.

If peer shutdown times out, force local resource release and either continue when safe or fail the
transition. If Thread recording cannot start, end in `Idle` or `Failed`, release all media resources,
and allow an explicit retry. The runtime does not roll back into Realtime and does not persist a
handoff transaction for later recovery.

The investigation must determine what conversational context the server needs for this switch. A
server request that records the transition may still be necessary, but it should not turn the local
mode switch into a process-death-recoverable distributed transaction unless the backend contract
truly requires that guarantee.

## Android lifecycle contract

- The user starts microphone work from a visible Activity so Android foreground-service and
  microphone permission rules can be satisfied.
- The service promotes itself promptly and remains active after `Activity.onStop`.
- React detachment, navigation, or Activity recreation does not stop the session.
- React attachment reads a complete current snapshot before consuming subsequent events.
- The foreground notification exposes only controls valid for the current state.
- The service stops itself after returning to `Idle` and completing bounded cleanup.
- `onTaskRemoved` and device-specific swipe-away behavior must be tested and assigned an explicit
  policy. Force-stop and process termination remain non-recoverable.
- A sticky service restart must not pretend that an old socket, WebRTC peer, or recorder survived.
  Unless a concrete non-session task requires restart, non-sticky behavior is preferable.

## Persistence boundary

Persistence is allowed for product data that is useful independently of session resurrection:

- user voice settings and preferred route;
- durable Thread/agent records already required by the server contract;
- bounded temporary recording files until upload, acknowledgement, or cleanup;
- privacy-safe diagnostics needed during validation.

Persistence should not model a live peer, live recorder, in-flight callback, active timer, or
partially completed local mode switch. On fresh process startup, the native runtime starts in
`Idle`.

## Native interface direction

The exact API should be derived from current callers, but the end state should resemble:

- `getSnapshot()`
- `startRealtime(target)`
- `startThread(target)`
- `switchRealtimeToThread(threadTarget)`
- `stop()`
- `setRealtimeMuted(muted)`
- Thread completion/cancellation controls required by the existing UX
- one state/event subscription

Commands should be typed and idempotent for duplicate delivery within the live process. The bridge
does not need durable command replay after process termination. Obsolete bridge methods should be
deleted rather than retained as aliases.

## Investigation required before choosing a base branch

`main` is not a usable implementation baseline because it contains no voice feature. Do not start
from `main` under the assumption that foreground voice can be validated there.

The history investigation must identify:

1. The last commit where foreground Realtime voice worked.
2. The last commit where foreground Thread recording/interaction worked.
3. Whether both modes worked together at one revision.
4. The commit immediately before native-kernel migration began changing ownership.
5. Which Realtime offer/ICE, recording, playback, authentication, and server-contract fixes landed
   later and must be preserved.
6. Which current native components are independently reusable without importing the durable kernel.
7. Whether any backend endpoint currently requires durable authority, handoff prepare/commit, or
   consumer-election semantics, and whether that requirement is real product behavior or migration
   scaffolding.
8. Which tests describe current user-visible behavior versus the stronger superseded architecture.

The investigation should produce a small branch/commit topology, a reusable-component inventory,
and a recommendation between two options:

- branch from the last known-good foreground voice revision and port selected native components;
- retain the current native media/service work but replace its orchestration wholesale with the
  lean state machine.

The decision must be based on dependency boundaries and working behavior, not on preserving the
largest amount of already-written code.

## Likely reusable work

The current convergence branch should be treated as a donor and reference. Candidates for reuse,
subject to code inspection and focused tests, include:

- recorder, player, PCM, audio-focus, and audio-route implementations;
- WebRTC peer creation, offer/answer, ICE, mute, and shutdown fixes;
- bounded network execution that prevents speech playback from blocking control work;
- foreground notification, MediaSession, permission, and service-host rendering;
- React UI and server integration from the last working foreground implementation;
- strict native bridge input validation;
- privacy-safe Realtime tracing through the first successful device connection;
- resource-construction and teardown tests.

Work that should not be imported merely because it exists includes durable recovery workflows,
handoff journals, authority migration transactions, persisted retry timers, generic effect
compensation, consumer election, and abstractions whose only purpose is process-death recovery.

## Questions the investigation must resolve

- Does "background" include swiping the task away, or only Home/app switching/screen lock?
- Must Thread recording, server waiting, and response playback all continue in the background?
- Does Realtime-to-Thread switching create a new Thread, select an existing Thread, or carry
  context from the Realtime conversation?
- Is a server-side handoff endpoint required, or can the service stop Realtime and issue a normal
  Thread start?
- Which notification actions are required in each mode?
- What should happen on temporary network loss while the process remains alive?
- Is automatic Thread endpointing/rearming required in the first end state?
- Which voice cues and route-selection controls are required?
- What local recording retention is necessary if upload fails while the process remains alive?

These are product choices. They should be answered before architecture is inferred from legacy
code or historical milestone documents.

## Acceptance criteria

The lean runtime is complete when device tests prove:

1. React starts and stops Realtime and Thread operations.
2. Pressing Home, switching apps, locking/unlocking the screen, and returning to the Activity do not
   interrupt an active supported operation.
3. React remount reads the correct native state without creating a second owner.
4. Notification actions operate without React being mounted.
5. Notification and React commands cannot create overlapping microphone owners.
6. Realtime-to-Thread switching closes the peer before starting the recorder.
7. Duplicate handoff taps do not start duplicate recordings.
8. Slow or failed peer shutdown reaches a bounded, resource-safe outcome.
9. Permission denial, audio-focus loss, route loss, network failure, and user cancellation release
   resources and produce an understandable state.
10. Thread recording/upload/waiting/playback behavior matches the last known-good foreground UX.
11. No live operation is claimed after deliberate process termination and relaunch.
12. Temporary tracing is removed after the traced device pass, followed by a clean rebuild and
    affected-device revalidation.

Repository-required typecheck, lint, native compilation, unit tests, instrumented-source
compilation, APK inspection, signing verification, and in-place installation remain release gates.

## Proposed work sequence

1. Freeze and preserve the current convergence work; do not merge it as the product end state.
2. Complete the git-history and reusable-component investigation above.
3. Review this rebaseline and answer the unresolved product questions.
4. Select the exact voice-capable base revision and create a clean implementation branch.
5. Restore or retain the working foreground UX and server integration.
6. Implement the small native foreground-service state machine and React attachment contract.
7. Integrate Realtime, then Thread, using reusable low-level components.
8. Implement the sequential Realtime-to-Thread transition.
9. Delete superseded orchestration and compatibility shapes rather than carrying both designs.
10. Run focused tests, repository gates, APK verification, and the connected-device matrix.
11. Remove temporary tracing, rebuild, reinstall, and revalidate.

Implementation should not resume merely by simplifying names or splitting the existing durable
kernel into more files. The first deliverable is evidence identifying the correct voice-capable
baseline and the minimum native ownership boundary required by these product requirements.

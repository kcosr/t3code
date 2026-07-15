# Traditional Agent Voice Interaction

## Scope

This document describes voice input and spoken-response behavior for ordinary
asynchronous T3 threads. It does not describe the OpenAI Realtime voice agent.

The target interaction supports both deliberate push-to-record use and an
optional conversational mode that automatically detects the end of an
utterance and rearms recognition after the agent's spoken response finishes.

## Current T3 Behavior

Composer dictation is currently a manual, batch-oriented flow:

1. The user presses the microphone button.
2. Android records mono AAC audio into a temporary M4A file with
   `MediaRecorder`.
3. The user presses stop.
4. The mobile client requests a media ticket and uploads the completed file.
5. T3 streams transcription events into the composer draft.

The audio recording is not streamed while the user is speaking. Transcription
does not begin until the recording has been explicitly stopped and finalized.

Relevant implementation:

- `apps/mobile/src/features/voice/useComposerDictation.ts`
- `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/T3VoiceRecorder.kt`

## Assistant Behavior To Preserve

The Assistant Android application implements a more conversational recognition
cycle. Its native service captures PCM with `AudioRecord`, streams chunks to a
voice adapter, and supplies configurable endpoint-detection timing. Its default
recognition end-silence interval is 1,200 milliseconds.

The useful product behavior is:

- Recognition can be started manually at any time.
- Silence after detected speech finalizes the utterance after a grace period.
- Auto Listen is an explicit, persisted toggle.
- When Auto Listen is enabled, recognition rearms only after TTS playback has
  completely drained.
- Pressing the microphone while audio is playing interrupts playback and starts
  recognition.
- Manual controls override automated transitions.
- Start, completion, and end-silence timeouts are independently configurable.
- Recognition cues and state changes make arming and completion observable.

Rearming after playback drain is important. Rearming merely when the textual
response completes can capture the application's own TTS output.

Relevant reference implementation:

- `packages/mobile-web/android/app/src/main/java/com/assistant/mobile/voice/AssistantVoiceRuntimeService.java`
- `packages/mobile-web/android/app/src/main/java/com/assistant/mobile/voice/AssistantVoiceConfig.java`

## Interaction Model

Traditional agent voice should be modeled as an explicit state machine rather
than a series of UI callbacks:

```text
idle
  -> arming
  -> recording
  -> finalizing
  -> transcribing
  -> ready-to-send or sending
  -> awaiting-agent
  -> playing-tts
  -> idle or arming
```

Recording may terminate for one of these reasons:

```text
manual-stop
speech-then-silence
maximum-duration
cancelled
capture-error
```

Auto Rearm controls only the `playing-tts -> arming` transition. It must not
change how ordinary thread submission, agent execution, or TTS completion is
reported.

The initial Auto Rearm control should be a persisted quick toggle near the
normal microphone control. Its enabled state must remain visible while the
feature is active and must not be conflated with Realtime voice state.

## Recommended First Implementation

Add native automatic endpoint detection while retaining the existing M4A
upload and transcription flow.

Android can periodically sample `MediaRecorder.getMaxAmplitude()` while the
existing recorder continues writing the full utterance. The endpoint detector
should track:

- An adaptive ambient-noise floor.
- A speech-start threshold above that floor.
- A minimum amount of detected speech before automatic finalization is allowed.
- A post-speech silence grace interval, initially 1,200 milliseconds.
- A maximum recording duration.
- A minimum viable recording duration to avoid invalid M4A finalization.

No automatic stop should occur before speech has been detected. The recorder
already captures from the time it is armed, so this approach retains audio that
precedes the speech threshold without requiring a separate pre-roll buffer.

The native layer should report a typed termination reason to the JavaScript
controller. JavaScript should then use the same stop, upload, transcription,
and cleanup path for both manual and silence-driven completion.

Endpoint-detection settings should have conservative defaults. Detailed tuning
controls can remain outside the primary composer UI, but the underlying values
should not be hard-coded into UI components.

## Auto Rearm

Auto Rearm is a separate layer above endpoint detection. A complete automatic
cycle is:

```text
record
  -> detect endpoint
  -> transcribe
  -> submit message
  -> await final agent response
  -> stream and play TTS
  -> wait for playback drain
  -> rearm recognition
```

Auto Rearm must stop rather than loop when:

- The user disables it.
- Recognition or transcription fails.
- Message submission fails.
- The agent run is cancelled or fails.
- TTS playback fails or is explicitly stopped.
- The app loses the required microphone or audio-focus capability.
- The active thread or environment changes without an intentional handoff.

The UI should expose the failure and return to a stable manual state. It should
not retry indefinitely without user action.

## Background Voice Modes

The persistent Android voice experience should support two explicit targets:

- **Voice agent** keeps or resumes the global realtime voice session.
- **Active thread** runs endpoint detection, transcription, message submission,
  streamed response handling, TTS playback, and optional Auto Rearm against the
  selected thread.

The foreground notification should expose the current target and allow the user
to switch targets without first reopening the application. The selected mode,
environment, active thread, output route, TTS preference, and rearm policy must
be durable device state rather than properties of the currently mounted screen.

Only one microphone pipeline may own the device at a time. Switching to Active
thread mode must stop or suspend the realtime WebRTC pipeline before starting
batch recognition. Switching to Voice agent mode must stop Auto Rearm and any
batch recording before establishing or resuming realtime. Remaining in Voice
agent mode should preserve a healthy realtime session rather than reconnecting
for every notification interaction.

The native foreground service can reliably own microphone capture, WebRTC,
audio focus, endpoint detection, and playback while the app is backgrounded.
It must not depend on the React runtime remaining alive for thread submission:
Android may suspend or destroy JavaScript after the UI is backgrounded. Robust
Active thread mode therefore needs a server-backed background operation. The
native service should submit the finalized recording through an authenticated,
background-capable client; T3 should transcribe it, submit it to the persisted
thread target, stream the response, and provide audio for native playback.

Notification controls should be state-specific. At minimum they should expose
the current mode, switch mode, pause or resume listening where applicable, and
stop voice. Headset and media-button behavior should use the same state machine
and commands rather than maintaining a separate control path.

Recommended implementation order:

1. Complete native endpoint detection and exactly-once local finalization.
2. Define and persist `off | realtime | thread` as the native voice mode.
3. Persist the environment/thread target, route, TTS, and rearm preferences.
4. Add notification mode selection and state-specific actions.
5. Add the server-backed thread-mode operation that does not require React.
6. Add headset/media-button controls and lifecycle recovery tests.

## Future Streaming Architecture

A later implementation may replace batch recording with streaming STT through
T3:

1. Native clients capture PCM frames with `AudioRecord` or the platform
   equivalent.
2. The authenticated client streams bounded audio frames to T3.
3. T3 routes the stream to the selected transcription provider.
4. Partial and final transcript events return over the session protocol.
5. Server-side or provider-side VAD produces speech-start and speech-end events.
6. The client applies a short finalize timer so adjacent final segments become
   one submitted message.

Streaming would provide partial transcripts, lower post-speech latency,
centralized VAD tuning, and a common provider abstraction for Android, iOS, web,
and desktop. It also introduces materially more protocol and operational work:

- Media authentication and short-lived authorization.
- Frame limits, duration limits, and backpressure.
- Cancellation and idempotent finalization.
- Reconnect behavior and partial-stream failure semantics.
- Provider lifecycle management.
- Privacy-safe diagnostics and resource accounting.

Streaming is therefore not required for the first silence-driven experience.
The state machine and typed endpoint reasons should be designed so that a
streaming recorder can replace the batch recorder without changing the
user-facing interaction model.

## Initial Acceptance Criteria

- Manual start and stop continue to work as they do today.
- After speech begins, sustained silence automatically finalizes the recording.
- Ambient silence before speech does not immediately stop recording.
- Automatic and manual finalization share one upload and transcription path.
- Auto Rearm is persisted and can be toggled quickly.
- Auto Rearm starts only after TTS playback has drained.
- Manual microphone input can interrupt TTS and begin a new utterance.
- Failures return the interaction to a stable manual state without an automatic
  retry loop.
- Endpoint reason and timing diagnostics contain no transcript or recorded
  audio content.
- Bluetooth, speaker, wired-headset, background, and audio-focus transitions
  have explicit test coverage before hands-free operation is considered stable.

## Addendum: Realtime Reasoning Effort Settings

Explore making reasoning effort configurable in the client UI for the OpenAI
Realtime voice agent. This is separate from the traditional asynchronous voice
flow described above, but belongs in the broader voice interaction planning.

The control should live in a dedicated settings surface that can pop out from
the Realtime voice experience in the same way that Realtime conversation
history does today. The current effort should remain easy to inspect without
overloading the primary call controls.

The settings surface should expose the reasoning-effort values supported by the
active Realtime model and explain the latency, token-usage, and capability
tradeoff. OpenAI currently supports `minimal`, `low`, `medium`, `high`, and
`xhigh` for `gpt-realtime-2.1`, and recommends starting with `low` for most
production voice agents.

Reasoning effort can be changed during an active call through a Realtime
`session.update`; a call restart is not required. The UI and session controller
should apply changes between responses, wait for `session.updated` before
showing the new value as active, and preserve the previous value if the update
is rejected.

Exploration should resolve whether the selection is a device-wide preference,
a per-conversation preference, or an active-call override; whether it persists
across calls; and how model-specific supported values and defaults are
represented. T3 should send an explicit effort rather than depend on an
undocumented provider default so call behavior remains predictable.

### Tool Preambles and Prompt Caching

The user also wants to discuss whether spoken tool-call preambles should be
configurable from this settings surface. Realtime currently may speak a
commentary message before each tool call, which can add substantial perceived
latency when a response requires several fast serial tool calls. A possible UI
control could choose between spoken tool progress and immediate silent tool
execution, while preserving any separate speech required for confirmation or
other safety-sensitive interactions.

This is an exploration note, not a direction to change the current prompt.
OpenAI exposes no dedicated preamble switch; the behavior is controlled through
session instructions and commentary-channel guidance. Realtime instructions
can be replaced during an active call with `session.update`, but OpenAI notes
that instructions and tool definitions are at the beginning of the cached
conversation prefix. Changing them mid-session reduces the prompt-cache rate
for subsequent responses.

Consider this tradeoff together with context compaction and cache-preserving
truncation. The design should determine whether a preamble preference is fixed
when a call starts, mutable with an acknowledged cache cost, or represented in
some other way. Cache telemetry should be part of evaluating the options rather
than assuming a UI toggle is operationally free.

Realtime also permits later `system` conversation items. OpenAI's context
summarization example uses a system item to insert a compacted summary and notes
that it may contain additional custom instructions. This offers another
mechanism for changing model guidance without replacing the session's
`instructions` field. Appending an item extends the conversation without
rewriting the existing prefix, unlike changing the initial instructions. The
relative instruction priority, persistence, compaction behavior, and measured
cache impact of both mechanisms should still be tested before choosing one for
a preamble toggle.

One implementation direction is to treat the client-visible behavioral
settings as a versioned agent-instruction state. At call creation, T3 would
store the canonical settings snapshot represented by the initial session
instructions, together with a stable checksum and monotonic revision. UI
changes would update the desired snapshot without immediately rewriting the
session instructions.

Before the next user message is committed, the session controller would compare
the desired checksum with the last applied checksum. If they differ, it would
append one `system` conversation item containing the complete current
behavioral-settings snapshot and an explicit statement that this revision
supersedes earlier runtime-settings items. After the provider acknowledges the
item, T3 would advance the applied revision and then allow the user turn to
proceed. This provides a deterministic turn boundary, avoids duplicate updates
across retries, and leaves the original cached prompt prefix intact.

Use the monotonic revision and canonical checksum for ordering and idempotency;
a timestamp may be included for diagnostics but should not decide which
settings win. The design must also specify how these control items are
journaled, replayed into a continued call, protected from ordinary history
search or user-authored content, and retained or regenerated during compaction.
Only settings that affect model instructions belong in this mechanism;
transport and media preferences should remain ordinary client or session
state.

# Desktop Voice Design Notes

## Status

Deferred design exploration. Android remains the current implementation priority.

## Objective

Bring T3's existing voice facilities to the Electron desktop application without
creating separate Windows, Linux, and macOS voice stacks:

- Non-realtime dictation and transcription
- Streaming text-to-speech
- Realtime voice conversations
- TTS-to-microphone interruption
- Auto Listen
- Audio device preferences and privacy-safe diagnostics
- Optional headset and background controls where desktop platforms support them

## Architectural Direction

The server-side voice facilities are already platform-neutral. Desktop should
reuse the existing transcription, streaming TTS, realtime session, persistence,
context replay, tool, and diagnostic services.

The main client-side obstacle is that the current mobile voice controllers depend
directly on `@t3tools/mobile-voice-native`. Extract a platform-neutral client
interface, tentatively named `VoiceMediaRuntime`, and provide platform adapters:

- Android: the existing Expo native module
- Desktop: Chromium media APIs exposed inside Electron
- iOS: a future native implementation behind the same interface

The shared runtime contract should cover:

- Microphone permission and acquisition
- Bounded recording and endpoint events
- Streaming PCM playback and cancellation
- Mutually exclusive recording, playback, and realtime ownership
- Realtime WebRTC preparation, answer application, muting, and teardown
- Audio input and output enumeration and selection
- Privacy-safe lifecycle and timing diagnostics

Shared controllers should own orchestration such as backpressure, stale-operation
fencing, TTS interruption, Auto Listen, preferences, and failure recovery. Platform
adapters should own media acquisition, playback, routing, permissions, and operating
system lifecycle behavior.

## Desktop Media Implementation

### Dictation

Use `navigator.mediaDevices.getUserMedia` for microphone acquisition. Recording
can use either `MediaRecorder` or an `AudioWorklet`:

- `MediaRecorder` is simpler, but Chromium commonly emits WebM/Opus rather than
  Android's M4A output.
- `AudioWorklet` provides tighter control and a common PCM-based pipeline, but
  requires more buffering and encoding work.

The server media contract must explicitly accept and validate the selected desktop
format. It should not assume every client uploads `audio/mp4`. Format, byte, and
duration limits remain server-authoritative.

### Streaming Text-To-Speech

Stream the existing server PCM response into an `AudioWorklet` or another bounded
Web Audio queue. Preserve the Android behavior for ordered chunks, backpressure,
queue limits, cancellation, stale callbacks, and TTS-to-microphone handoff.

### Realtime Voice

Create the `RTCPeerConnection` in the Electron renderer:

1. Acquire the local microphone track.
2. Create an SDP offer.
3. Exchange the offer and answer through the existing T3 voice server endpoint.
4. Attach the remote audio track to a renderer audio output.
5. Reuse the existing server-side OpenAI session, context replay, tools,
   persistence, and session-event handling.

The browser should communicate with OpenAI media through WebRTC while the T3 server
continues to own provider negotiation, sideband tools, durable conversation state,
and authorization.

## Cross-Platform And Platform-Specific Work

Most of the Electron media implementation should be common across desktop
platforms. Platform-specific adapters are expected for permissions, packaging,
routing, and lifecycle behavior.

### macOS

- Microphone usage descriptions and permission recovery
- Hardened-runtime entitlements
- Application signing and notarization
- Output-device selection limitations
- Sleep, wake, and media-key behavior

### Windows

- Windows microphone privacy settings and recovery guidance
- Default versus communications-device routing
- Device-change behavior
- Installer and signing requirements
- Sleep, lock, and media-key behavior

### Linux

- PipeWire and PulseAudio differences
- Device enumeration and unstable device labels
- Flatpak, Snap, or other sandbox permissions if those packages are introduced
- Distribution-specific media and session behavior

## Background And Headset Controls

Desktop does not have Android's screen-off lifecycle, but it has analogous lock,
sleep, background-window, and headset-control concerns. Chromium `MediaSession`
may cover basic media-button events. Reliable global controls may require Electron
main-process integration or small native helpers on individual operating systems.

These controls should be optional and implemented after foreground desktop voice
is reliable. The app must not silently keep the microphone active after sleep,
lock, device removal, permission revocation, or an unrecoverable media failure.

## Proposed Implementation Order

1. Extract the platform-neutral `VoiceMediaRuntime` contract and shared voice
   controllers without changing behavior on Android.
2. Implement desktop dictation and streaming TTS.
3. Implement desktop realtime WebRTC.
4. Port Auto Listen and shared device preferences.
5. Add desktop input/output selection and privacy-safe diagnostics.
6. Add platform-specific permission recovery, sleep/wake handling, and optional
   headset controls.

## Validation

Desktop voice should be tested at three levels:

- Contract tests shared by every `VoiceMediaRuntime` implementation
- Electron integration tests using deterministic fake media devices
- Manual packaged-application acceptance on Windows, macOS, and at least one
  PipeWire-based Linux environment

Acceptance should cover permission denial and recovery, device changes, TTS
interruption, repeated start/stop cycles, provider/network failures, application
backgrounding, sleep/wake, and clean media release.

## Open Decisions

- Use Chromium `MediaRecorder` with WebM/Opus or standardize clients around a
  worklet-driven PCM/encoded format.
- Determine whether audio routing can remain renderer-owned or needs an Electron
  main-process service.
- Decide which headset controls can rely on `MediaSession` and which require
  platform-native integrations.
- Decide whether desktop and mobile voice settings share one synced schema or
  retain device-local routing and lifecycle preferences.

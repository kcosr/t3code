# Android Native Voice Readiness Plan

## Goal

Add an opt-in, process-local Android `Ready` posture around the existing native voice operation
controller. A prepared Realtime or latest-valid Active Thread target can be started from the
persistent notification or a supported media button while React is detached. Readiness remains
separate from operation state and does not restore the discarded voice kernel.

## Product decisions

- `Background voice controls` is opt-in and is acknowledged only after microphone/notification
  permission, target resolution, native credential issuance, and native Ready publication succeed.
- `Default voice interaction` is exactly `Realtime` or `Active Thread`.
- Active Thread means the latest valid selected Thread. React persists its stable environment,
  project, thread, and display-title identity and provisions the complete current `VoiceThreadStartInput`.
- Realtime follows the existing in-app Resume policy: while React is attached, resolve the most
  recently active durable conversation; if none exists, resolve a new durable conversation. Cache
  that complete `VoiceRealtimeTarget` in native readiness. The background Start action neither
  lists conversations nor guesses between new and continued conversation.
- Updating mode or target replaces only the next prepared Ready start. It never mutates active work.
- Disable during active work prevents a later Ready return but does not stop the operation.
- Operation stop/completion returns to Ready when enabled. Otherwise the service releases normally.
- Readiness and credentials are memory-only. Process death ends Ready. Saved user preference causes
  visible-app reprovisioning, not resurrection.
- A credential is startable only before its parsed `expiresAt`. Expiry produces a single
  refresh-needed transition and refuses later starts without retries.
- Audio cues, process-death/reboot recovery, agent-tool targeting, Pi, speech-server work, and wider
  Thread audio-route guarantees are out of scope.

## Implementation

### 1. Native closed readiness model and policy

- Add a small service-level model: `Disabled`, `Ready`, and `NeedsRefresh` with monotonic generation.
- Represent prepared starts as a closed union containing either the complete Realtime command input
  or complete Thread command input, including the bounded native session configuration.
- Add pure policies for configuration generation fencing, expiry, Ready actions, operation/Ready
  presentation, media-button down/up/repeat consumption, and exact service-retention decisions.
- Expose a sanitized readiness snapshot containing posture, generation, prepared mode/label,
  expiry, and unavailable/refresh reason; never expose or persist the token.

### 2. Typed Expo bridge

- Add strict bridge parsing for configure/disable readiness using the current Realtime and Thread
  input shapes; do not introduce aliases or dual shapes.
- Add native module methods and a `readinessSnapshotChanged` event for configure, disable, and
  snapshot inspection.
- Configuration is an atomic full replacement and rejects stale generations.

### 3. Foreground service ownership and controls

- Let the service retain the microphone/media-playback foreground posture while Ready without
  acquiring recorder, WebRTC, playback, audio focus, or wake lock.
- Render a persistent Ready notification and active paused MediaSession. Ready offers Start and
  Disable; refresh-needed offers Open/Disable and no Start.
- Fence notification and MediaSession actions by readiness/operation owner kind plus generation.
- Dispatch Ready Start directly through the existing controller admission and activation path.
- Keep active notification controls derived from the controller snapshot. Terminal operation state
  reconciles back to Ready or fully stops according to current readiness.
- Add explicit `onMediaButtonEvent`: recognized key-up/repeat events are consumed without dispatch;
  only initial `ACTION_DOWN` dispatches. Ready hook/play/play-pause starts; pause/stop never starts.

### 4. Preferences, target memory, and provisioning coordinator

- Add canonical preferences for the enabled flag, default mode, and latest Thread identity/title.
- Extend preference sanitization and focused persistence tests.
- Add a React-side readiness coordinator with serialized, stale-safe provisioning and testable pure
  target/status policy.
- In `VoiceRuntimeProvider`, remember each valid visible Thread and resolve a complete Thread start
  from its current shell/focus/preferences. Resolve Realtime using `loadResumeSelection`.
- Reprovision while visible when enabled and the environment, mode, latest Thread, voice settings,
  playback preference, prepared connection, or credential changes. Refresh on foreground attach.
- If Active Thread cannot be resolved, configure an unavailable native posture rather than silently
  falling back to Realtime.

### 5. Settings UX

- Add Background Voice Controls toggle with permission/provisioning acknowledgement and clear error.
- Add a Realtime/Active Thread selector and remembered Thread label/status.
- Surface `Ready`, `Active Thread unavailable`, and `Open T3 to refresh voice controls` states.
- Keep shared settings/contracts edits narrow to avoid speech-workstream conflicts.

### 6. Documentation

- Update `docs/architecture/voice.md` to describe the implemented Ready envelope and its process and
  credential bounds.
- Update `plans/voice-next-steps.md` to mark Android readiness complete and keep future ideas separate.

## Validation

- Focused TypeScript tests for preference sanitation, provisioning policy, target changes,
  unavailable Thread behavior, and adapter bridge calls.
- JVM tests for readiness replacement/fencing, expiry, service ownership, notification actions,
  media-button filtering/mapping, return-to-Ready, Disable-during-active, and exact cleanup.
- Complete native JVM suite for the mobile voice module.
- `vp check`
- `vp run typecheck`
- `vp run lint:mobile`
- `vp test`

## Device acceptance after integration review

- Enable in foreground, background/lock, then start both configured modes from notification.
- Start both modes with wired, classic Bluetooth, and BLE headset controls.
- Exercise Realtime mute/stop, Thread finish/submit/stop, and Realtime-to-Thread switch.
- Confirm selected Thread updates the Ready label and next start while active work is unchanged.
- Confirm permission denial/revocation, expiry/refresh-needed, competing media apps, task removal,
  duplicate key filtering, React-detached operation, and no process-death recovery claim.

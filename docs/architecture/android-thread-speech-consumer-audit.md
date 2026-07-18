# Android Thread speech consumer audit

Workstream: `feature/android-native-thread-voice-authority`  
Status: implemented; pending final branch acceptance

## Product decision

Android Thread Auto Listen response TTS belongs exclusively to the semantic
native cycle through `playResponses`. Arbitrary message read-aloud is not an
implemented Android feature. A future native `SpeakMessage` operation remains a
roadmap item.

## Caller dispositions

| Site                                                                                   | Disposition and proof                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ThreadDetailScreen.tsx`                                                               | Calls the platform composition root `useThreadSpeechAdapter`; it no longer mounts `useThreadSpeech` directly.                                                                                                                             |
| `useThreadSpeechAdapter.ts`                                                            | Selects once per process. Android always uses `useAndroidNativeThreadSpeech` with no React fallback; every other platform retains the existing React `useThreadSpeech` implementation.                                                    |
| `useAndroidNativeThreadSpeech.ts`                                                      | Small projection over the native runtime snapshot and the saved `threadSpeechEnabled` preference. It never observes assistant-message changes to plan playback and has no generic PCM dependency.                                         |
| Android toggle / Settings switch                                                       | Persist `threadSpeechEnabled`. The always-mounted `VoiceRuntimeProvider` serializes it into any active native Thread cycle with `updateThreadPlayResponsesAsync`, including while the detail screen is absent or the app is backgrounded. |
| Android `interrupt`                                                                    | Calls semantic `skipThreadPlaybackAsync` for explicit dictation handoff. An already-idle/non-Thread runtime is an idempotent success; genuine native failures remain visible.                                                             |
| Android `interruptForRealtime`                                                         | Successful no-op. The native `switchThreadToRealtimeAsync` transition owns Thread playback teardown, so React neither races it with Skip nor skips speech from component mount timing.                                                    |
| Android `playing` UI                                                                   | Derived from the native Thread snapshot for the selected Thread.                                                                                                                                                                          |
| `useThreadSpeech.ts`                                                                   | Pure React/non-Android implementation. The former unreachable Android `nativeAuthority` branches and native semantic commands are removed; it owns only generic message observation, synthesis streaming, backpressure, and PCM.          |
| Generic `startPlaybackAsync`, enqueue, finish, cancel, and acknowledgement bridge APIs | Retained because `useThreadSpeech.ts` is a concrete source consumer. They are not reachable from the Android Thread composition root. Removing them requires a separate non-Android product decision and zero-consumer proof.             |
| Native `T3VoiceThreadSession` playback                                                 | Sole Android owner of Auto Listen response synthesis and playback.                                                                                                                                                                        |
| MediaSession / notification Skip                                                       | Dispatch native `SkipThreadPlayback`; no React screen or hook participates.                                                                                                                                                               |

## Verification

- `useThreadSpeechAdapter.test.ts` covers platform selection, exact
  environment-scoped playback state, Android interrupt/no-op/error behavior,
  the absence of generic PCM calls on Android, and the retained non-Android
  React call into `startPlaybackAsync`.
- `nativeThreadResponsePreference.test.ts` covers provider-owned preference
  synchronization for active `waiting` and `playing` cycles without a
  detail-screen consumer. It also covers request-time generation capture and
  drops queued work after a native generation replacement.
- Static callers of `startPlaybackAsync` are the dormant non-Android
  `useThreadSpeech` implementation and the bridge definition/implementation;
  `useAndroidNativeThreadSpeech` has no reference to the API.
- Native JVM coverage remains authoritative for semantic cycle playback,
  cancellation, focus-gated backoff/rearm, notification actions, and
  MediaSession dispatch.

Device acceptance and the broader native-runtime matrix remain tracked by the
workstream plan; they are not evidence for reintroducing React playback on
Android.

# Android Thread speech consumer audit (WIP)

Workstream: `feature/android-native-thread-voice-authority`  
Status: living audit for cutover; not yet design-as-built complete

## Product decision

**Accept regression** of React-driven message auto-speak / tap-to-hear on Android.
Native Thread Auto Listen owns response speech via `playResponses`. Native
`SpeakMessage` is deferred to the roadmap.

## Consumers

| Site | Role | Disposition |
| --- | --- | --- |
| `useThreadSpeech` mount in `ThreadDetailScreen.tsx` | Preference UI + (formerly) React PCM for assistant messages | **Android:** native authority fence — no generic PCM; preference + `updateThreadPlayResponsesAsync` / `skipThreadPlaybackAsync`. **Non-Android:** keep React path when/if speech.streaming exists. |
| `useThreadSpeech.interrupt` | Stop Thread speech for dictation handoff | **Android:** maps to `skipThreadPlaybackAsync` (transient). Keep export. |
| `useThreadSpeech.interruptForRealtime` | Stop Thread speech for Realtime handoff | **Android:** same skip path. Keep export. Not Realtime barge-in. |
| `useThreadSpeech.resumeAfterDictation` / `resumeAfterRealtime` | Resume React planner after handoff | **Android:** no-op (no React planner playback). Keep exports for composer API. |
| `ThreadComposer` speech toggle | UI for `threadSpeechEnabled` | Keep; preference plumbs to native `playResponses` via `VoiceRuntimeProvider`. |
| `SettingsVoiceRouteScreen` thread speech switch | Same preference | Keep. |
| Generic `startPlaybackAsync` / enqueue / cancel | Legacy module player | **Android Thread response cycle:** must not be used. Remaining uses only if non-Thread-cycle consumers are found later. |
| Native semantic `T3VoiceThreadSession` playback | Auto Listen response TTS | **Sole Android owner** for cycle response speech. |
| MediaSession / notification SKIP | Headset skip during PLAYING | Keep; maps to `SkipThreadPlayback`. |

## Proof still required before cutover

- [ ] No Android Thread-cycle path calls `startPlaybackAsync` for assistant responses (static + runtime).
- [ ] Device acceptance matrix in the workstream design.
- [ ] Full `voice.md` rewrite after acceptance.

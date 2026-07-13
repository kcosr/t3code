# T3 Voice Runtime Integration Review

Status: Required corrections to `t3-voice-runtime-integration.md` before implementation

## Placement

Implement this milestone after React-independent Android background execution, Realtime
long-context compilation and call rotation, and the current voice goal's integrated validation.
Use one stacked T3 branch, `feature/voice-runtime-provider`. Implement and deploy the Voice Runtime
service from its separate repository; do not copy service source into T3.

Pi remains deferred. Voice Runtime supplies only bounded transcription and streaming speech.
OpenAI remains the sole Realtime provider.

## Required Contract Corrections

1. Voice Runtime must expose little-endian PCM explicitly. RFC `audio/L16` uses network byte order
   and cannot be passed through as T3's `s16le;rate=24000;channels=1` stream. Use `audio/pcm` plus
   explicit, versioned format metadata in response headers and capabilities. T3 does not resample
   or byte-swap provider output.
2. Change T3's internal speech-provider interface so opening and validating the provider response
   is an effect completed before the public HTTP response commits status and headers. The opened
   result contains validated format metadata and a byte stream. Provider, authentication, quota,
   and format failures therefore return typed JSON errors; failures after streaming begins abort
   the connection and never appear as a clean EOF.
3. Bound speech with a connect/time-to-first-byte timeout and an idle-between-chunks timeout rather
   than one total stream-duration timeout. Retain output-byte limits and cancellation.
4. Replace the credential API atomically with provider-qualified operations. Do not retain OpenAI
   aliases, omitted-provider defaults, or dual request shapes.
5. Pin provider, model, preset, and relevant configuration for all segments of one `playbackId`.
   A live settings change must not split one playback across providers.

## Security And Configuration

- Use private HTTPS with a certificate trusted by `srv`, or an equivalently authenticated and
  encrypted host network. Deployed T3 must not send bearer tokens, recordings, transcripts, or
  synthesis text over plaintext HTTP.
- Accept only a strict configured origin: HTTPS, no embedded credentials, query, or fragment.
  Disable redirects on authenticated provider requests.
- Keep the Voice Runtime token only in `ServerSecretStore`. Never expose the token, base URL,
  provider model IDs, raw audio, transcript text, or synthesis input to clients or logs.
- Select providers independently for transcription and speech. `agent.realtime` is not a selectable
  capability and always resolves to OpenAI.
- Cache capabilities by provider origin, selected model IDs, and credential generation. Invalidate
  the cache after relevant settings or credential changes and define deterministic stale-readiness
  behavior.
- Do not silently fall back to OpenAI. Provider rollback is an explicit settings change because it
  changes privacy, cost, voice, and behavior.

## Branch Acceptance

- Strict settings and provider-qualified credentials have no compatibility shapes.
- Mixed provider selection works without server restart while an in-progress multi-segment
  playback remains pinned.
- Android M4A and web WebM transcription pass through T3 to Voice Runtime; silent input, limits,
  busy responses, cancellation, and timeouts are typed and bounded.
- Streaming TTS validates `s16le`, 24 kHz, mono before exposing bytes; starts playback before
  synthesis completes; preserves segment order; and propagates cancellation upstream.
- Provider failure before the first byte produces a JSON error. Mid-stream failure produces an
  aborted downstream transport, not a successful short stream.
- Capability readiness covers ready, warming, unavailable, missing model, missing credential, and
  disabled states, including cache invalidation and failed refresh.
- Redirect, certificate, token, authorization-redaction, restart, worker-crash, saturation, and
  `srv`-to-`pc` network-interruption tests fail closed and recover predictably.
- Existing dictation, Auto Listen, TTS interruption, Realtime audio arbitration, and background
  Active Thread behavior remain unchanged from the client's perspective.

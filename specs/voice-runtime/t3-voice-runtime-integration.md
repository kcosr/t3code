# T3 Non-Realtime Voice Integration with Voice Runtime

Status: Proposed
Companion: `voice-runtime-design.md` (the Voice Runtime service this document integrates with)

## 1. Summary

T3's server (`t3code`, `apps/server`) already exposes non-realtime voice to its clients through
two authenticated media endpoints backed by an OpenAI provider adapter:

- `POST /api/voice/transcriptions` — bounded multipart upload, NDJSON delta/final response.
- `POST /api/voice/speech` — JSON request, streamed raw PCM response (s16le, 24 kHz, mono).

This document specifies how those two capabilities are re-pointed at Voice Runtime on `pc`
by adding a second provider adapter behind T3's existing `VoiceProviderAdapter` interface.
Nothing in T3's client-facing contracts changes: same routes, same schemas, same NDJSON and
PCM shapes. The realtime voice agent (`agent.realtime`) is out of scope and remains on OpenAI.

The integration is a per-capability switch: STT can move to Voice Runtime while TTS stays on
OpenAI, or vice versa, and either can be switched back by configuration alone.

## 2. Review of the Current T3 Non-Realtime Path

Findings from `apps/server/src/voice` that shape this design:

- **Provider seam already exists and is the right one.** `VoiceProviderAdapter` (in
  `Services/VoiceProvider.ts`) carries optional `transcriber` and `speechSynthesizer`
  implementations, and `VoiceProviderRegistry` resolves a provider per capability from a
  `ReadonlyMap<VoiceCapability, string>`. The map is currently hardcoded to `openai` for all
  capabilities in `runtimeLayer.ts`. No route or service outside the adapter knows about OpenAI.
- **Transcription contract:** `Transcriber.transcribe({requestId, bytes, mediaType, language?,
vocabulary?}) → Stream<VoiceTranscriptionStreamEvent>`. The route buffers the multipart upload
  fully (bounded by `voice.maxUploadBytes`, default and max 25 MB), then streams NDJSON
  `delta`/`final` events. Clients treat `final` as authoritative; the mobile dictation reducer
  replaces the whole draft on `final`, so a final-only stream is valid today.
- **Speech contract:** `SpeechSynthesizer.synthesize({requestId, playbackId, segmentIndex,
finalSegment, text, preset}) → Stream<Uint8Array>`. The route streams the bytes with
  `Content-Type: audio/pcm` and `x-t3-audio-format: s16le;rate=24000;channels=1`. The PCM
  format is a fixed T3 contract, not negotiated per request. `playbackId`/`segmentIndex`/
  `finalSegment` are client playback bookkeeping and never reach the provider backend.
- **Presets, not voices.** Clients send an opaque `preset` string; the OpenAI adapter maps it
  through a hardcoded `VOICE_PRESETS` table (`default → marin`, `warm → cedar`). Voice
  selection is server policy, which matches Voice Runtime's client-profile philosophy.
- **Capabilities are hardcoded.** `controlHttp.ts` builds `transcription.request` input formats
  (`audio/mpeg, audio/mp4, audio/m4a, audio/wav, audio/webm`) and the fixed PCM output format
  inline, with state derived only from `voice.enabled` and OpenAI credential presence.
- **Credentials:** `VoiceCredentialStore` is OpenAI-specific (`getOpenAiApiKey` et al.) backed
  by `ServerSecretStore`, mutated through `voice:manage` HTTP endpoints.
- **Error shape:** internal `VoiceError {reason, operation, detail, retryable, cause}` with
  public reasons including `not-configured`, `unsupported-media`, `payload-too-large`,
  `quota-exceeded`, `provider-unavailable`.
- **Known weakness worth fixing during this work:** the speech route returns
  `HttpServerResponse.stream(...)` immediately, so an upstream failure before the first byte
  (bad credential, 429, unreachable backend) surfaces as a truncated `200` rather than a JSON
  error. Voice Runtime's design explicitly wants validation before headers commit; §7.3 below
  addresses this on the T3 side.

## 3. Goals

- Serve T3 bounded dictation from Parakeet and streamed speech from Kokoro via Voice Runtime.
- Zero changes to T3 client contracts, clients, or media routes' external behavior.
- Per-capability provider selection (`transcription.request`, `speech.streaming`) in server
  settings, switchable without code changes.
- Derive T3's advertised voice capabilities from Voice Runtime's `/v1/audio/capabilities`
  instead of hardcoding them when Voice Runtime is selected.
- Keep the OpenAI adapter fully functional as a fallback and for `agent.realtime`.

## 4. Non-goals

- Realtime voice agent or realtime transcription on Voice Runtime.
- Exposing Voice Runtime model IDs, voices, or URLs to T3 browser/mobile clients.
- Client-selectable models/voices (future work rides on T3's existing preset mechanism).
- Resampling audio in T3. If the backend cannot produce 24 kHz s16le mono, the capability is
  unavailable, not converted.
- Changing Voice Runtime's public API for T3's benefit (one addition is recommended in §11).

## 5. Architecture

```text
browser / mobile clients
      | T3 contracts (unchanged)
      v
T3 server on srv
  /api/voice/transcriptions --\
  /api/voice/speech ----------+--> VoiceProviderRegistry (settings-driven per capability)
                              |        |-- OpenAiVoiceProvider   (openai.com; realtime + fallback)
                              |        \-- VoiceRuntimeProvider  (new)
                              |                 | bearer token, private LAN
                              v                 v
                        capabilities      Voice Runtime on pc:8787
                        (derived)           /v1/audio/transcriptions  (parakeet-local)
                                            /v1/audio/speech          (kokoro-local)
                                            /v1/audio/capabilities
                                            /health/ready
```

New code lives in `apps/server/src/voice/Providers/VoiceRuntime/VoiceRuntimeProvider.ts`
plus tests, mirroring the OpenAI adapter's placement. It implements
`VoiceProviderAdapter` with `id: "voice-runtime"` and
`capabilities: {"transcription.request", "speech.streaming"}` — no `realtime`.

### 5.1 Settings-driven registry

`makeVoiceProviderRegistry` currently receives a static selection map at layer construction.
Change the registry layer to construct **both** adapters (cheap — no connections until used)
and resolve the selection from `ServerSettingsService` on each `resolve` call:

```ts
voice: {
  // existing: enabled, maxUploadBytes, maxConcurrentSessions, contextTokenBudget
  providers: {
    transcription: "openai" | "voice-runtime",   // default "openai"
    speech: "openai" | "voice-runtime",          // default "openai"
    // agent.realtime is not configurable; always "openai"
  },
  voiceRuntime: {
    baseUrl: string,                  // e.g. "http://pc:8787"
    requestTimeoutMs: number,         // transcription total; default 120000
    connectTimeoutMs: number,         // speech time-to-first-byte; default 15000
    transcriptionModel: string,       // e.g. "parakeet-local"
    speechModel: string,              // e.g. "kokoro-local"
    speechPresets: Record<string, { voice: string; speed?: number }>,
      // e.g. { default: { voice: "af_heart" }, warm: { voice: "af_sky" } }
  }
}
```

Reading selection per-request means switching providers is a settings edit, no restart or
layer rebuild. If a selection names a provider that lacks the capability or is not configured,
`resolve` fails with the existing `not-configured` VoiceError, exactly as today.

Preset keys are shared across backends: clients keep sending `default`/`warm`, and each
adapter maps the key through its own table. A preset missing from `speechPresets` fails with
`unsupported-media`, matching the OpenAI adapter's unknown-preset behavior.

### 5.2 Credential handling

The Voice Runtime bearer token is a secret and follows the OpenAI key's path: stored via
`ServerSecretStore`, never in `ServerSettings`, never serialized to clients.

Extend `VoiceCredentialStore` with provider-keyed operations
(`getToken(provider)`, `setToken(provider, value)`, `clearToken(provider)`,
`status(provider)`) where `provider ∈ {"openai", "voice-runtime"}`, keeping the existing
OpenAI methods as delegating aliases during migration. The `voice:manage` HTTP endpoints gain
an optional `provider` parameter defaulting to `"openai"` so existing callers are unaffected.

On the Voice Runtime side, the token identifies the T3 environment as one client
(e.g. client id `t3-dev` with `allowed_models: [parakeet-local, kokoro-local]`). Voice
Runtime's per-client concurrency limit therefore applies to the whole T3 environment, not to
individual T3 users — see error mapping in §8.

## 6. Request Mapping

### 6.1 Transcription

T3 `Transcriber.transcribe(request)` → Voice Runtime `POST /v1/audio/transcriptions`
(multipart):

| T3 field              | Voice Runtime field | Notes                                                                                                                          |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `bytes` + `mediaType` | `file` part         | Part `Content-Type` from `mediaType`; filename extension derived from it (`audio/webm → utterance.webm`, `audio/mp4            | m4a → .m4a`, `audio/wav → .wav`, `audio/ogg → .ogg`, `audio/mpeg → .mp3`) |
| —                     | `model`             | `voiceRuntime.transcriptionModel` from settings                                                                                |
| `language`            | `language`          | Passed through only if the model's capabilities list it (or auto-detect); otherwise dropped with a debug log                   |
| `vocabulary`          | `prompt`            | Sent only if capabilities advertise `prompt` support. Parakeet does not support it; dropped silently (debug log). Not an error |
| —                     | `response_format`   | Always `json`                                                                                                                  |
| `requestId`           | —                   | T3-side correlation only; Voice Runtime's `X-Request-Id` is logged alongside it                                                |

The response `{ "text": ... }` becomes a **single** NDJSON event:

```json
{ "type": "final", "result": { "requestId": "...", "text": "...", "language": "..." } }
```

No `delta` events are emitted. This is contract-legal (final is authoritative) and clients
already handle it; the UX difference is no incremental text during provider processing, which
is acceptable for bounded push-to-talk dictation and disappears as Parakeet latency is small.

**Empty transcript:** `VoiceTranscriptionResult.text` is `TrimmedNonEmptyString`, so an empty
or whitespace-only transcript (silent recording) cannot be encoded as a `final` event. The
adapter fails the stream with `VoiceError { reason: "unsupported-media", detail:
"Transcription produced no text", retryable: false }`. Note this failure mode exists today —
an empty OpenAI `transcript.text.done` would crash NDJSON encoding mid-stream — so the new
adapter makes the behavior explicit rather than introducing it. A dedicated public reason
(e.g. `empty-transcript`) is a candidate contract addition but is not required for this work.

**Retry:** transcription is idempotent (complete upload, no server state). On `429` or 5xx the
adapter performs at most one retry, honoring `Retry-After` capped at 2 s, within
`requestTimeoutMs`. No retry on 4xx validation errors.

### 6.2 Speech synthesis

T3 `SpeechSynthesizer.synthesize(request)` → Voice Runtime `POST /v1/audio/speech` (JSON):

| T3 field                                                  | Voice Runtime field | Notes                                                                                            |
| --------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `preset`                                                  | `voice`, `speed`    | Via `voiceRuntime.speechPresets[preset]`; unknown preset → `unsupported-media`, no upstream call |
| `text`                                                    | `input`             | T3 phrase chunker already bounds segment size                                                    |
| —                                                         | `model`             | `voiceRuntime.speechModel` from settings                                                         |
| —                                                         | `response_format`   | Always `pcm`                                                                                     |
| `requestId`, `playbackId`, `segmentIndex`, `finalSegment` | —                   | T3 playback bookkeeping; not forwarded                                                           |

The response body (raw PCM) is passed through unmodified as `Stream<Uint8Array>`. T3's route
adds its fixed `audio/pcm` content type and `x-t3-audio-format` header as today.

**Sample-format assertion:** T3's client contract is exactly s16le / 24 kHz / mono. The
adapter verifies from cached Voice Runtime capabilities that the configured speech model emits
exactly that (Kokoro natively does), and additionally checks the response's
`audio/L16; rate=...; channels=...` parameters on each request. A mismatch fails the request
with `unsupported-media` before any byte is forwarded. T3 never resamples.

**Truncation chain:** Voice Runtime aborts the connection on mid-stream failure (never a clean
close). T3's HTTP client surfaces that as a stream error → the adapter maps it to
`provider-unavailable` → T3's own response terminates uncleanly → the T3 client treats it as
failed playback. An integration test must cover this full chain (§10).

**Backpressure and cancellation:** the adapter must not buffer the upstream body; Effect
stream pulls propagate to the socket, so a slow T3 client throttles Voice Runtime, which
throttles Kokoro. When the T3 client disconnects, stream interruption must abort the upstream
request (socket close), which is Voice Runtime's cancellation signal. Verify the HttpClient
in use actually aborts the connection on interrupt; this is load-bearing for freeing the
single Kokoro worker slot.

## 7. Capabilities, Readiness, and Route Hardening

### 7.1 Derived capability descriptors

When a capability's selected provider is `voice-runtime`, `controlHttp.ts` builds its
descriptor from Voice Runtime data instead of the hardcoded tables:

- `transcription.request.inputFormats` = (formats advertised for the configured STT model in
  `/v1/audio/capabilities`) ∩ (T3's `VoiceAudioFormat` enum).
- `transcription.request.maxInputBytes` = min(`voice.maxUploadBytes`, Voice Runtime's
  advertised upload limit).
- `speech.streaming.outputFormats` stays the fixed
  `audio/pcm;rate=24000;encoding=s16le;channels=1` — but is advertised only if the sample
  assertion in §6.2 passes.
- State: `disabled` if `voice.enabled` is false; `not-configured` if `baseUrl` or the token is
  missing; `unavailable` if Voice Runtime is unreachable, `/health/ready` is false, or the
  configured model is missing/not-ready in capabilities; else `ready`.

### 7.2 Capability cache

The adapter fetches `/v1/audio/capabilities` lazily, caches it with a short TTL (60 s), and
serves stale data on refresh failure while flipping readiness to `unavailable` after a failed
refresh. No background poller in the first release; the TTL plus on-demand refresh is enough
for a capabilities endpoint that changes only on Voice Runtime deploys. Media requests do not
block on capability freshness — they use the cached view and let Voice Runtime be the
authoritative validator.

### 7.3 Pre-stream error surfacing (recommended T3 hardening)

Restructure the speech route so the effect that opens the upstream connection (and validates
preset, credential, and response headers) runs **before** T3 commits its own response headers:
run the adapter's `Stream.unwrap` inner effect first, then wrap the already-open byte stream
in `HttpServerResponse.stream`. Upstream `401/404/429/400` then become clean JSON
`VoicePublicError` responses instead of truncated `200`s. This also benefits the OpenAI
adapter. It is a small route/adaptor refactor with contract tests, scheduled in Phase C
(§10) because the truncation chain must exist first as the fallback path.

## 8. Error and Busy Mapping

Voice Runtime's envelope is `{"error": {type, code, message, param, request_id}}`; T3 maps it
to `VoiceError`:

| Voice Runtime response                                   | T3 `VoiceError.reason` | retryable |
| -------------------------------------------------------- | ---------------------- | --------- |
| network unreachable / connect timeout / TLS failure      | `provider-unavailable` | true      |
| `401` / `403`                                            | `not-configured`       | false     |
| `400` invalid/unsupported field, unknown voice/model     | `unsupported-media`    | false     |
| `413` or upload-limit code                               | `payload-too-large`    | false     |
| `429 client_concurrency_exceeded` / `model_busy`         | `quota-exceeded`       | true      |
| `5xx`, malformed envelope, aborted stream                | `provider-unavailable` | true      |
| T3-side timeout (`requestTimeoutMs`, `connectTimeoutMs`) | `provider-unavailable` | true      |

`message` and `param` go into `detail`; the upstream `request_id` (and the `X-Request-Id`
header, present on all Voice Runtime responses including streams) is attached to T3 logs and
trace attributes for cross-service correlation. Voice Runtime error message text is not
forwarded verbatim to T3 clients beyond the existing `VoicePublicError.message` policy.

Because the whole T3 environment shares one Voice Runtime client identity, a second
simultaneous dictation while Kokoro/Parakeet is busy can 429. The transcription retry (§6.1)
absorbs the common brief case; a persistent 429 surfaces as the retryable `quota-exceeded`
public error, which clients already render.

## 9. Security and Networking

- T3 server → Voice Runtime traffic stays on the private LAN (`http://pc:8787`,
  192.168.50.72), per Voice Runtime's deployment spec; TLS or an overlay upgrade applies to
  this hop when Voice Runtime adopts it. The base URL is deployment configuration in
  `T3CODE_HOME/settings.json`.
- Browser and mobile clients never learn the Voice Runtime URL, token, model IDs, or voice
  IDs; presets remain the only client-visible vocabulary. This matches the existing rule that
  clients never receive provider identifiers.
- The bearer token lives in `ServerSecretStore`, is redacted from logs, and is sent only in
  the `Authorization` header to `baseUrl`.
- T3 keeps enforcing its own `maxUploadBytes` before contacting Voice Runtime; Voice
  Runtime's server-side limits are defense in depth, not the primary gate.
- Audio bytes and transcript text are not logged on the T3 side (existing policy, unchanged).

## 10. Testing Strategy

Following the repo's rule that normal tests never touch the network:

**Unit (fake HTTP layer):**

- multipart construction: model, filename/content-type mapping per `VoiceAudioFormat`,
  language/vocabulary gating from capability fixtures;
- final-only NDJSON emission; empty-transcript failure; retry-once on 429 honoring
  `Retry-After`, no retry on 400;
- preset → voice/speed resolution and unknown-preset failure without an upstream call;
- error envelope → `VoiceError` mapping table, including malformed envelopes;
- capability cache TTL, stale-serve, and readiness-state derivation;
- sample-format assertion from `audio/L16` parameters.

**Integration (in-process fake Voice Runtime server):**

- streamed PCM passthrough with backpressure (slow consumer does not grow adapter memory);
- upstream abort mid-stream → T3 response terminates uncleanly → client-side stream error
  (the full truncation chain);
- T3 client disconnect aborts the upstream socket (cancellation propagation);
- capabilities-derived descriptors and each readiness state;
- per-capability provider switching via settings, including mixed OpenAI-TTS +
  Voice-Runtime-STT.

**Gated real-host verification (from `srv` against `pc`, credentialed, opt-in):**

- dictate a fixture recording end-to-end through `/api/voice/transcriptions`;
- synthesize a phrase-chunked message and verify playback-ordered PCM, first-byte latency,
  and cancellation freeing the Kokoro slot (second request succeeds promptly);
- unauthorized token, oversized upload, unknown voice, and busy (concurrent) behavior.

## 11. Implementation Plan

- **Phase A — adapter and settings:** `VoiceRuntimeProvider` (transcriber + synthesizer +
  capability cache), `voice.providers` / `voice.voiceRuntime` settings, provider-keyed
  credential store, settings-driven registry. All unit and fake-server tests. Defaults keep
  OpenAI selected; no behavior change when unconfigured.
- **Phase B — STT cutover:** point `transcription` at `voice-runtime` in the dev environment;
  run gated real-host verification; watch latency and empty-transcript behavior in real
  dictation.
- **Phase C — TTS cutover and route hardening:** point `speech` at `voice-runtime`; land the
  pre-stream error surfacing refactor (§7.3) with contract tests; verify truncation and
  cancellation chains against the real service.
- **Phase D — capabilities derivation and docs:** replace hardcoded descriptors with derived
  ones for Voice-Runtime-backed capabilities; document operator setup (token issuance on
  Voice Runtime, settings fields, switchback procedure).

Rollback at any phase is a settings edit back to `openai`.

**Recommended Voice Runtime follow-up (not blocking):** add MP3 (`audio/mpeg`) to the
transcription container allowlist for parity with T3's current advertised formats; until
then, derived capabilities simply stop advertising `audio/mpeg`, which no current T3 client
records anyway (web records WebM/Opus, Android records M4A).

## 12. Key Decisions and Risks

- **Adapter behind the existing seam, no client changes:** the integration cost stays inside
  one new provider file plus registry/settings plumbing; every T3 client works unchanged.
- **Per-capability selection read from settings at resolve time:** switching backends is an
  operator action with no restart, and mixed configurations (local STT, cloud TTS) are
  first-class.
- **Final-only transcription stream:** loses incremental deltas relative to OpenAI. Accepted:
  bounded dictation is short, Parakeet is fast, and the contract already designates `final`
  as authoritative. If deltas matter later, Voice Runtime's deferred streaming-STT session
  API is the vehicle, not this endpoint.
- **Strict 24 kHz assertion instead of resampling:** keeps T3 free of audio processing and
  makes a misconfigured backend loudly unavailable rather than quietly wrong-pitched.
- **One Voice Runtime client identity per T3 environment:** simple, but concurrency limits
  are environment-wide. If per-user fairness becomes a real need, mint per-environment-user
  tokens on Voice Runtime later; the adapter design does not change.
- **Empty-transcript contract gap:** `TrimmedNonEmptyString` in the result schema forces a
  failure path for silent recordings. Explicit error now; consider a typed
  `empty-transcript` public reason as a small future contract addition.
- **GPU cold-start visibility:** Voice Runtime warms models before readiness, but a restart
  window on `pc` will surface as `unavailable` capabilities in T3. That is correct behavior;
  operators should know voice readiness is now coupled to the `pc` service.

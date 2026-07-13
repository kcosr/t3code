# Voice Runtime Design

Status: Proposed

## 1. Summary

Voice Runtime is a standalone speech service hosted on `pc`. It exposes local speech-to-text (STT) and text-to-speech (TTS) models over an authenticated private network API so applications such as T3 Code and Assistant can use them without depending on `agent-voice-adapter`.

The first release provides batch transcription and streaming speech synthesis over ordinary HTTP. Its public HTTP surface follows the useful portion of OpenAI's audio API, while a small native capabilities endpoint describes local models, voices, formats, and limits. The service does not claim full OpenAI API or Realtime API compatibility.

Model, voice, language, speed, and media format are runtime request parameters. Server configuration controls installed providers, public model identifiers, hardware placement, authentication, resource limits, and defaults.

## 2. Goals

- Serve local STT and TTS models running on `pc` to multiple independent applications.
- Keep clients independent from model processes, Python environments, checkpoints, and host-specific paths.
- Allow each request to select a permitted model, voice, language, speed, and media format.
- Stream TTS audio as response bytes with low startup latency and bounded memory usage.
- Accept complete recorded audio uploads for reliable first-release STT.
- Present a stable provider-neutral contract that can support different engines later.
- Offer an OpenAI-shaped subset where that lowers client integration cost.
- Provide capability discovery, authentication, request limits, cancellation, health checks, and useful operational telemetry.
- Run as a supervised service and recover predictably from provider process failures.

## 3. Non-goals

- Embedding or calling `agent-voice-adapter` at runtime.
- Reproducing the entire OpenAI API or claiming drop-in compatibility with every OpenAI client.
- Full-duplex voice sessions or streaming STT in the first release.
- Conversation state, turn detection, agent orchestration, or audio playback.
- Letting callers supply arbitrary checkpoint paths, commands, or device assignments.
- Exposing the service directly to the public Internet.

## 4. Current Environment

T3 currently runs on `srv`; the local speech models run on `pc`. The existing voice adapter reaches those models through long-running Python processes over SSH and newline-delimited JSON on stdio.

The current engines observed on `pc` are:

- STT: Parakeet, currently `nvidia/parakeet-tdt_ctc-110m`, in `/home/kevin/.venvs/parakeet`.
- TTS: Kokoro, in `/home/kevin/.venvs/kokoro`.

The existing Parakeet path sends a complete audio payload and returns a final transcript. The Kokoro path emits incremental PCM chunks. Voice Runtime should preserve those useful execution characteristics while replacing the SSH-and-stdio application boundary with a durable network service boundary.

## 5. Architecture

```text
T3 on srv ---------\
Assistant ----------> authenticated private HTTP ---> Voice Runtime on pc
Future applications-/                                  |
                                                       +-- request validation/auth
                                                       +-- capability registry
                                                       +-- provider scheduler
                                                       +-- Parakeet STT worker
                                                       +-- Kokoro TTS worker
                                                       +-- future providers
```

Voice Runtime owns the HTTP contract and provider lifecycle. Clients know public model and voice IDs, not Python scripts or filesystem paths.

### 5.1 API service

The API service performs authentication, request validation, model resolution, admission control, cancellation propagation, response formatting, and observability. It should be implemented as a small typed service with no model-specific logic in route handlers.

### 5.2 Capability registry

At startup, static configuration is validated into a registry of public models and voices. Each entry maps a stable public ID to a provider implementation and private provider configuration. The registry is the single source of truth for API validation and capability discovery.

### 5.3 Provider interface

Provider-neutral interfaces isolate the HTTP API from engine details:

```text
TranscriptionProvider.transcribe(request, signal) -> transcript result
SpeechProvider.synthesize(request, signal) -> async audio byte stream
Provider.health() -> readiness and diagnostic state
```

Normalized requests contain resolved model IDs and typed options. Providers may reject options they do not support, but unsupported values should normally be caught using capability metadata before execution.

### 5.4 Model workers

Models are expensive to initialize, so providers should use persistent workers rather than launching Python for each request. The initial implementation can use dedicated Python worker programs derived from the behavior of the current Parakeet and Kokoro daemons. These programs must live in the Voice Runtime repository or a separately versioned package; production must not import scripts from the `agent-voice-adapter` checkout.

An internal stdio protocol is acceptable for the first provider implementation because the workers are on the same host as Voice Runtime. It is private and versioned independently from the public HTTP API. Binary audio should use framed binary messages or temporary files where practical; base64 in JSON is acceptable only as an initial internal simplification and should not become the public media contract.

Each worker supervisor should:

- Start and warm its model before reporting ready.
- Enforce a configured concurrency or queue limit.
- Detect process exit and malformed protocol output.
- Fail active requests clearly when a worker dies.
- Restart with bounded exponential backoff.
- Stop work promptly when the client disconnects, where the engine permits cancellation.
- Expose loaded, warming, failed, queue depth, and restart-count metrics.

Cancellation is cooperative first: the supervisor sends a cancel message and the worker stops between generation chunks. If a worker does not acknowledge within a grace period the supervisor may kill it, but killing evicts a warm model and forces a re-warm, so it is a last resort for unresponsive workers rather than the routine response to a client disconnect. For short requests, letting generation finish and discarding the output is acceptable. A cancelled request occupies its model slot until the worker actually stops, and admission control must count it until then.

The observed engines are likely safest at concurrency one per loaded model initially. Additional parallelism should come from explicit worker replicas after measurement, not unbounded concurrent calls into a single model instance.

## 6. Network and Security

Voice Runtime should listen on a private interface reachable from `srv`, ideally over a private LAN or overlay network. SSH tunneling may be used temporarily for development, but application traffic should not depend on an interactive SSH command once deployed.

Initial authentication should use bearer tokens. Store only token hashes or references to secret files in configuration. Tokens identify a logical client such as `t3-dev` or `assistant`, allowing per-client permissions and limits later. Token and client configuration changes take effect on service restart; hot reload is not required in the first release.

Required controls:

- TLS at the service, a private reverse proxy, or an authenticated overlay network.
- Constant-time token verification.
- Per-client request and concurrency limits.
- Maximum upload bytes, text length, audio duration, and request duration.
- Model and voice allowlists per client when needed.
- No arbitrary local paths, URLs, commands, or provider options from requests.
- Logs that omit bearer tokens and raw audio; transcript/text logging disabled by default.

## 7. Public API

The API is versioned under `/v1`. OpenAI-shaped endpoints use compatible field names and response forms for the supported subset. Voice Runtime should document exactly which fields it supports and return a clear `400` response for unsupported fields rather than silently ignoring them.

Every response carries an `X-Request-Id` header — streaming and error responses included — so any outcome, including a truncated stream, can be correlated with server logs.

### 7.1 Transcription

`POST /v1/audio/transcriptions`

Request: `multipart/form-data`

- `file`: required audio file.
- `model`: required public STT model ID.
- `language`: optional language hint.
- `prompt`: optional, only when the selected provider supports it.
- `response_format`: initially `json` or `text`.
- `temperature`: unsupported initially and rejected if supplied.

Default JSON response:

```json
{
  "text": "transcribed text"
}
```

The server should stream the upload to bounded storage or a provider input pipeline instead of buffering arbitrary files in memory. It should normalize supported containers into the provider's required sample rate and channel layout in a shared media layer.

The initially accepted containers are WAV, WebM/Opus, Ogg/Opus, and MP4/AAC — plain WAV plus the formats mainstream browser recording produces. Normalization uses a pinned ffmpeg executed with bounded CPU, memory, and wall time. Decoding untrusted uploads is a meaningful attack surface, so the container allowlist should stay small and unsupported containers should be rejected before conversion starts.

Batch upload remains the first-release STT design. It matches current Parakeet behavior, is easy to retry, and avoids introducing partial-transcript and session semantics before they are needed.

### 7.2 Speech synthesis

`POST /v1/audio/speech`

Request: `application/json`

```json
{
  "model": "kokoro-local",
  "voice": "af_heart",
  "input": "Text to speak",
  "response_format": "pcm",
  "speed": 1.0
}
```

The response body is raw audio bytes, streamed as they are produced. It is not a JSON wrapper and does not base64-encode chunks. The `Content-Type` reflects the selected format. Raw PCM uses `audio/L16; rate=24000; channels=1`, with the RFC 2586 parameters carrying the actual sample rate and channel count; WAV uses `audio/wav`. Sample rate, channels, and encoding also appear in model capabilities so clients can configure playback before the first byte arrives.

Streaming WAV cannot know its total length when the header is written. The service streams WAV with the RIFF and data size fields set to their maximum value, which mainstream decoders treat as unknown length. Clients that require exact RIFF sizes should request `pcm` and wrap the audio themselves.

Ordinary streaming HTTP is sufficient for this request-response flow and works naturally with backpressure, cancellation, proxies, and standard clients. WebSockets are not required for first-release TTS.

### 7.3 Models

`GET /v1/models`

Returns an OpenAI-shaped list of public model IDs and broad ownership metadata. This endpoint is intentionally shallow so existing clients can enumerate model names. The list is filtered to the models the authenticated client is permitted to use.

### 7.4 Capabilities

`GET /v1/audio/capabilities`

Returns the authoritative native description of available STT and TTS features. It should include:

- Public model ID, task type, readiness, and display label.
- Supported input or output formats.
- Supported languages and whether language is auto-detected.
- Voices, display labels, and optional descriptive metadata.
- Speed range and default.
- Audio sample rate, channels, and encoding where fixed.
- Maximum text length, upload size, and known duration limits.
- Whether synthesis streams incrementally.
- Supported optional request fields.

Capabilities should be generated from the validated registry rather than maintained as separate route data. Like `/v1/models`, the response is filtered to the models and voices the authenticated client is permitted to use, so it describes what the caller can actually do rather than what is installed.

### 7.5 Admission control and timeouts

Saturation is the normal case with single-worker models and multiple clients, so busy behavior is part of the contract:

- A request that would exceed the client's `max_concurrent_requests` receives an immediate `429` with code `client_concurrency_exceeded` and a `Retry-After` header.
- A request for a busy model enters a bounded per-model queue. When the queue is full or the configured wait timeout expires, the service returns `429` with code `model_busy` and `Retry-After`.
- `Retry-After` values are conservative estimates derived from queue depth, not precise promises.

`request_timeout_seconds` bounds total duration for non-streaming requests, including queue wait. For streaming synthesis it bounds time to first byte; after that, a separate idle timeout bounds the gap between chunks, and a healthy stream is never cut off for total duration.

### 7.6 Health and operations

- `GET /health/live`: process is running.
- `GET /health/ready`: required configured providers are loaded and usable.
- `GET /metrics`: optional Prometheus-format metrics, restricted to the private operations network.

### 7.7 Errors

Use one consistent JSON error envelope for non-streaming failures:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_voice",
    "message": "Voice 'x' is not supported by model 'kokoro-local'.",
    "param": "voice",
    "request_id": "req_..."
  }
}
```

Once a streaming TTS response has started, HTTP status cannot be changed. On mid-stream failure the server must abort the connection without sending the terminal chunk, so the client observes a transport error. It must never clean-close an incomplete stream: for headerless PCM, a clean close is indistinguishable from a short but successful synthesis. The failure is logged under the request ID and increments failure metrics, and clients must treat any transport error as a failed synthesis. Where possible, provider warmup and validation should happen before response headers are committed.

## 8. Configuration

Use a checked-in example configuration and a host-local deployment configuration. YAML or TOML is preferable for operator readability; the implementation should parse it into a strict schema at startup and fail fast on unknown or invalid fields.

Illustrative shape:

```yaml
server:
  # Private LAN address of pc only; never a public interface.
  listen: 192.168.50.72:8787
  request_timeout_seconds: 180
  stream_idle_timeout_seconds: 30
  queue_max_depth: 8
  queue_wait_timeout_seconds: 30
  max_upload_bytes: 52428800

auth:
  tokens_file: /home/kevin/.config/voice-runtime/tokens.json

models:
  - id: parakeet-local
    task: transcription
    provider: parakeet
    enabled: true
    provider_config:
      python: /home/kevin/.venvs/parakeet/bin/python
      checkpoint: nvidia/parakeet-tdt_ctc-110m
      device: auto
      workers: 1
      warmup: true

  - id: kokoro-local
    task: speech
    provider: kokoro
    enabled: true
    default_voice: af_heart
    voices: [af_heart, af_sky]
    output_formats: [pcm, wav]
    provider_config:
      python: /home/kevin/.venvs/kokoro/bin/python
      device: auto
      workers: 1

clients:
  - id: t3-dev
    token_ref: t3-dev
    allowed_models: [parakeet-local, kokoro-local]
    max_concurrent_requests: 2
```

Static server configuration owns:

- Installed providers and private checkpoint/venv/device details.
- Public model IDs and permitted voices/formats.
- Worker counts, queues, warmup, timeouts, and resource limits.
- Client credentials, authorization, quotas, and default policy.
- Network, logging, metrics, and temporary-storage settings.

Runtime requests own:

- Model selection.
- Voice selection.
- Text or audio input.
- Language hint.
- Speed and supported synthesis controls.
- Input/output format and response format.

Defaults may exist in server configuration for convenience, but they must not prevent callers from selecting any permitted runtime value. A future client profile can supply defaults without creating separate static deployments per application.

## 9. Repository Layout

Recommended initial layout:

```text
voice-runtime/
  README.md
  specs/
    voice-runtime-design.md
  config/
    voice-runtime.example.yaml
  src/
    api/
    auth/
    config/
    media/
    providers/
    runtime/
    observability/
  workers/
    parakeet/
    kokoro/
  tests/
    unit/
    integration/
    fixtures/
  deploy/
    systemd/
```

The main service can be implemented in TypeScript/Node if sharing schemas and application tooling is valuable, or Python if direct model integration materially simplifies lifecycle management. The critical boundary is the typed provider contract, not the language. Given the current Python engines, a small TypeScript control plane with supervised Python workers is a pragmatic initial split, provided its internal protocol is tested and cancellation-safe.

## 10. Deployment on `pc`

Install Voice Runtime under `/home/kevin/worktrees/voice-runtime` for development, with host-local configuration under `/home/kevin/.config/voice-runtime` and mutable runtime data under an appropriate state directory.

Use a user-level systemd service initially. The unit should:

- Start after networking is available.
- Load secrets from protected files or environment files.
- Set explicit working directory and executable paths.
- Restart on unexpected failure with bounded delay.
- Drain on shutdown: stop accepting new requests, give in-flight requests a bounded deadline, then stop workers.
- Stop workers as part of the service process group.
- Use a dedicated temporary directory and sensible filesystem protections.
- Expose readiness for deployment smoke tests.

The model artifacts and Python environments may initially reuse the installed venvs on `pc`, but their paths are deployment configuration. Voice Runtime should own the worker code and pin its dependencies so an unrelated `agent-voice-adapter` checkout or update cannot break it.

Clients on `srv` should use a stable private hostname and port — `pc:8787` (192.168.50.72) — not a worktree path or SSH command. A reverse proxy is optional; direct TLS from Voice Runtime or an overlay network is sufficient for the first private deployment.

## 11. Testing Strategy

### 11.1 Unit tests

- Strict configuration parsing, unknown fields, duplicate IDs, and invalid provider combinations.
- Authentication and per-client model authorization.
- Request schema validation and OpenAI-shaped error responses.
- Capability generation from registry entries.
- Queue limits, timeout handling, and cancellation propagation.
- Media type and audio metadata selection.
- Provider supervisor restart and state transitions using fake workers.

### 11.2 Contract tests

- Multipart transcription requests produce the documented response formats.
- TTS headers and streamed byte bodies match selected formats.
- Unsupported OpenAI fields receive explicit errors.
- Client disconnect cancels or abandons work without corrupting the next request.
- Mid-stream provider failure aborts the connection without a terminal chunk; clients observe a transport error rather than a clean EOF.
- Saturated clients and busy models receive `429` responses with `Retry-After`.
- All advertised capability combinations are accepted; non-advertised combinations are rejected.

### 11.3 Provider integration tests

- Run Parakeet against short deterministic audio fixtures and assert non-empty or expected normalized text.
- Run Kokoro against short text, validate stream startup, byte count, PCM/WAV structure, duration bounds, and non-silent audio.
- Verify Unicode text, punctuation, long input boundaries, and every configured voice.
- Verify workers survive sequential requests and recover after forced termination.

GPU/model integration tests should be separately tagged so ordinary CI can use fake providers while deployment validation runs against the real models on `pc`.

### 11.4 End-to-end tests

From `srv`:

- Authenticate and fetch readiness, models, and capabilities.
- Upload a known recording and receive a transcript.
- Request TTS and begin consuming bytes before synthesis completes.
- Cancel a TTS download and verify queue/resource recovery.
- Exercise unauthorized, oversized, invalid-model, invalid-voice, and busy responses.

### 11.5 Operational tests

- Cold start and model warmup timing.
- Repeated synthesis/transcription soak test with memory and GPU utilization monitoring.
- Service restart while idle and under load.
- Provider crash/restart and readiness transitions.
- Queue saturation and fair handling of multiple client identities.
- Network interruption between `srv` and `pc`.

## 12. Implementation Plan

### Phase 1: Service skeleton

- Establish repository, language/tooling, strict configuration schema, logging, request IDs, bearer auth, and health endpoints.
- Define provider contracts, capability schema, fake providers, and error envelope.
- Add API contract tests before connecting real models.

### Phase 2: Batch STT

- Implement bounded multipart upload and shared audio normalization.
- Build and supervise the dedicated Parakeet worker.
- Add `/v1/audio/transcriptions`, model listing, capabilities, and real-host smoke tests.

### Phase 3: Streaming TTS

- Build and supervise the dedicated Kokoro worker.
- Add `/v1/audio/speech` with raw streaming response bytes and backpressure.
- Validate cancellation, truncated-stream behavior, formats, voices, and startup latency.

### Phase 4: Deployment hardening

- Add systemd unit, protected configuration/secrets, metrics, queue limits, and deployment scripts.
- Run end-to-end, restart, failure, and soak tests from `srv` to `pc`.
- Document supported OpenAI subset and provide curl/client examples.

### Phase 5: Additional clients and providers

- Integrate T3 and then Assistant through the public API.
- Add providers only behind the existing provider contracts and capability registry.
- Add per-client defaults/policies if actual client requirements justify them.

### Deferred: live streaming STT

Live STT should be introduced as a distinct session API only after a client needs partial transcripts or server-side turn detection. At that point, WebSockets are reasonable because the interaction is bidirectional: the client sends audio frames while the server sends partial/final transcript events and control messages. This protocol should not be forced into the batch OpenAI-shaped transcription endpoint and should not change the existing TTS HTTP endpoint.

## 13. Key Decisions and Risks

- **OpenAI-shaped, not fully compatible:** This yields easy adoption for common audio clients without freezing provider-specific constraints into a false compatibility promise.
- **HTTP streaming for TTS:** Raw response bytes are simpler and more efficient than JSON/base64 or WebSockets for one request producing one ordered stream.
- **Batch STT first:** It matches the current engine and T3's recorded-turn workflow. Streaming STT remains an additive session feature.
- **Runtime voice/model selection:** Multi-client use requires selection in each request; configuration defines only what is installed and allowed.
- **Persistent local workers:** Warm models reduce latency, but require robust supervision and strict resource admission.
- **Audio conversion:** Container and codec support is a reliability and security surface. Keep the accepted format set small, pin the ffmpeg used for conversion, and run it with bounded resources; decoder vulnerabilities are the primary concern with untrusted uploads.
- **Partial TTS failures:** Streaming failures cannot return a normal JSON error after headers are sent. The server aborts the connection so truncation surfaces as a transport error; clients and tests must explicitly handle it.
- **GPU contention:** Multiple models and clients can exhaust device memory or create latency spikes. Start with explicit serial queues and measure before increasing concurrency.
- **Model licensing:** Record licenses and redistribution constraints for every configured checkpoint and voice before broader deployment.

## Addendum A: Future T3 Integration

The concrete integration design is specified in `t3-voice-runtime-integration.md`, based on a
review of T3's existing voice provider seam; this addendum records the original framing.

T3 should treat Voice Runtime as an external speech provider. Static deployment details such as base URL, bearer-token reference, request timeouts, and enabled feature policy belong in T3's server configuration, currently represented by `T3CODE_HOME/settings.json`. Secrets should remain server-side and never be sent to the browser.

The T3 server should proxy or mediate speech requests so browser clients do not need direct network access to `pc`. It can fetch `/v1/audio/capabilities` and expose the allowed model, voice, language, speed, and format choices through T3's own typed server/client contracts.

User choices such as selected STT model, TTS model, voice, speed, and preferred language can later live in T3's existing client settings storage. Those are runtime preferences included with requests, while the T3 server applies deployment policy and credentials. The initial integration can retain T3's local recording capture and batch upload for transcription, and consume streaming TTS bytes over HTTP. A future live microphone mode should use a separate bidirectional streaming-STT protocol only if latency or turn-taking requirements warrant it.

# T3 Non-Realtime Voice Integration with OpenAI-Compatible Speech Server

Status: Ready for implementation

## 1. Summary

T3's existing non-realtime voice path already uses OpenAI audio request shapes:

- `POST /api/voice/transcriptions` receives bounded audio and exposes NDJSON events.
- `POST /api/voice/speech` exposes streamed s16le, 24 kHz, mono PCM.
- `OpenAiVoiceProvider` sends multipart transcription requests and JSON speech requests.

OpenAI-Compatible Speech Server now implements the OpenAI-compatible behaviors this path needs: final-only
transcription SSE, streamed PCM speech, `model=default`, `voice=default`, tolerant prompt and
instruction handling, M4A/MP3 inputs, OpenAI error envelopes, and request cancellation.

T3 therefore needs a small second non-realtime provider configuration, not a native speech-server
media protocol. Browser, mobile, and T3 route contracts remain unchanged. OpenAI
continues to own `agent.realtime`.

## 2. Required Boundary

```text
T3 clients
  /api/voice/transcriptions ----\
  /api/voice/speech -------------+--> VoiceProviderRegistry
                                  |      openai        -> OpenAI audio + realtime
                                  |      openai-speech-server -> OpenAI-compatible audio only
                                  v
                         http://192.168.50.72:6624
                           /v1/audio/transcriptions
                           /v1/audio/speech
                           /health/ready
```

Do not change T3's client-facing routes, NDJSON transcription events, PCM response headers,
Android playback, or realtime provider selection.

## 3. Settings and Credentials

Add end-state settings for per-capability selection and the local endpoint:

```json
{
  "voice": {
    "providers": {
      "transcription": "openai",
      "speech": "openai"
    },
    "openaiSpeechServer": {
      "baseUrl": "http://192.168.50.72:6624",
      "requestTimeoutMs": 120000,
      "connectTimeoutMs": 15000,
      "speechPresets": {
        "default": { "voice": "default", "speed": 1 },
        "warm": { "voice": "af_sky", "speed": 1 }
      }
    }
  }
}
```

The model for both OpenAI-Compatible Speech Server audio calls is the literal `default`. OpenAI-Compatible Speech Server resolves
that alias using its host configuration. Do not duplicate local model IDs in T3 settings.

Store the OpenAI-Compatible Speech Server bearer token in `ServerSecretStore`, keyed by provider. Refactor the
credential service and its callers to provider-keyed operations; do not retain dual OpenAI-only
and provider-keyed method shapes. Never serialize the token into settings or logs.

`agent.realtime` always resolves to `openai`. `transcription.request` and `speech.streaming`
resolve from settings on each request so switching or rollback does not require a process
restart.

## 4. Transcription Mapping

Send T3's bounded upload to `POST {baseUrl}/v1/audio/transcriptions`:

| T3 input             | OpenAI-compatible field          |
| -------------------- | -------------------------------- |
| bytes and media type | `file`                           |
| fixed policy         | `model=default`                  |
| language             | `language` when present          |
| vocabulary           | `prompt` as comma-separated text |
| fixed policy         | `stream=true`                    |

OpenAI-Compatible Speech Server accepts prompt even when Parakeet cannot use it and logs that omission. It
returns one SSE event followed by `[DONE]`:

```text
data: {"type":"transcript.text.done","text":"..."}

data: [DONE]
```

T3's existing OpenAI SSE decoder already maps this to its authoritative `final` event. No
delta events are expected from the batch provider. Keep the existing empty-transcript policy.

Supported T3 upload media types are WAV, WebM, Ogg, MP4/M4A, and MPEG/MP3. Preserve the
original media type on the multipart `File`; OpenAI-Compatible Speech Server owns normalization.

## 5. Speech Mapping

Send T3 speech segments to `POST {baseUrl}/v1/audio/speech`:

```json
{
  "model": "default",
  "voice": "default",
  "input": "Text to speak",
  "response_format": "pcm",
  "speed": 1,
  "stream_format": "audio"
}
```

Map the T3 preset through `openaiSpeechServer.speechPresets` to `voice` and `speed`. Unknown presets
fail locally without an upstream request. Pass the response body through unchanged with
backpressure; never buffer or resample it.

Before forwarding the first byte, require the upstream content type to describe
`audio/pcm; rate=24000; channels=1; format=s16le`. T3 keeps emitting its established
`x-t3-audio-format: s16le;rate=24000;channels=1` header. Android playback does not change.

## 6. HTTP Lifecycle and Errors

Open and validate the upstream speech response before T3 commits its own `200` headers. This
turns authentication, validation, busy, and connection failures into normal T3 JSON errors
instead of truncated successful responses.

The response stream must remain pull-based. Interrupting the T3 request aborts the upstream
request so OpenAI-Compatible Speech Server can cancel or release its worker. An OpenAI-Compatible Speech Server connection abort
after PCM has started must propagate as an unclean T3 stream failure; never turn it into a
clean EOF.

Map failures into existing `VoiceError` reasons:

| OpenAI-Compatible Speech Server outcome       | T3 reason              | Retryable |
| --------------------------------------------- | ---------------------- | --------: |
| network/connect timeout/5xx/truncated stream  | `provider-unavailable` |       yes |
| 401/403                                       | `not-configured`       |        no |
| 400 validation/model/voice/format             | `unsupported-media`    |        no |
| 415 unsupported or mismatched media container | `unsupported-media`    |        no |
| 413                                           | `payload-too-large`    |        no |
| 429                                           | `quota-exceeded`       |       yes |
| 503/504 unavailable model or request timeout  | `provider-unavailable` |       yes |

Log T3's request ID with OpenAI-Compatible Speech Server's `X-Request-Id`, but never log text, transcripts,
audio, authorization headers, or response bodies.

## 7. Readiness

When either non-realtime capability selects `openai-speech-server`:

- missing base URL or token means `not-configured`;
- `/health/ready` non-200 or unreachable means `unavailable`;
- otherwise the capability is `ready`.

The existing T3 capability formats remain authoritative at the client boundary. They already
match OpenAI-Compatible Speech Server: bounded supported recording containers and s16le 24 kHz mono speech.
No native capability cache is required for the initial handoff.

## 8. Tests

Use an in-process fake OpenAI-compatible HTTP server in normal tests. Cover:

- provider selection for OpenAI, OpenAI-Compatible Speech Server, and mixed STT/TTS configurations;
- multipart fields, media types, bearer token, `model=default`, and `stream=true`;
- final-only SSE mapping into one T3 `final` event;
- preset mapping to `voice`, `speed`, PCM format, and unknown-preset rejection;
- PCM header validation and byte-for-byte streaming;
- backpressure and downstream-cancellation propagation;
- upstream abort after initial PCM causing an unclean downstream failure;
- pre-header 400/401/413/429/5xx and malformed error-envelope mapping;
- readiness for configured, missing-token, unreachable, and unhealthy states;
- confirmation that `agent.realtime` still resolves only to OpenAI.

Run an opt-in real-host verification from `srv` against
`http://192.168.50.72:6624` after unit and fake-server tests pass.

## 9. Deployment and Rollback

1. Configure the base URL and OpenAI-Compatible Speech Server token on `srv`.
2. Select `openai-speech-server` for transcription and run real dictation verification.
3. Select `openai-speech-server` for speech and verify playback, cancellation, and first-byte errors.
4. Leave realtime on OpenAI.

Rollback is a settings edit that selects `openai` for the affected non-realtime capability.

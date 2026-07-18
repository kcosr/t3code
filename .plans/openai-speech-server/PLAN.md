# OpenAI-Compatible Speech Server Integration

Branch: `feature/openai-speech-server`  
Worktree: `/home/kevin/worktrees/t3code-speech`  
Base: `product/integration` @ `e966d8a4a`  
Spec: `agent-context/repos/t3code/specs/t3-openai-speech-server-integration.md`  
Coordination: `agent-context/repos/t3code/specs/integration-worktree-coordination.md`

## Goal

Add a second production voice provider (`openai-speech-server`) for non-Realtime
capabilities only:

- `transcription.request`
- `speech.streaming`

`agent.realtime` remains fixed to OpenAI. Public T3 media routes, Android native
voice architecture, MP4/M4A upload boundary, and PCM response contract stay
unchanged. Clients never learn which upstream provider is selected.

## End-state contracts (no dual shapes)

### Settings (`packages/contracts` `VoiceSettings`)

Single end-state shape:

```json
{
  "voice": {
    "enabled": false,
    "...existing policy fields...": "...",
    "providers": {
      "transcription": "openai",
      "speech": "openai"
    },
    "openaiSpeechServer": {
      "baseUrl": "",
      "connectTimeoutSeconds": 15,
      "speechPresets": {
        "default": { "voice": "default", "speed": 1 },
        "warm": { "voice": "af_sky", "speed": 1 }
      }
    }
  }
}
```

Rules:

- Selection fields accept only `"openai" | "openai-speech-server"`.
- Use existing `mediaRequestTimeoutSeconds` for total request/stream bounds.
- Provider-specific `connectTimeoutSeconds` only for the speech-server adapter.
- Upstream model is always the literal `default`.
- No aliases, no transitional parser, no second timeout field.

### Credentials

Replace OpenAI-only store and routes with provider-keyed operations only:

| Method | Route / API | Result |
| ------ | ----------- | ------ |
| list | `GET /api/voice/credentials` | `{ credentials: [{ providerId, configured, updatedAt }] }` |
| set | `PUT /api/voice/credentials` | body `{ providerId, token }` → status for that provider |
| clear | `DELETE /api/voice/credentials/:providerId` | status for that provider |

- Secret store keys: `voice-openai-api-key` (existing) and
  `voice-openai-speech-server-token` (new).
- Never return token values. Never store tokens in settings.
- Remove `getOpenAiApiKey` / `setOpenAiApiKey` / `clearOpenAiApiKey` / singular
  status shapes from the service and HTTP surface.

### Speech synthesizer

Replace lazy-only synthesize with prepare-then-stream so upstream status and PCM
content-type are validated before T3 commits `200`:

```ts
interface SpeechSynthesizer {
  readonly prepare: (
    request: SpeechSynthesisRequest,
  ) => Effect.Effect<Stream.Stream<Uint8Array, VoiceError>, VoiceError>;
}
```

Update OpenAI and speech-server adapters to this single contract. Media route
calls `prepare` before `HttpServerResponse.stream`.

## Implementation order

1. **Contracts / settings**
   - Extend `VoiceSettings` + patch schemas.
   - Provider-keyed credential schemas in `packages/contracts/src/voice.ts`.
   - Update `environmentHttp` credential endpoints.
   - Settings decode tests.

2. **Credential store**
   - Provider-keyed `VoiceCredentialStore` service + layer.
   - Update OpenAI provider to `get("openai")`.
   - Update control HTTP handlers.
   - Credential store tests.

3. **Shared OpenAI-compatible helpers**
   - Extract narrowly reusable pieces from `OpenAiVoiceProvider`:
     - transcription SSE event schema + NDJSON mapping
     - multipart transcription form builder fields shared by both
     - upstream HTTP status → `VoiceError` mapping
     - PCM content-type validation
   - Place under `apps/server/src/voice/Providers/openaiCompatible/`
     (or similar). Avoid a second private decoder/lifecycle copy.

4. **Speech synthesizer contract + OpenAI adapter**
   - Change `SpeechSynthesizer` to `prepare`.
   - OpenAI: execute request, require 2xx + compatible PCM content-type, then
     return body stream.
   - Update media `http.ts` speech route to await prepare before responding.
   - Update OpenAI provider tests.

5. **Dynamic registry**
   - Resolve selections from `ServerSettingsService` on each `resolve` call.
   - Hard-map `agent.realtime` (and unavailable `transcription.realtime`) to
     `openai`.
   - In-flight requests keep the provider already resolved for that request.
   - Register both adapters in `runtimeLayer.ts`.

6. **`OpenAiSpeechServerVoiceProvider`**
   - Capabilities: transcription + speech only.
   - Transcription: `POST {baseUrl}/v1/audio/transcriptions` with
     `model=default`, `stream=true`, language/prompt mapping, bearer token,
     validated MP4 media type on multipart file.
   - Speech: `POST {baseUrl}/v1/audio/speech` with model/voice/speed/format
     mapping from presets; unknown preset fails locally; PCM header validation
     before success; byte-for-byte streaming with cancellation.
   - Health: `GET {baseUrl}/health/ready` with connect timeout.
   - Map status codes per spec table; log request id + sanitized upstream
     `X-Request-Id` only.

7. **Capability readiness**
   - `GET /api/voice/capabilities` derives state per capability from the
     selected provider:
     - global disabled → `disabled`
     - missing config/credential → `not-configured`
     - speech-server health fail/timeout → `unavailable`
     - otherwise → `ready`
   - Realtime always OpenAI credential readiness.
   - Mixed selection may report different states.

8. **Operational configuration**
   - Server settings schema is the configuration surface (no dual config path).
   - Do not add Android Settings UI (Android stream owns mobile settings).
   - No web voice settings page exists today; do not invent a large unrelated UI.
     Credential routes remain available for `voice:manage` clients/scripts.

9. **Docs**
   - Update `docs/architecture/voice.md` to describe two non-Realtime providers,
     selection, credentials, readiness, and Realtime still OpenAI-only.

10. **Tests**
    - In-process fake OpenAI-compatible HTTP server covering the required matrix
      from the spec (selection, credentials, SSE, presets, PCM validation,
      cancellation, error mapping, readiness, MP4 boundary).
    - Update existing OpenAI/registry/credential/settings tests for new shapes.
    - Do not broaden public upload formats.

## Out of scope

- Pi provider
- Android native architecture changes
- Realtime on non-OpenAI providers
- Merging into `product/integration`
- Compatibility aliases / dual credential APIs
- Broadening client media formats

## Shared-surface ownership notes

| Surface | This stream | Concurrent Android stream |
| ------- | ----------- | ------------------------- |
| `apps/server/src/voice/` providers, registry, credentials | **Owns** | Avoid |
| `packages/contracts` voice credential + settings additive fields | Additive only | Additive only |
| Android `t3-voice` / mobile Settings | Do not touch | Owns |
| Public media routes/formats | Preserve | Preserve |

Expected integration conflicts: `packages/contracts/src/settings.ts`,
`packages/contracts/src/voice.ts`, `packages/contracts/src/environmentHttp.ts`
if Android also patches shared schemas. Keep edits additive and tightly scoped.

## Verification

Before handoff:

- `vp check`
- `vp run typecheck`
- Focused voice/settings/credential/provider tests
- `vp test` if practical
- Commit completed work with clear messages
- Push `feature/openai-speech-server`
- Report SHAs, checks, files, unresolved decisions, merge notes

Real-host acceptance against `http://192.168.50.72:6624` is opt-in after fake
tests pass; not required for the implementation commit if the host is
unavailable, but document how to run it.

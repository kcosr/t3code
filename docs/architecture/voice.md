# Voice Architecture

## Status and authority

This is the sole authoritative design-as-built document for T3 voice. It describes behavior present
in the repository today. Source code remains authoritative when this document and the implementation
disagree.

Active cleanup is tracked in [voice-next-steps.md](../../plans/voice-next-steps.md). Possible future
features live in [voice-roadmap.md](../../specs/voice-roadmap.md); roadmap entries are not current
requirements.

Android is the only implemented semantic voice runtime. Shared TypeScript contracts and presentation
logic are platform-neutral, but there is no web, desktop, or iOS voice-runtime adapter yet.

## Product surfaces

The mobile app exposes five related voice surfaces:

1. The microphone beside the Thread composer performs one bounded dictation. Its transcript remains
   in the draft and is not submitted automatically.
2. The waveform beside the Thread composer controls native Thread voice, also called Auto Listen.
   Thread voice records, detects an endpoint, transcribes, optionally reviews, dispatches the Thread
   turn, waits for the exact result, optionally speaks it, and may rearm according to user settings.
3. The persistent bottom call bar belongs only to Realtime voice. It opens or resumes a durable voice
   conversation and always exposes the shared native audio-route selector. While Realtime is active,
   it also exposes transcript, mute, and stop controls. While Thread voice is active, the bar remains
   a Realtime Resume surface.
4. Android Thread Auto Listen can speak the response produced by its own native cycle. Arbitrary
   message read-aloud and tap-to-hear are not implemented on Android. The generic React speech
   implementation remains in source for future non-Android use, but no current web, desktop, or iOS
   adapter exposes that feature.
5. On Android, opt-in Background Voice Controls keep a native Ready notification and MediaSession
   available after an operation ends. The user chooses Realtime or the latest valid Active Thread as
   the default next interaction and can start it without React remaining attached.

Starting Realtime while Thread voice is active performs one native Thread-to-Realtime transition.
Starting Thread voice while Realtime is active performs one native Realtime-to-Thread transition.
Only one semantic or bounded media owner may use capture, playback, audio focus, or routing at a
time.

## Deployed architecture

```text
React Native UI
  composer controls / Realtime call bar / readiness settings
             |
             | semantic commands, prepared readiness, and snapshots
             v
Android microphone foreground service
  serialized native controller + process-local Ready envelope
  notification + MediaSession
  WebRTC / recorder / PCM player / audio focus and routes
             |
             | authenticated T3 control and media APIs
             v
T3 environment server ---- VoiceProviderRegistry ---- OpenAI
  voice sessions / media                              transcription / speech / Realtime
  signaling and tools
  media tickets                                       OpenAI-compatible speech server
                                                      transcription / speech only
```

There are two media paths:

- Bounded transcription and speech use authenticated T3 HTTP endpoints. The server validates media,
  applies byte, duration, concurrency, and timeout limits, and routes each capability through
  `VoiceProviderRegistry` to the selected provider (`openai` or `openai-speech-server`).
- Realtime audio flows directly between Android and OpenAI over WebRTC. The T3 server authenticates
  session creation, proxies SDP negotiation, attaches a provider sideband connection, executes the
  allowlisted T3 tools, and publishes normalized session events. Realtime always uses OpenAI.

Provider API keys and speech-server tokens remain in the server secret store, keyed by provider id.
Clients receive neither provider credentials nor raw provider control events. Android and web clients
do not learn which non-Realtime provider is selected.

## Server capabilities and APIs

`GET /api/voice/capabilities` reports configuration and readiness for:

- `transcription.request` — implemented bounded MP4 transcription;
- `speech.streaming` — implemented PCM speech streaming;
- `agent.realtime` — implemented Realtime voice agent; and
- `transcription.realtime` — part of the contract but currently reported unavailable when Realtime
  is otherwise ready.

Readiness is derived per capability from the selected provider:

- voice globally disabled → `disabled`;
- missing provider configuration or credential → `not-configured`;
- selected speech-server health check fails or times out → `unavailable`;
- configured and healthy → `ready`.

`transcription.request` and `speech.streaming` may select different providers. `agent.realtime`
always uses OpenAI.

The control API also provides:

- voice-session create, read, heartbeat, focus update, close, event polling, and WebRTC offer;
- Realtime confirmation decisions and client-action acknowledgements;
- voice-conversation create, list, read, rename, transcript, clear-context, and delete;
- one-use media tickets;
- bounded Android native child sessions; and
- provider-keyed credential status, set, and clear operations
  (`GET/PUT /api/voice/credentials`, `DELETE /api/voice/credentials/:providerId`).

`POST /api/voice/transcriptions` accepts one validated `audio/mp4` upload and streams transcript
deltas followed by one final result. `POST /api/voice/speech` validates upstream status and PCM
format before committing success, then returns cancellable, backpressured 24 kHz mono signed 16-bit
PCM. Android Thread voice requests one-use tickets for these routes while React is detached;
React-owned composer dictation requests its own transcription tickets. The server speech route and
generic React playback implementation remain available to code, but arbitrary message read-aloud is
not exposed by a current platform adapter.

Server settings select non-Realtime providers and configure the optional OpenAI-compatible speech
server:

```json
{
  "voice": {
    "providers": {
      "transcription": "openai",
      "speech": "openai"
    },
    "commandTools": [],
    "openaiSpeechServer": {
      "baseUrl": "http://192.168.50.72:6624",
      "connectTimeoutSeconds": 15,
      "speechPresets": {
        "default": { "voice": "default", "speed": 1 },
        "warm": { "voice": "af_sky", "speed": 1 }
      }
    }
  }
}
```

Selection is observed on each new media request. Changing settings does not require a process
restart and does not alter an already in-flight request. `commandTools` is snapshotted when a
Realtime session is created; later settings edits affect only new sessions.

## Conversations, sessions, and calls

T3 keeps three identities separate:

- A voice conversation is the T3-owned semantic history represented by `VoiceConversationId`.
- A voice session is one active client attachment represented by `VoiceSessionId`.
- A provider call is an ephemeral OpenAI Realtime resource and is never the durable T3 identity.

A new Realtime start selects either a new conversation or a previously saved durable conversation.
Durable conversations and normalized journal entries are stored in SQLite. Production writers
currently record final user and assistant transcripts, tool requests and results, context changes,
and clear-context markers. Raw audio, SDP, credentials, and provider event dumps are not journal
data.

The server compiles a bounded set of current-epoch journal entries when opening a provider call.
Clear context advances the conversation epoch, leaving older entries visible in history but
excluding them from later provider context. Automatic summary generation is not implemented.

Continuing a conversation that already has an active lease requires explicit takeover. The server
fences and closes the prior session, advances the lease generation, and starts a new provider call
from the durable conversation context. This is semantic continuation, not transfer of a live WebRTC
connection.

Realtime sessions are capped below the provider maximum. A rotation event ends the current call;
continuation requires an explicit new session against the durable conversation. A closed or failed
provider call is never presented as resumed.

## Realtime tools

The Realtime voice-agent allowlist is:

- `list_projects`
- `list_threads`
- `list_provider_models`
- `get_thread_status`
- `get_thread_messages`
- `wait_for_thread_turn`
- `search_history`
- `read_history`
- `activate_thread`
- `stop_realtime_voice`
- `switch_to_thread_voice`
- `create_thread`
- `send_thread_message`
- `interrupt_thread`
- `archive_thread`

Every Realtime voice-agent tool is defined once as a typed model-tool definition in
`apps/server/src/voice/modelTools/`. Each definition owns the Effect input schema, generated JSON
Schema, and description (with full execute bodies for tools that have been extracted). Direct
Realtime declarations and command-wrapper exposure are adapters over those definitions.

Optional server setting `voice.commandTools` (default `[]`) is an allowlist of any public
`VoiceToolName`. When a name is listed, the server omits its direct function declaration for the
session and exposes it only through the session-internal command meta-tools:

- `command_list` — compact catalog of command-exposed tools
- `command_describe` — description plus generated input schema for one catalog entry
- `command_execute` — normalizes `{ command, payload }` into the effective business-tool invocation
  before the existing voice executor runs

Meta-tool names are not public `VoiceToolName` values and never appear in client/native tool events.
`command_execute` reuses the outer tool-call IDs and the existing executor path, so wrapped
`list_threads` / `create_thread` calls keep the same authorization, journaling, durable identity,
and outputs as direct calls. The resolved `commandTools` set is snapshotted when a Realtime session
is created and reused for every tool-declaration rebuild (including terminal `session.update`).

Read tools execute on the server against bounded projections. `list_provider_models` returns
configured provider instances and model catalogs (including reasoning/option descriptors).
`create_thread` accepts optional `instanceId`, `model`, and `options` (for example reasoning
effort) from that catalog; omitted selection uses the project default. `create_thread` and
`send_thread_message` dispatch immediately with deterministic identifiers; a successful receipt is
not a claim that downstream work completed. `wait_for_thread_turn` polls the exact dispatched
message and never redispatches it. `interrupt_thread` dispatches immediately. `archive_thread`
requires explicit client confirmation.

`activate_thread` changes visible focus while Realtime continues. `switch_to_thread_voice` requires
one explicit `threadId`; it never infers a destination from the currently visible or last-used
Thread. The server validates and resolves that identifier into the complete authorized Thread target
before publishing an action.

`stop_realtime_voice` and `switch_to_thread_voice` are terminal actions. The server acknowledges the
provider function call without requesting another response, then publishes one fenced native action.
Android fences new microphone input, drains already queued final speech within a bounded deadline,
and performs the native stop or resolved switch. React is not required to be attached. When React is
attached, it reconciles navigation from the resulting native Thread snapshot; it does not own or
complete the media transition.

No shell, terminal, filesystem, Git, arbitrary MCP, or coding-agent provider tool is exposed through
the voice-agent allowlist.

## Android runtime ownership

The Android foreground service owns one process-local serialized controller. Its top-level states
are:

```text
Idle
Realtime
SwitchingToThread
Thread
SwitchingToRealtime
Failed
```

Realtime and Thread contain operation-specific phases. Every public snapshot includes an in-memory
generation and monotonically increasing publication sequence. Native callbacks carry the generation
that admitted their work, so late callbacks from an earlier owner cannot mutate its replacement.

React, notification intents, and MediaSession callbacks dispatch the same typed controller commands.
React subscribes to complete snapshots and does not maintain a second Android voice state machine.
The native bridge does not expose credentials, provider identifiers, SDP, raw provider events, or
temporary recording paths.

On Android, Thread Auto Listen response speech is owned by the semantic native runtime only
(`playResponses`). The Thread screen mounts a small native snapshot/settings adapter rather than
React's assistant-message observer and generic PCM state machine. The always-mounted runtime
provider synchronizes preference changes into an active native cycle even when that screen is
unmounted. Headset input during response playback **skips** speech (cancel + complete cycle)—not
pause/resume. Thread-to-Realtime handoff is a single native transition; React does not dispatch a
competing Skip first. After permanent playback focus loss, Auto Listen reacquires capture focus
before rearming, with bounded exponential retry backoff. A denied retry does not change Android's
process-wide communication mode or route.

### Realtime-to-Thread

A user-initiated switch from the composer supplies the visible Thread target. An agent-initiated
`switch_to_thread_voice` action instead carries the complete server-resolved target for its required
`threadId`. Neither path depends on a cached current or last Thread.

The switch immediately enters the native transition, rejects conflicting controls, closes the
server session and WebRTC peer, waits for exact peer and microphone release, advances the generation,
and starts Thread recording for that target. This is one native atomic ownership transition even
when React is backgrounded or detached. Failure does not roll back into Realtime, and no durable
switch transaction is created.

For an agent-initiated switch, a bounded playout drain may delay peer close so the agent's final
transition sentence can finish, but Thread recording still waits for exact native quiescence.

### Thread-to-Realtime

Before admission, React performs the visible permission checks and obtains a fresh bounded native
child credential. The Android adapter re-reads the native mode immediately before admission and
selects either an Idle start or a Thread handoff, so a mode change during permission prompts cannot
send the stale command. For a handoff, Android stops the active Thread recorder, request, wait, or
playback path, waits for its exact release callback, advances the generation, and starts the
selected Realtime conversation. Once admitted, Activity backgrounding or React detachment does not
interrupt the transition. Stop during the transition cancels the pending Realtime start.

## Thread voice

Native Thread voice owns the complete background-capable cycle:

1. record and detect an endpoint;
2. obtain a one-use transcription ticket and upload the bounded recording;
3. review or auto-submit according to settings;
4. dispatch one idempotent `thread.turn.start` command;
5. poll the exact dispatched message outcome;
6. optionally obtain speech tickets and play the settled assistant response; and
7. optionally rearm after the configured guard.

The outcome route is
`GET /api/orchestration/threads/:threadId/messages/:messageId/turn`. It distinguishes pending,
running, approval-required, user-input-required, completed, interrupted, failed, and ambiguous
outcomes. Dispatch retries retain the same command and message identifiers; outcome polling cannot
create another turn.

Recordings are deleted after their bounded transcription attempt. Startup performs a bounded cleanup
of abandoned cache files; files are not treated as resumable session state.

The endpoint detector is the single authority for usable Thread speech. Automatic endpointing and a
manual Finish both settle through the same terminal recorder arbitration, including one final
amplitude observation and the configured minimum-speech requirement. A manual or automatic cycle
with no usable speech deletes the recording without requesting a media ticket or transcription.
A defensively blank native transcription result is handled as the same no-input outcome rather than
as a transcription failure.

No-input and recoverable failures before Thread message dispatch are cycle outcomes, not sticky
runtime failures. Continuous Thread voice rearms after its configured delay; one-shot Thread voice
stops to Idle. The privacy-safe failure reason remains visible during the rearm or stop transition
and clears when the next recording starts. Submission and later failures remain terminal because a
message may already have been dispatched; they never auto-rearm or submit another turn.

## Android lifecycle and controls

A visible user action supplies microphone permission and starts the microphone foreground service.
The service owns the controller, media resources, network work, notification, MediaSession, and a
bounded wake lock while an operation is active. It does not retain an Activity, React context, or
Expo module.

Activity backgrounding, recreation, React remount, navigation, screen lock, and best-effort task
removal do not themselves stop the service. The service is `START_NOT_STICKY`: process termination,
force-stop, reboot, application update, or native crash ends the live operation. A fresh process
starts in `Idle`; sockets, peers, recorders, callbacks, timers, and mode switches are never restored
from persistence.

Android also has a separate opt-in readiness posture around that operation controller. While React
is attached, it resolves the configured default into one complete start command and issues a bounded
native child credential. Realtime readiness always contains a concrete durable conversation
continuation: React selects the latest durable conversation or creates one before configuring
native, so repeated background starts continue the same prepared conversation. Active Thread
readiness contains the complete current Thread target and settings; if the remembered Thread can no
longer be resolved, native reports it unavailable and never falls back to Realtime.

The readiness postures are `Disabled`, `Ready`, `Unavailable`, and `NeedsRefresh`. Configuration is
an atomic full replacement fenced by a monotonic readiness generation. A Ready service owns no
recorder, WebRTC peer, playback stream, audio focus, or wake lock. It retains only the foreground
notification and paused MediaSession needed for background controls. Start dispatches the cached
command directly through the same controller admission path used by React. Active operation state
always takes presentation precedence; stop or normal completion returns to Ready when it remains
enabled.

Prepared commands and child credentials exist only in the application process and are accepted only
before the credential's parsed expiry. Expiry or a bounded Realtime lease conflict changes readiness
to `NeedsRefresh`; later media-button presses do not retry or guess. Process death removes Ready just
as it removes live operations. The durable enabled/default/latest-Thread preferences cause
reprovisioning only after the app is attached again. Native persists no target or credential; its
only readiness persistence is a generation marker allowing an explicit notification Disable to be
reconciled durably into the saved enabled setting on the next React attach.

The combined notification is derived from the active controller snapshot or, when no operation owns
the service, the readiness snapshot:

- Ready exposes Start and Disable. Unavailable and Needs Refresh expose Disable and require the app
  to resolve a new target or credential before Start returns.
- Realtime exposes mute or unmute and stop. When React has explicitly provisioned a complete latest
  Thread target, it also exposes a fenced Thread switch; it never resolves a destination inside the
  background service.
- Thread exposes finish utterance while recording, submit while reviewing, skip while playing a
  response, and stop.
- Transitions expose stop.
- A failed owner retains a Stop-only foreground notification only while native release remains
  unresolved. Exact cleanup returns the operation controller to Idle, so enabled readiness becomes
  actionable again without requiring a separate acknowledgement.

MediaSession transport controls map to the same native commands. Recognized media-button key-up and
repeat events are consumed without dispatch; only the initial key-down can act. In Ready, headset
hook, play, and play/pause start, while pause and stop never start. During Thread response playback,
every recognized headset transport key maps to Skip (cancel remaining TTS and complete the cycle:
rearm when auto-rearm is on, otherwise stop and release). The notification's explicit Stop action
remains a full session teardown.
Background Voice Controls require notification permission when enabled; notification permission
denial for an already active visible operation still reduces drawer visibility without creating a
second control path.

Android owns and persists one global preferred audio route. The always-visible selector in the
Realtime call bar and the selector in Voice Settings read and write that same native preference.
Native media owners apply it to Realtime, Thread voice, and one-shot composer dictation without
requiring React to remain attached. If the preferred device is temporarily unavailable, Android uses
an available system route without erasing the preference and reapplies it when it becomes available.

## Authentication and authorization

Voice media, conversation, session, event, and confirmation operations require `voice:use`.
Credential administration requires `voice:manage`. Voice tools recheck the scope required by their
underlying orchestration or history operation.

After a visible Android start or readiness provisioning, the authenticated client can request a
bounded native child bearer
with exactly `voice:use`, `orchestration:read`, and `orchestration:operate`. Its lifetime is the
lesser of twelve hours and the parent session's remaining lifetime. It cannot mint another child.
Parent revocation invalidates child-owned sessions and media tickets.

Media tickets are short-lived, one-use, operation- and request-bound credentials for transcription
upload or speech streaming. They do not grant general voice or orchestration access.

## Diagnostics and privacy

Server diagnostics are structured privacy-safe logs containing curated identifiers, enums, counts,
byte totals, timings, and outcomes. Android keeps a bounded in-memory diagnostic ring for lifecycle,
route and focus, endpoint, terminal-code, and numeric media events.

Neither diagnostics path may contain transcript or query text, audio, SDP, credentials, provider
payloads, raw provider identifiers, tool arguments or results, or temporary recording paths. The
generic diagnostic ring remains part of the product for troubleshooting; temporary milestone
tracing is not part of the design.

## Current limitations

- The semantic native runtime exists only on Android.
- Realtime transcription is represented in contracts but unavailable in the configured provider.
- OpenAI is the only configured production voice provider, with server-pinned models and presets.
- Automatic conversation summaries and seamless context-limit call replacement are not implemented.
- Session rotation and terminal provider failures require an explicit new call.
- Durable conversations have explicit clear and delete controls but no automated age or size
  retention policy.
- Live Android sessions do not survive application-process termination.

Possible changes to these limitations belong in the non-authoritative roadmap until separately
specified and approved.

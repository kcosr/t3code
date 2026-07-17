# Voice Roadmap Ideas

Status: Non-authoritative idea inventory.

Nothing in this document is an implementation commitment, accepted product requirement, or active
work item. The current system is defined by
[voice.md](../docs/architecture/voice.md), and current cleanup is tracked in
[voice-next-steps.md](../plans/voice-next-steps.md).

Before implementation, any idea here requires explicit product approval, verification against the
then-current code, and its own scoped specification or plan with acceptance criteria. Moving an idea
into active work should remove it from this document or replace it with a link to that approved spec.

## Cross-platform runtimes

### Web and desktop voice

The shared semantic snapshots, adapter interface, conversation APIs, and presentation helpers were
designed so a browser or desktop adapter can provide the same product concepts. No such runtime is
implemented today.

A future spec would need to decide browser permission UX, background limitations, WebRTC and audio
route behavior, Thread voice ownership, notification equivalents, and parity expectations rather
than assuming Android service semantics apply.

### iOS voice

An iOS adapter could implement the same semantic contract with Apple media and background APIs. It
would need a native lifecycle, audio-session, interruption, route, background-execution, and release
design of its own. Sharing semantic behavior does not imply sharing Android media code.

## Additional voice capabilities

### Realtime transcription

`transcription.realtime` exists in shared schemas and capability discovery but is deliberately
reported unavailable by the configured server. A future feature would need a provider adapter,
client media owner, normalized events, lifecycle and quota rules, and a clear product surface.

### Automatic summaries and longer context

The durable journal and context compiler can represent summary entries, but production code does not
generate them. A future design could create versioned summaries and choose when they replace older
model-visible entries without changing the durable transcript.

Summary generation must be idempotent, bounded, auditable, and resistant to elevating untrusted
history or tool content into instructions.

### Smoother Realtime call rotation

The current duration or terminal failure path ends the provider call and requires explicit Resume.
A future design could reduce interruption when rotating calls or recovering from context limits.
It must not claim to transfer or resurrect a provider WebRTC call and must preserve lease fencing,
single media ownership, and explicit failure semantics.

### Configurable providers, models, and presets

The server has a provider interface but configures one OpenAI adapter with server-pinned models and
voice presets. Future work could connect voice capabilities to provider instances, add another
provider, or expose administrator-selected model and preset configuration.

Provider credentials and raw configuration must remain server-side, and clients should continue to
consume capability and preset contracts rather than arbitrary provider payloads.

## Conversation lifecycle

### Automated retention

Durable conversations currently support explicit clear-context and delete operations. Optional age,
count, or storage-based retention could be specified later, including user visibility, deterministic
deletion behavior, active-lease handling, and audit requirements.

### Conversation search and organization

Future product work could add richer filtering, pinning, grouping, export, or conversation metadata.
Any export design must preserve transcript privacy and exclude credentials, SDP, provider event
dumps, and raw audio.

## Controls and experience

### Expanded headset and platform controls

Android currently exposes state-dependent notification and MediaSession actions plus Realtime output
route selection. Future work could define richer physical headset actions, route preferences,
Bluetooth-specific behavior, or platform-equivalent controls after validating device and OS
constraints.

### Additional Thread voice policies

Possible ideas include more endpoint presets, selective playback, alternative review policies, or
accessibility-focused feedback. They should remain explicit user settings and must preserve one media
owner and exact dispatch correlation.

## Operations, safety, and diagnostics

### Aggregated metrics

Current operations rely on privacy-safe structured server logs and a bounded Android diagnostic
ring. A future observability spec could add aggregate counters and latency distributions for media,
signaling, tools, and native lifecycle without collecting transcript, audio, SDP, credentials,
provider payloads, or raw provider identifiers.

### Provider safety identifiers

Where a provider supports a privacy-preserving stable safety identifier, a future design could derive
and attach one at the server boundary. It would need an explicit identity source, rotation and
deletion policy, and proof that clients cannot choose or spoof it.

### Gated provider and device automation

Opt-in provider tests and broader device automation could cover real transcription, speech,
Realtime negotiation, routes, interruptions, and background lifecycle. These are test-infrastructure
ideas, not claims about current release coverage.

## Explicitly parked directions

The following are not roadmap commitments and should not be revived accidentally from historical
kernel or workstream documents:

- resurrection of a live Android voice operation after process death, force-stop, reboot, update, or
  native crash;
- durable effect journals, consumer elections, compensation ledgers, or prepare/commit/rollback for
  in-process voice mode switches;
- simultaneous native microphone owners;
- a React-owned Android state machine alongside the native controller;
- always-on background microphone or ambient wake-word capture;
- raw audio retention by default; and
- compatibility bridges for obsolete runtime shapes.

Reconsidering one of these directions requires a new product decision and architecture spec; its
appearance in Git history is not sufficient authority.

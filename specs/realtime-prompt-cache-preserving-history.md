# Realtime Prompt-Cache-Preserving History

Status: Design notes and requirements

## Purpose

T3 must preserve durable voice-conversation continuity without unnecessarily defeating provider
prompt caching. These are related but distinct requirements:

- **Semantic continuity** means a replacement call receives enough faithful history to continue the
  conversation correctly.
- **Cache-faithful replay** means a provider receives the same ordered model-input prefix it saw
  previously, allowing its prompt cache to match.

The current transcript-oriented replay provides partial semantic continuity, but it is not
cache-faithful. This document defines the intended end state and records the limitations of the
current OpenAI Realtime API.

## Provider Facts And Limits

OpenAI prompt caching matches an exact prompt prefix. For Realtime conversations, that prefix may
contain text, audio, images, tool definitions, function calls, and function-call outputs. A change
near the beginning invalidates caching for everything after that change.

Within one live Realtime call, OpenAI maintains the native Conversation and can automatically cache
prior audio, text, and tool activity as later Responses reuse that prefix. T3 does not need to
reconstruct the conversation between turns in the same call.

Across calls, T3 must populate a new Conversation. OpenAI's `conversation.item.create` supports
messages, user input audio, function calls, and function-call outputs, but currently cannot populate
assistant audio messages. Consequently, T3 cannot reproduce a prior audio conversation byte-for-byte
after the first assistant-audio turn. Full cross-call audio-cache continuity must not be claimed
unless OpenAI adds assistant-audio replay or a provider-side conversation continuation mechanism.

Hidden model reasoning is not a replay artifact. T3 preserves an explicitly returned, replayable
reasoning item only if a provider exposes one in its conversation contract; it does not request,
persist, or synthesize hidden chain-of-thought.

Relevant OpenAI documentation:

- <https://developers.openai.com/api/docs/guides/prompt-caching>
- <https://developers.openai.com/cookbook/examples/prompt_caching_201#7-realtime-api>
- <https://developers.openai.com/api/docs/guides/realtime-costs#truncation>
- <https://developers.openai.com/api/reference/resources/realtime/client-events#conversation.item.create>

## Current T3 Gap

T3 currently stores final user and assistant transcripts and canonical tool journal records, but its
provider-neutral replay contract only represents `{ role, text }`. Compilation and OpenAI replay
therefore alter the original provider input:

- Transcript whitespace is normalized.
- Tool requests are omitted.
- Tool results are rewritten as synthetic system messages.
- Every replay item is sent as a regular message rather than a native function call or output.
- User and assistant audio are not part of durable replay.
- Provider-reported cache usage is not used to verify the effectiveness of the policy.

This is sufficient for limited text continuity but not for exact structured replay or dependable
cache reuse across replacement calls.

## Required Architecture

### 1. Two Durable Representations

The durable voice store must distinguish:

1. **Canonical conversation units**, which are provider-neutral and remain the source of truth for
   history, search, migration, compaction, and use by a different provider.
2. **Replay artifacts**, which retain exact provider-renderable content needed to reconstruct the
   recent verbatim prefix for the provider and model family that produced it.

Replay artifacts must contain model-facing items, not raw WebSocket events. Transport event IDs,
acknowledgements, timing events, audio deltas, SDP, and connection metadata are not conversation
history.

The canonical layer must remain useful when replay artifacts expire, are deleted, use an
incompatible provider/model/configuration, or cannot be represented by the destination provider.

### 2. Provider-Neutral Structured Items

The provider-neutral continuation contract must be a discriminated union rather than `{ role,
text }`. At minimum it must represent:

```text
message
  role: system | user | assistant
  ordered content blocks

tool-call
  stable callId
  name
  canonical argumentsJson

tool-result
  matching callId
  exact output
```

Text content in the recent verbatim window must be preserved byte-for-byte. Compilation must not
trim, reserialize, summarize, or otherwise normalize it.

Tool calls and results are one atomic conversation unit. The compiler must include both in their
original order or include neither. Canonical JSON serialization happens once when a call is first
recorded; recompilation must reuse those stored bytes.

The OpenAI adapter must render these units as native `message`, `function_call`, and
`function_call_output` items with matching `call_id` values. Every injected item must receive and
validate its provider acknowledgement before session startup succeeds.

### 3. Stable Instructions And Tools

System instructions, tool definitions, structured schemas, and their ordering form the beginning of
the model-input prefix. They must be deterministic and versioned.

Each provider call must record a configuration fingerprint covering at least:

- Provider and model identifier.
- Instruction version and exact rendered instruction bytes.
- Ordered tool names, descriptions, and schemas.
- Relevant modality, audio-format, voice, reasoning, and truncation settings.
- Replay encoding version.

A configuration mismatch must be explicit. T3 may still compile semantically equivalent canonical
history, but it must not report that replay as cache-faithful.

### 4. Audio Policy

Realtime audio is part of the provider's cached input during a live call. T3 should rely on the
provider-native Conversation for this caching while that call remains active.

Persisting user input audio for cross-call replay is optional until measurement establishes a useful
cache or fidelity benefit. If implemented, it requires:

- Capturing the exact encoded bytes supplied to the provider, not a later transcription or
  independently re-encoded recording.
- Recording format, sample rate, channels, preprocessing, chunking/commit semantics, byte length,
  and a content hash.
- Encrypted blob storage rather than base64 audio in journal rows.
- Conversation-scoped deletion, retention, quota, and migration policies.
- An explicit privacy setting for durable audio retention.

The current Android WebRTC path sends media directly to OpenAI, so exact user-audio retention would
require native capture-and-upload or a server media relay. This must be treated as a separate media
architecture decision.

OpenAI cannot currently populate assistant audio in a replacement Conversation. Storing assistant
audio may be useful for playback or audit, but it does not by itself enable an exact cross-call cache
prefix. T3 must replay the exact assistant transcript as `output_text` and classify the result as
semantic replay rather than full audio-cache replay.

### 5. Stable Compaction Checkpoints

Compaction must not produce a newly sliding prefix on every reconnect. The compiled layout should
be:

```text
stable instructions and ordered tools
versioned compacted checkpoint
append-only verbatim conversation units
```

A checkpoint remains immutable while new verbatim units are appended. When a new checkpoint is
required, creating it is an intentional cache-boundary change. The new checkpoint must then remain
stable across subsequent calls.

Deterministic compaction must:

- Preserve the newest contiguous dialogue in original order.
- Preserve recent full tool call/result pairs.
- Remove or compact older polling, repeated reads, and superseded tool results before dialogue.
- Preserve pinned durable facts, decisions, unresolved work, and active focus.
- Never alter or delete the underlying canonical journal.
- Produce identical output for identical journal state and configuration.

Model-generated summaries remain a separate feature. If introduced, their exact stored bytes and
version become part of the checkpoint; they must not be regenerated during every compilation.

### 6. Active-Call Truncation

Provider truncation affects only the ephemeral live Conversation. It must never delete T3's durable
journal or replay artifacts.

For OpenAI, use retention-ratio truncation so truncation happens in larger, less frequent steps. This
temporarily discards more active context but leaves a stable prefix for more subsequent turns than
just-in-time truncation. Replay acknowledgement failure remains fatal even when active-call
truncation is enabled.

### 7. Cache Observability

T3 must measure cache behavior rather than infer it from successful replay. Privacy-safe diagnostics
must record, when the provider exposes them:

- Total input tokens.
- Cached input tokens.
- Cache-write tokens, if applicable.
- Text and audio token breakdowns, if applicable.
- Provider call generation and configuration fingerprint.
- Replay item count, replay token estimate, acknowledgement count, and acknowledgement duration.
- Whether startup used exact structured replay, semantic replay, or a compacted checkpoint.
- Truncation count and retained-ratio policy.

Diagnostics must never log transcript text, audio, tool arguments/results, provider payloads,
credentials, or raw provider identifiers.

## Replay Classifications

Every replacement call should expose one internal classification:

- **native-continuation**: the provider continued the same native Conversation without rebuilding
  it.
- **cache-faithful**: all replayed model-input items are exactly reproducible for that provider and
  configuration.
- **structured-semantic**: messages and tool activity are structurally faithful, but at least one
  modality or provider-specific item cannot be reproduced exactly.
- **compacted-semantic**: older history is represented by a stable checkpoint plus an exact recent
  tail.

With the current OpenAI assistant-audio limitation, an ordinary resumed audio conversation will be
`structured-semantic` or `compacted-semantic`, not `cache-faithful`.

## Security And Lifecycle Requirements

- Durable and ephemeral voice conversations must honor their existing retention semantics.
- Clearing or deleting a conversation must delete associated replay artifacts and audio blobs.
- Audio and provider replay artifacts must not be included in history search results or logs.
- Provider-specific artifacts must not silently cross provider or incompatible model boundaries.
- Session rotation, device handoff, and reconnect must fence replay by conversation ID, context
  epoch, lease generation, configuration fingerprint, and replay encoding version.
- Partial, rejected, mismatched, or unacknowledged replay fails startup; it must not silently fall
  back to a lossy shape.

## Acceptance Tests

### Deterministic compilation

- Compiling the same journal and configuration twice produces byte-identical replay items.
- Recent text remains byte-identical, including whitespace and Unicode.
- Tool arguments and outputs remain byte-identical and both halves of a pair are always present.
- Orphaned, duplicate, malformed, and mismatched tool records are rejected or excluded
  deterministically.
- Old tool noise is compacted before ordinary dialogue.
- Synthetic histories around 16,000 and 50,000 tokens preserve boundary facts and complete units.

### Provider mapping

- OpenAI receives ordered native messages, function calls, and function outputs with matching
  `call_id` values.
- Each replay item is acknowledged; rejection, timeout, or incomplete acknowledgement fails startup.
- Stable instructions, tools, and replay items produce the same model-facing payload across calls,
  excluding transport-only identities proven not to affect model input.
- An incompatible provider/model/configuration fingerprint cannot be labeled cache-faithful.

### Cache behavior

- A multi-turn live call reports cached input after its prefix becomes eligible.
- Retention-ratio truncation causes an expected cache reduction once, followed by reuse of the new
  stable prefix.
- Reconnecting with unchanged structured history reports at least the stable instruction/tool prefix
  as cached when the provider cache is still available.
- Creating a new compaction checkpoint produces one expected cache-boundary change; later calls reuse
  that exact checkpoint.
- Tests and diagnostics distinguish provider cache eviction from T3 replay-shape drift.

### Audio limitations

- Tests prove that user audio can only be labeled exact when the stored bytes and encoding metadata
  match what was supplied to the provider.
- OpenAI replacement calls never claim full audio-cache replay while assistant audio cannot be
  injected.
- Transcript fallback preserves semantic continuity without being mislabeled cache-faithful.

## Open Decisions

1. Whether cross-call user-audio retention provides enough measurable benefit to justify native
   capture/upload, encrypted storage, privacy controls, and quotas.
2. Whether future providers offer native conversation continuation that avoids item replay entirely.
3. How long provider-specific replay artifacts should be retained after their likely cache lifetime,
   independently of the canonical conversation journal.
4. Whether provider cache metrics expose sufficient text/audio detail to verify exact replay in
   production.
5. When to introduce durable model-generated checkpoints after deterministic compaction is proven.

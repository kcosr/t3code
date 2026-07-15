# Agent History Search

## Status

Proposed architecture for provider-neutral search and bounded retrieval across T3 coding-thread
messages and durable voice-conversation history.

This proposal is additive. It does not make provider-owned session storage authoritative, expose
arbitrary database access, or load complete histories into every agent context.

## Problem

T3 already persists two useful forms of history:

1. Coding threads contain normalized `OrchestrationMessage` records with stable `MessageId` values.
2. Durable voice conversations contain normalized journal entries with an `entryId`, conversation,
   epoch, sequence, kind, payload, and timestamp.

The existing HTTP API can return the complete orchestration snapshot or one known thread, but it
does not provide server-side full-text search over thread messages. Voice APIs list conversation
summaries and manage retention, but they do not search or read journal entries. An agent therefore
cannot efficiently answer questions such as:

- "Which thread discussed Android background audio?"
- "Show the exact message where we selected the container format."
- "What did I tell the voice agent about the deployment last week?"
- "Read the turns surrounding that decision."

Loading every thread or replaying an entire voice journal is not an acceptable substitute. It is
expensive, exposes unrelated content to the model, and eventually exceeds provider context limits.

## Goals

- Search normalized T3 history across coding threads, durable voice conversations, or both.
- Return stable typed references that can be used to read an exact message or bounded context.
- Keep agent-facing tools provider-neutral and reusable by Realtime voice, Pi, Codex, Claude, and
  future agent runtimes.
- Apply source-specific authorization, retention, deletion, and clear-context semantics.
- Keep search and retrieval results bounded, attributable, and safe to place in model context.
- Avoid logging query text, message bodies, transcript text, or returned excerpts.

## Non-goals

- Searching provider-private session databases directly.
- Treating search results as trusted system instructions.
- Semantic/vector search in the first implementation.
- Searching raw audio, attachments, terminal output, arbitrary files, or deleted content.
- Giving an agent arbitrary SQL, FTS query syntax, regular expressions, or filesystem access.
- Replacing the normal bounded continuation context compiled for a Realtime call.

## Existing Data Sources

### Coding threads

`projection_thread_messages` is T3's normalized projection of provider-generated and user-generated
thread messages. Public thread messages already have a branded `MessageId`, role, text, turn ID,
streaming state, and timestamps.

Provider storage may retain a separate copy for provider-session resumption. Search uses the T3
projection so behavior is consistent across providers.

### Voice conversations

`voice_conversation_entries` stores durable normalized journal entries. Searchable entry kinds are:

- `transcript.user`;
- `transcript.assistant`;
- `summary`;
- `tool-result` using its compact normalized result;
- `context-change` using its normalized project/thread description.

`tool-request`, call boundaries, handoff markers, and context-cleared markers are not full-text
documents. They may still appear as metadata when reading a surrounding journal window.

Voice entry identity should become a shared branded `VoiceConversationEntryId`. Existing database
values remain the canonical IDs; this is a type-contract strengthening, not a second identifier.

## Agent-Facing Tool Model

Expose two tools instead of separate search/read tools for every history source.

### `search_history`

```ts
interface SearchHistoryInput {
  readonly query: string;
  readonly sources: ReadonlyArray<"thread-message" | "voice-entry">;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly voiceScope?:
    | { readonly type: "current-conversation" }
    | { readonly type: "conversation"; readonly conversationId: VoiceConversationId }
    | { readonly type: "all-durable" };
  readonly roles?: ReadonlyArray<"user" | "assistant" | "system">;
  readonly occurredAfter?: IsoDateTime;
  readonly occurredBefore?: IsoDateTime;
  readonly limit: number;
  readonly cursor?: string;
}
```

The result contains compact matches:

```ts
type HistoryItemRef =
  | {
      readonly type: "thread-message";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }
  | {
      readonly type: "voice-entry";
      readonly conversationId: VoiceConversationId;
      readonly entryId: VoiceConversationEntryId;
    };

interface HistorySearchMatch {
  readonly ref: HistoryItemRef;
  readonly containerTitle: string | null;
  readonly roleOrKind: string;
  readonly occurredAt: IsoDateTime;
  readonly excerpt: string;
  readonly score: number;
}
```

The server, not the provider model, creates excerpts and opaque pagination cursors. Results are
ordered deterministically by relevance, timestamp, source, and stable ID.

### `read_history`

```ts
interface ReadHistoryInput {
  readonly ref: HistoryItemRef;
  readonly before: number;
  readonly after: number;
}

interface HistoryReadResult {
  readonly target: HistoryRecord;
  readonly context: ReadonlyArray<HistoryRecord>;
}
```

`before` and `after` are bounded server-side. A zero/zero request reads one exact message. A larger
request returns neighboring messages from the same thread or entries from the same voice
conversation and epoch. Context ordering is chronological and the target is identified explicitly.

The tool must verify that the supplied item belongs to the supplied container. An item ID alone is
not accepted as authority.

## HTTP API

Add an authenticated history group to `EnvironmentHttpApi`:

```text
POST /api/history/search
POST /api/history/read
```

POST is used because filters are structured and search text should not be placed in URLs, proxy
logs, browser history, or access-log query strings.

The HTTP contracts mirror the agent tools but remain ordinary T3 APIs. Mobile, desktop, and future
non-voice agents can use the same endpoints. Provider adapters never call SQLite directly.

## Server Architecture

```text
Agent tool / T3 client
        |
        v
HistorySearchService
   |             |
   v             v
ThreadHistory   VoiceHistory
Index           Index
   |             |
projection_     voice_conversation_
thread_messages entries
```

`HistorySearchService` owns validation, authorization composition, result merging, ranking,
pagination, and response limits. Source adapters own source-specific SQL, decoding, retention
rules, and exact-record retrieval.

Do not create a single denormalized source-of-truth table. Thread projection updates and voice
journal writes already have different transactional owners. Separate indexes behind one service
preserve those ownership boundaries.

## Indexing

Use SQLite FTS5 in the first implementation:

- `projection_thread_messages_fts` indexes message text and references thread/message IDs.
- `voice_conversation_entries_fts` indexes extracted normalized text and references
  conversation/entry IDs, epoch, kind, and sequence.

Index maintenance occurs in the same transaction as the corresponding projection or journal
mutation. Reverts, thread deletion, conversation deletion, and retention cleanup remove indexed
documents transactionally.

The migration must backfill existing records before enabling the API. Backfill is restart-safe and
idempotent. Startup must fail clearly if the schema migration fails; search must not silently serve
an incomplete index.

The query layer accepts ordinary text, escapes it into controlled FTS terms, and enforces length and
term-count limits. Raw FTS operators are not exposed.

Initial ranking uses FTS relevance with deterministic recency tie-breaking. Source scores should be
normalized before merging thread and voice matches. Semantic reranking or embeddings can be added
later behind the same contracts.

## Voice Epoch and Reset Semantics

Voice search must not bypass a user's reset decision.

- `current-conversation` searches only the active epoch of the active durable conversation.
- An explicit conversation search also searches only that conversation's active epoch.
- `all-durable` searches active epochs of durable conversations only.
- Entries from epochs before Clear Context are excluded from agent search and read operations.
- Hard-deleted conversations and ephemeral conversations return no results.

An administrative export feature may expose historical epochs in the future, but it is not an
agent tool and must use a different authorization path.

## Thread Deletion and Visibility Semantics

- Deleted threads and deleted messages are excluded.
- Archived threads remain searchable unless the caller explicitly excludes them.
- Streaming assistant deltas are not indexed until T3 has an authoritative normalized message
  state suitable for retrieval.
- Reverted messages disappear from search when they disappear from the active T3 projection.
- Search results always identify the owning project and thread so the caller can display or enforce
  additional context.

## Authorization

Authorization is evaluated per requested source:

- Thread-message search and read require `orchestration:read`.
- Voice-entry search and read require `voice:use` and access to the environment-owned voice
  conversation.
- A request covering both sources requires both scopes. It must not silently return a partial
  result when one scope is absent.
- Provider tool calls execute with the authenticated T3 principal attached to the active session.
- Cross-environment search is not supported by an environment server. A higher-level broker must
  fan out explicitly and preserve environment attribution.

Multi-user conversation ACLs remain dependent on T3's future user identity design. The API should
accept an authorization-policy dependency from the beginning rather than embedding an assumption
that every authenticated client can read every future user's history.

## Privacy and Prompt Safety

- Do not log search queries, message bodies, transcripts, excerpts, or returned context.
- Telemetry records source set, filter presence, result count, latency, truncation, and outcome.
- Cap query length, match count, excerpt length, context radius, and total returned bytes.
- Retrieved history is labeled as historical user/assistant/tool data, never system policy.
- Agent instructions state that retrieved content may contain obsolete directions or prompt
  injection and does not expand tools, permissions, or confirmation policy.
- Tool results contain no provider credentials, raw tool arguments, hidden reasoning, SDP, audio,
  or unredacted internal errors.
- Exact reads use stable IDs and parameterized SQL only.

## Realtime Voice Integration

Add `search_history` and `read_history` to the server-owned Realtime tool allowlist. The Realtime
provider receives only their JSON schemas and bounded results; it does not receive database access.

The active voice conversation ID is bound server-side to the tool execution context. A model cannot
substitute another current conversation by inventing an ID. Cross-conversation voice search is
allowed only when the model selects the explicit `all-durable` scope and the server policy permits
it.

These tools supplement, rather than replace, continuation replay:

- Replay supplies compact recent context needed on every continued call.
- Search retrieves older or topic-specific history on demand.
- Read resolves an exact match or its bounded neighborhood.

History tools are read-only and do not require mutation confirmation.

## Traditional Coding-Agent Integration

The same tools should be made available through the common T3 agent broker planned for Pi, Codex,
Claude, and other providers. Provider-specific adapters translate only tool-call transport. Search
semantics, authorization, indexing, and results remain T3-owned.

A coding agent can search traditional thread history, its durable voice history when authorized,
or both. Results retain source attribution so the model can distinguish a prior coding-thread
message from something said during a voice conversation.

## Failure Behavior

- Invalid or overly broad queries fail before database work.
- Missing item references return a typed not-found error without revealing whether an unauthorized
  item exists.
- Index unavailability returns a retryable search-unavailable error; it does not fall back to
  loading the full orchestration snapshot.
- A stale pagination cursor fails explicitly.
- A read that crosses a voice epoch boundary returns only records from the target's permitted active
  epoch.
- Partial source failure fails a combined search rather than presenting incomplete results as
  complete.

## Testing

### Contracts

- Round-trip every discriminated reference and search/read result.
- Reject unknown source types, empty queries, excessive limits, invalid date ranges, and malformed
  cursors.
- Verify branded thread-message and voice-entry IDs cannot be interchanged.

### Persistence and indexing

- Backfill existing thread messages and voice entries.
- Update indexes transactionally on message completion, revert, deletion, clear context, and hard
  delete.
- Verify Unicode, punctuation, code identifiers, paths, and typo-free phrase queries.
- Verify FTS syntax in user input is treated as text rather than executable query structure.

### Authorization and privacy

- Deny each source independently and deny combined search when either scope is missing.
- Verify pre-clear voice epochs, deleted threads, ephemeral conversations, and foreign containers
  cannot be retrieved by direct ID.
- Assert logs and traces contain counts and timing but no query, excerpt, or record content.

### Agent behavior

- Search finds an older coding-thread decision and read returns the exact message plus neighbors.
- Search finds an older voice fact outside automatic replay context.
- A mixed search preserves source attribution and deterministic ordering.
- Retrieved prompt-injection text cannot expand the tool allowlist or bypass confirmation.
- Duplicate tool calls are read-only, bounded, and safe to retry.

## Implementation Plan

### 1. Contracts and IDs

- Add `VoiceConversationEntryId` to shared base schemas.
- Add `HistoryItemRef`, search/read inputs, results, cursors, and typed public errors.
- Add the authenticated history HTTP group and client-runtime methods.

### 2. Thread-message index

- Add the FTS migration and backfill for `projection_thread_messages`.
- Update projection transactions to maintain the index.
- Implement exact message and bounded neighboring-message reads.

### 3. Voice-history index

- Add the FTS migration and backfill for searchable voice journal kinds.
- Extract normalized searchable text when journal entries are appended.
- Implement active-epoch filtering and bounded journal-window reads.

### 4. Unified service and APIs

- Merge, normalize, rank, paginate, authorize, and bound results.
- Add redacted metrics and integration tests.
- Expose the HTTP API through the shared client runtime.

### 5. Agent tools

- Add the two read-only tools to Realtime voice.
- Add the same provider-neutral tool definitions to the common agent broker.
- Add adversarial prompt-safety and end-to-end recall tests.

## Acceptance Criteria

- An authenticated agent can search thread messages, voice history, or both without loading a full
  snapshot or journal.
- Every result includes a stable typed reference that can retrieve the exact record.
- Bounded neighboring context can be read without crossing thread, conversation, or voice-epoch
  boundaries.
- Clear Context, deletion, retention, and authorization rules cannot be bypassed with direct IDs.
- Search and read tools expose no arbitrary database or provider-storage access.
- Default logs, traces, and metrics contain no search text or historical content.
- Realtime voice and a non-voice provider adapter pass the same provider-neutral history-tool
  fixtures.

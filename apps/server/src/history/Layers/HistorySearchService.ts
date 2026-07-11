import {
  HISTORY_EXCERPT_MAX_CHARS,
  HISTORY_RECORD_CONTENT_MAX_CHARS,
  type HistoryItemRef,
  type HistoryReadResult,
  type HistoryRecord,
  type HistorySearchInput,
  type HistorySearchMatch,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../../auth/utils.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import {
  HistorySearchRepository,
  type HistoryIndexGenerations,
  type HistoryRepositoryReadResult,
  type HistoryRepositorySearchCursor,
  type ThreadHistoryRecord,
  type ThreadHistorySearchRow,
  type VoiceHistoryRecord,
  type VoiceHistorySearchRow,
} from "../../persistence/Services/HistorySearch.ts";
import { HistoryAuthorizationPolicy } from "../Services/HistoryAuthorizationPolicy.ts";
import {
  HistoryInvalidRequestError,
  HistoryItemNotFoundError,
  HistorySearchService,
  HistorySearchUnavailableError,
  type HistorySearchServiceShape,
} from "../Services/HistorySearchService.ts";

const CURSOR_SECRET_NAME = "history-search-cursor-signing-key";
const CURSOR_VERSION = 1;
const HISTORY_RESPONSE_MAX_BYTES = 28 * 1024;
const HISTORY_RECORD_MAX_BYTES = 1_000;
const HISTORY_EXCERPT_MAX_BYTES = 900;

const SearchFrontier = Schema.Struct({
  rawRank: Schema.Number,
  occurredAt: Schema.String,
  itemId: Schema.String,
});
const SearchCursorPayload = Schema.Struct({
  version: Schema.Literal(CURSOR_VERSION),
  fingerprint: Schema.String,
  generations: Schema.Struct({
    threadMessage: Schema.Number,
    voiceEntry: Schema.Number,
  }),
  threadOffset: Schema.Number,
  voiceOffset: Schema.Number,
  threadAfter: Schema.optionalKey(SearchFrontier),
  voiceAfter: Schema.optionalKey(SearchFrontier),
});
type SearchCursorPayload = typeof SearchCursorPayload.Type;

const decodeCursorPayloadJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(SearchCursorPayload),
);
const encodeCursorPayloadJson = Schema.encodeSync(Schema.fromJsonString(SearchCursorPayload));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type SearchRow = ThreadHistorySearchRow | VoiceHistorySearchRow;
interface SearchCandidate {
  readonly row: SearchRow;
  readonly score: number;
}
type ReadRecord = ThreadHistoryRecord | VoiceHistoryRecord;
type ReadResult = HistoryRepositoryReadResult<ReadRecord>;

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");

const truncateUtf8 = (
  value: string,
  maxBytes: number,
  maxCharacters: number,
): { readonly value: string; readonly truncated: boolean } => {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters && utf8Length(value) <= maxBytes) {
    return { value, truncated: false };
  }
  let low = 0;
  let high = Math.min(characters.length, maxCharacters);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(characters.slice(0, middle).join("")) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: characters.slice(0, low).join(""), truncated: true };
};

const normalizedQuery = (query: string): string =>
  query.normalize("NFC").trim().replace(/\s+/g, " ");

const requestFingerprint = (input: HistorySearchInput): string =>
  NodeCrypto.createHash("sha256")
    .update(
      encodeUnknownJson({
        query: normalizedQuery(input.query),
        sources: [...input.sources].toSorted(),
        projectId: input.projectId ?? null,
        threadId: input.threadId ?? null,
        voiceScope: input.voiceScope ?? null,
        roles: input.roles === undefined ? null : [...input.roles].toSorted(),
        occurredAfter: input.occurredAfter ?? null,
        occurredBefore: input.occurredBefore ?? null,
        limit: input.limit,
      }),
    )
    .digest("base64url");

const validateSearchInput = (input: HistorySearchInput): boolean => {
  const sources = new Set(input.sources);
  if (sources.size !== input.sources.length) return false;
  if (input.roles !== undefined && new Set(input.roles).size !== input.roles.length) return false;
  const includesThread = sources.has("thread-message");
  const includesVoice = sources.has("voice-entry");
  if (!includesThread && (input.projectId !== undefined || input.threadId !== undefined))
    return false;
  if (includesVoice !== (input.voiceScope !== undefined)) return false;
  if (
    input.occurredAfter !== undefined &&
    input.occurredBefore !== undefined &&
    input.occurredAfter >= input.occurredBefore
  ) {
    return false;
  }
  for (const instant of [input.occurredAfter, input.occurredBefore]) {
    if (instant === undefined) continue;
    const parsed = DateTime.make(instant);
    if (Option.isNone(parsed) || DateTime.formatIso(parsed.value) !== instant) {
      return false;
    }
  }
  return true;
};

const stableItemId = (row: SearchRow): string =>
  row.source === "thread-message" ? row.messageId : row.entryId;

const toRef = (row: SearchRow | ReadRecord): HistoryItemRef =>
  row.source === "thread-message"
    ? {
        type: "thread-message",
        projectId: row.projectId,
        threadId: row.threadId,
        messageId: row.messageId,
      }
    : {
        type: "voice-entry",
        conversationId: row.conversationId,
        entryId: row.entryId,
      };

const compareCandidates = (left: SearchCandidate, right: SearchCandidate): number => {
  const score = right.score - left.score;
  if (score !== 0) return score;
  const occurredAt = right.row.occurredAt.localeCompare(left.row.occurredAt);
  if (occurredAt !== 0) return occurredAt;
  const source = left.row.source.localeCompare(right.row.source);
  if (source !== 0) return source;
  return stableItemId(left.row).localeCompare(stableItemId(right.row));
};

const queryTerms = (query: string): ReadonlyArray<string> =>
  Array.from(query.matchAll(/[\p{L}\p{N}_]+/gu), (match) => match[0]?.toLocaleLowerCase() ?? "")
    .filter((term) => term.length > 0)
    .slice(0, 32);

const excerptFor = (text: string, terms: ReadonlyArray<string>) => {
  const lower = text.toLocaleLowerCase();
  const firstMatch = terms.reduce<number>((best, term) => {
    const index = lower.indexOf(term);
    return index === -1 ? best : best === -1 ? index : Math.min(best, index);
  }, -1);
  const start = Math.max(0, firstMatch === -1 ? 0 : firstMatch - 220);
  const prefix = start > 0 ? "..." : "";
  const candidate = `${prefix}${text.slice(start)}`;
  const excerpt = truncateUtf8(candidate, HISTORY_EXCERPT_MAX_BYTES, HISTORY_EXCERPT_MAX_CHARS);
  return {
    excerpt: excerpt.value,
    excerptTruncated: excerpt.truncated || start > 0,
  };
};

const toSearchMatch = (
  row: SearchRow,
  terms: ReadonlyArray<string>,
  score: number,
): HistorySearchMatch => ({
  ref: toRef(row),
  containerTitle:
    row.containerTitle === null ? null : truncateUtf8(row.containerTitle, 1_024, 512).value || null,
  roleOrKind: truncateUtf8(row.roleOrKind, 128, 64).value,
  occurredAt: row.occurredAt,
  ...excerptFor(row.text, terms),
  score,
});

const toHistoryRecord = (row: ReadRecord): HistoryRecord => {
  const content = truncateUtf8(
    row.text,
    HISTORY_RECORD_MAX_BYTES,
    HISTORY_RECORD_CONTENT_MAX_CHARS,
  );
  return {
    ref: toRef(row),
    roleOrKind: truncateUtf8(row.roleOrKind, 128, 64).value,
    occurredAt: row.occurredAt,
    content: content.value,
    truncated: content.truncated,
  };
};

const make = Effect.gen(function* () {
  const repository = yield* HistorySearchRepository;
  const authorization = yield* HistoryAuthorizationPolicy;
  const secrets = yield* ServerSecretStore;
  const signingSecret = yield* secrets.getOrCreateRandom(CURSOR_SECRET_NAME, 32);

  const invalid = (
    reason: "invalid_query" | "invalid_filters" | "invalid_cursor" | "invalid_reference",
  ) => new HistoryInvalidRequestError({ reason });

  const unavailable = (operation: "search" | "read", cause: unknown) =>
    new HistorySearchUnavailableError({ operation, cause });

  const encodeCursor = (payload: SearchCursorPayload): string => {
    const encodedPayload = base64UrlEncode(encodeCursorPayloadJson(payload));
    return `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  };

  const decodeCursor = (cursor: string): Option.Option<SearchCursorPayload> => {
    const parts = cursor.split(".");
    if (parts.length !== 2) return Option.none();
    const [encodedPayload, signature] = parts;
    if (
      encodedPayload === undefined ||
      signature === undefined ||
      !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))
    ) {
      return Option.none();
    }
    try {
      return decodeCursorPayloadJson(base64UrlDecodeUtf8(encodedPayload));
    } catch {
      return Option.none();
    }
  };

  const generationsMatch = (
    input: HistorySearchInput,
    expected: HistoryIndexGenerations,
    actual: HistoryIndexGenerations,
  ): boolean =>
    (!input.sources.includes("thread-message") ||
      expected.threadMessage === actual.threadMessage) &&
    (!input.sources.includes("voice-entry") || expected.voiceEntry === actual.voiceEntry);

  const search: HistorySearchServiceShape["search"] = Effect.fn("HistorySearchService.search")(
    function* (principal, input) {
      if (!validateSearchInput(input)) return yield* invalid("invalid_filters");
      if (!(yield* authorization.authorizeSearch(principal, input))) {
        return yield* invalid("invalid_filters");
      }

      const fingerprint = requestFingerprint(input);
      const generationsBefore = yield* repository
        .getGenerations()
        .pipe(Effect.mapError((cause) => unavailable("search", cause)));
      const cursor =
        input.cursor === undefined ? undefined : Option.getOrUndefined(decodeCursor(input.cursor));
      if (
        input.cursor !== undefined &&
        (cursor === undefined ||
          cursor.fingerprint !== fingerprint ||
          !generationsMatch(input, cursor.generations, generationsBefore))
      ) {
        return yield* invalid("invalid_cursor");
      }

      const query = normalizedQuery(input.query);
      const fetchLimit = input.limit + 1;
      const [threadRows, voiceRows] = yield* Effect.all(
        [
          input.sources.includes("thread-message")
            ? repository.searchThread({
                query,
                limit: fetchLimit,
                ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.roles === undefined ? {} : { roles: input.roles }),
                ...(input.occurredAfter === undefined
                  ? {}
                  : { occurredAfter: input.occurredAfter }),
                ...(input.occurredBefore === undefined
                  ? {}
                  : { occurredBefore: input.occurredBefore }),
                ...(cursor?.threadAfter === undefined
                  ? {}
                  : { after: cursor.threadAfter as HistoryRepositorySearchCursor }),
              })
            : Effect.succeed([] as ReadonlyArray<ThreadHistorySearchRow>),
          input.sources.includes("voice-entry")
            ? repository.searchVoice({
                query,
                limit: fetchLimit,
                ...(input.voiceScope?.type === "conversation"
                  ? { conversationId: input.voiceScope.conversationId }
                  : {}),
                ...(input.roles === undefined ? {} : { roles: input.roles }),
                ...(input.occurredAfter === undefined
                  ? {}
                  : { occurredAfter: input.occurredAfter }),
                ...(input.occurredBefore === undefined
                  ? {}
                  : { occurredBefore: input.occurredBefore }),
                ...(cursor?.voiceAfter === undefined
                  ? {}
                  : { after: cursor.voiceAfter as HistoryRepositorySearchCursor }),
              })
            : Effect.succeed([] as ReadonlyArray<VoiceHistorySearchRow>),
        ] as const,
        { concurrency: 2 },
      ).pipe(
        Effect.catchTag("HistorySearchQueryError", () => Effect.fail(invalid("invalid_query"))),
        Effect.mapError((cause) =>
          cause._tag === "HistoryInvalidRequestError" ? cause : unavailable("search", cause),
        ),
      );
      const generationsAfter = yield* repository
        .getGenerations()
        .pipe(Effect.mapError((cause) => unavailable("search", cause)));
      if (!generationsMatch(input, generationsBefore, generationsAfter)) {
        return yield* input.cursor === undefined
          ? unavailable("search", new Error("history index changed during search"))
          : invalid("invalid_cursor");
      }

      const threadOffset = cursor?.threadOffset ?? 0;
      const voiceOffset = cursor?.voiceOffset ?? 0;
      const candidates: Array<SearchCandidate> = [
        ...threadRows.map((row, index) => ({
          row,
          score: 1 / (60 + threadOffset + index + 1),
        })),
        ...voiceRows.map((row, index) => ({
          row,
          score: 1 / (60 + voiceOffset + index + 1),
        })),
      ].sort(compareCandidates);
      const pageCandidates = candidates.slice(0, input.limit);
      const hasMore = candidates.length > input.limit;
      let threadAfter = cursor?.threadAfter;
      let voiceAfter = cursor?.voiceAfter;
      let consumedThreads = 0;
      let consumedVoice = 0;
      for (const { row } of pageCandidates) {
        const frontier = {
          rawRank: row.rawRank,
          occurredAt: row.occurredAt,
          itemId: stableItemId(row),
        } satisfies HistoryRepositorySearchCursor;
        if (row.source === "thread-message") {
          threadAfter = frontier;
          consumedThreads += 1;
        } else {
          voiceAfter = frontier;
          consumedVoice += 1;
        }
      }
      const terms = queryTerms(query);
      const matches = pageCandidates.map(({ row, score }) => toSearchMatch(row, terms, score));
      if (utf8Length(encodeUnknownJson(matches)) > HISTORY_RESPONSE_MAX_BYTES) {
        return yield* unavailable("search", new Error("bounded history response exceeded limit"));
      }
      return {
        matches,
        nextCursor: hasMore
          ? encodeCursor({
              version: CURSOR_VERSION,
              fingerprint,
              generations: generationsAfter,
              threadOffset: threadOffset + consumedThreads,
              voiceOffset: voiceOffset + consumedVoice,
              ...(threadAfter === undefined ? {} : { threadAfter }),
              ...(voiceAfter === undefined ? {} : { voiceAfter }),
            })
          : null,
      };
    },
  );

  const read: HistorySearchServiceShape["read"] = Effect.fn("HistorySearchService.read")(
    function* (principal, input) {
      if (!(yield* authorization.authorizeRead(principal, input))) {
        return yield* new HistoryItemNotFoundError({});
      }
      if (
        (input.ref.type === "thread-message" && input.voiceScope !== undefined) ||
        (input.ref.type === "voice-entry" && input.voiceScope === undefined)
      ) {
        return yield* invalid("invalid_reference");
      }
      const ref = input.ref;
      let result: Option.Option<ReadResult>;
      if (ref.type === "thread-message") {
        result = yield* repository
          .readThread({
            projectId: ref.projectId,
            threadId: ref.threadId,
            messageId: ref.messageId,
            before: input.before,
            after: input.after,
          })
          .pipe(
            Effect.map(Option.map((value): ReadResult => value)),
            Effect.mapError((cause) => unavailable("read", cause)),
          );
      } else {
        if (input.voiceScope === undefined) return yield* invalid("invalid_reference");
        if (
          input.voiceScope.type === "conversation" &&
          input.voiceScope.conversationId !== ref.conversationId
        ) {
          return yield* invalid("invalid_reference");
        }
        result = yield* repository
          .readVoice({
            conversationId: ref.conversationId,
            entryId: ref.entryId,
            before: input.before,
            after: input.after,
          })
          .pipe(
            Effect.map(Option.map((value): ReadResult => value)),
            Effect.mapError((cause) => unavailable("read", cause)),
          );
      }
      if (Option.isNone(result)) return yield* new HistoryItemNotFoundError({});
      const response: HistoryReadResult = {
        target: toHistoryRecord(result.value.target),
        context: result.value.context.map(toHistoryRecord),
      };
      if (utf8Length(encodeUnknownJson(response)) > HISTORY_RESPONSE_MAX_BYTES) {
        return yield* unavailable("read", new Error("bounded history response exceeded limit"));
      }
      return response;
    },
  );

  return HistorySearchService.of({ search, read });
});

export const HistorySearchServiceLive = Layer.effect(HistorySearchService, make);

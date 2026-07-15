import {
  CommandId,
  MessageId,
  VoiceDraftArtifactId,
  VoiceRuntimeId,
  VoiceThreadTurnOperationId,
  VoicePlaybackId,
  VoiceRequestId,
  type VoicePublicErrorReason,
  type VoiceRuntimeThreadTurnPhase,
  type VoiceRuntimeThreadTurnSnapshot,
  VoiceRuntimeTarget,
} from "@t3tools/contracts";
import { appendSpeechText, initialSpeechChunkerState } from "@t3tools/shared/speechChunker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import { ClientCommandDispatcher } from "../../orchestration/Services/ClientCommandDispatcher.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnStartRepository } from "../../persistence/Services/ProjectionTurnStarts.ts";
import {
  VoiceThreadTurnStore,
  type PersistedVoiceThreadTurn,
  type VoiceThreadTurnReceiptCorrelation,
  type VoiceThreadTurnSpeechSegmentRecord,
  type VoiceThreadTurnEventWithoutSequence,
} from "../../persistence/Services/VoiceThreadTurns.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VoiceError } from "../Errors.ts";
import { inspectVoiceMp4 } from "../Services/VoiceMp4Inspector.ts";
import {
  boundVoiceByteStream,
  boundVoiceMediaEffect,
  VOICE_TRANSCRIPTION_OUTPUT_MAX_BYTES,
  VoiceMediaRequestLimiter,
} from "../Services/VoiceMediaPolicy.ts";
import { VoiceRuntimeAuthorityRepository } from "../../persistence/Services/VoiceRuntimeAuthorities.ts";
import { VoiceThreadTurnService } from "../Services/VoiceThreadTurnService.ts";
import { VoiceProviderRegistry } from "../Services/VoiceProviderRegistry.ts";

const OPERATION_TTL_MILLIS = 2 * 60 * 60 * 1_000;
const PROCESSING_LEASE_MILLIS = 5 * 60 * 1_000;
const EVENT_PAGE_LIMIT = 100;
const TERMINAL_RETENTION_MILLIS = 30 * 24 * 60 * 60 * 1_000;
const DRAFT_TTL_MILLIS = 15 * 60 * 1_000;
const DRAFT_KEY_NAME = "voice-thread-draft-encryption-key-v1";
const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
const ownershipHash = (authSessionId: string, operationId: string) =>
  hashToken(`${authSessionId}\0${operationId}`);
const deterministicHash = (...values: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(values.join("\0")).digest("base64url");
const encodeRuntimeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceRuntimeTarget));
const voiceError = (
  reason: VoicePublicErrorReason,
  operation: string,
  detail: string,
  retryable: boolean,
  cause?: unknown,
) =>
  new VoiceError({
    reason,
    operation,
    detail,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

const mapPhase = (phase: PersistedVoiceThreadTurn["phase"]): VoiceRuntimeThreadTurnPhase => {
  switch (phase) {
    case "created":
    case "transcribing":
    case "dispatching":
    case "waiting":
    case "speaking":
    case "attention-required":
    case "draft-ready":
    case "completed":
    case "failed":
    case "cancelled":
      return phase;
  }
};

const snapshot = (
  record: PersistedVoiceThreadTurn,
  correlation: VoiceThreadTurnReceiptCorrelation,
): VoiceRuntimeThreadTurnSnapshot => ({
  operationId: VoiceThreadTurnOperationId.make(record.operationId),
  runtimeId: VoiceRuntimeId.make(record.runtimeId),
  runtimeInstanceId: record.runtimeInstanceId,
  generation: record.runtimeGeneration,
  modeSessionId: record.modeSessionId,
  turnClientOperationId: record.turnClientOperationId,
  submissionPolicy: record.submissionPolicy,
  speechPlanId: record.speechPlanId,
  projectId: record.projectId,
  threadId: record.threadId,
  speechPreset: record.speechPreset,
  autoRearm: record.autoRearm,
  phase: mapPhase(record.phase),
  userMessageId: record.messageId,
  turnId: record.turnId,
  assistantMessageIds: [...correlation.assistantMessageIds],
  highestAdvertisedSegment: correlation.highestAdvertisedSegment,
  highestStartedSegment: correlation.highestStartedSegment,
  highestDrainedSegment: correlation.highestDrainedSegment,
  segmentDispositions: [...correlation.segmentDispositions],
  lastSequence: record.lastSequence,
  acknowledgedSequence: record.acknowledgedSequence,
  speechTerminal: record.speechTerminal,
  dispatchAccepted: record.dispatchAccepted,
  detachedAt: record.detachedAt,
  operationTokenExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(record.operationTokenExpiresAt)),
  retentionExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(record.retentionExpiresAt)),
});

const terminalPhase = (phase: PersistedVoiceThreadTurn["phase"]) =>
  phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "draft-ready";
const shouldAdvertiseSpeech = (
  operation: Pick<PersistedVoiceThreadTurn, "speechEnabled" | "detachedAt">,
) => operation.speechEnabled && operation.detachedAt === null;

const restoreSpeechCursor = (segments: ReadonlyArray<VoiceThreadTurnSpeechSegmentRecord>) => {
  let endOffset = 0;
  for (const [index, segment] of segments.entries()) {
    if (
      segment.segmentIndex !== index ||
      segment.startOffset < endOffset ||
      segment.endOffset <= segment.startOffset ||
      (segment.finalSegment && index !== segments.length - 1)
    )
      return undefined;
    endOffset = segment.endOffset;
  }
  const last = segments.at(-1);
  return {
    state: {
      buffer: "",
      nextIndex: segments.length,
      finished: last?.finalSegment ?? false,
    },
    emittedOffset: last?.endOffset ?? 0,
  };
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore;
  const draftKey = yield* secretStore.getOrCreateRandom(DRAFT_KEY_NAME, 32).pipe(Effect.orDie);
  const store = yield* VoiceThreadTurnStore;
  const runtimeAuthorities = yield* VoiceRuntimeAuthorityRepository;
  const providers = yield* VoiceProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const limiter = yield* VoiceMediaRequestLimiter;
  const dispatcher = yield* ClientCommandDispatcher;
  const query = yield* ProjectionSnapshotQuery;
  const messages = yield* ProjectionThreadMessageRepository;
  const turnStarts = yield* ProjectionTurnStartRepository;
  const serviceScope = yield* Scope.Scope;
  const activeMonitors = new Set<string>();
  const isVoiceError = Schema.is(VoiceError);
  const getVoiceSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.voice),
    Effect.mapError((cause) =>
      voiceError(
        "provider-unavailable",
        "thread-turn.settings",
        "Voice settings are unavailable",
        true,
        cause,
      ),
    ),
  );
  const getEnabledVoiceSettings = getVoiceSettings.pipe(
    Effect.flatMap((settings) =>
      settings.enabled
        ? Effect.succeed(settings)
        : Effect.fail(voiceError("disabled", "thread-turn.settings", "Voice is disabled", false)),
    ),
  );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const repositoryFailure = (operation: string) => (cause: unknown) =>
    voiceError(
      "provider-unavailable",
      operation,
      "Native thread voice operation storage is unavailable",
      true,
      cause,
    );
  const hydrateSnapshot = Effect.fn("VoiceThreadTurnService.snapshot")(function* (
    record: PersistedVoiceThreadTurn,
  ) {
    const correlation = yield* store
      .getReceiptCorrelation(record.operationId)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.receipt")));
    if (correlation === undefined)
      return yield* voiceError(
        "session-not-found",
        "thread-turn.receipt",
        "Operation receipt is unavailable",
        false,
      );
    return snapshot(record, correlation);
  });
  const load = Effect.fn("VoiceThreadTurnService.load")(function* (
    operationId: VoiceThreadTurnOperationId,
  ) {
    const record = yield* store
      .get(operationId)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.get")));
    if (record === undefined)
      return yield* voiceError(
        "session-not-found",
        "thread-turn.get",
        "Operation was not found",
        false,
      );
    return record;
  });
  const authorize = Effect.fn("VoiceThreadTurnService.authorize")(function* (
    authSessionId: string,
    operationId: VoiceThreadTurnOperationId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const record = yield* store
      .authorize(operationId, ownershipHash(authSessionId, operationId), now)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.authorize")));
    if (record === undefined)
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.authorize",
        "Operation is not owned by this session or has expired",
        false,
      );
    return record;
  });
  const append = (
    operationId: VoiceThreadTurnOperationId,
    event: VoiceThreadTurnEventWithoutSequence,
    updates?: Parameters<typeof store.appendEvent>[2],
  ) =>
    store
      .appendEvent(operationId, event, updates)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.event")));

  const maintain = Effect.fn("VoiceThreadTurnService.maintain")(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* store
      .expireAndPurge(now, yield* nowIso, now)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.maintenance")));
  });

  const monitorLoop = Effect.fn("VoiceThreadTurnService.monitor")(function* (
    operationId: VoiceThreadTurnOperationId,
  ) {
    const persistedSegments = yield* store
      .listSpeechSegments(operationId)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-recovery")));
    const restored = restoreSpeechCursor(persistedSegments);
    if (restored === undefined)
      return yield* voiceError(
        "invalid-context",
        "thread-turn.speech-recovery",
        "Persisted speech cursor is inconsistent",
        false,
      );
    let priorText = "";
    let chunker = persistedSegments.length === 0 ? initialSpeechChunkerState() : restored.state;
    let emittedOffset = restored.emittedOffset;
    let recoveryPending = persistedSegments.length > 0;
    let revisedNonPrefix = false;
    let attention: "approval" | "user-input" | undefined;
    while (true) {
      const operation = yield* load(operationId);
      if (terminalPhase(operation.phase) || operation.messageId === null) return;
      if (
        !operation.dispatchAccepted &&
        operation.operationTokenExpiresAt <= (yield* Clock.currentTimeMillis)
      ) {
        yield* store
          .finalize({
            operationId,
            occurredAt: yield* nowIso,
            outcome: "failed",
            speechOutcome: "failed",
            failureCode: "operation-expired",
            retryable: false,
          })
          .pipe(Effect.mapError(repositoryFailure("thread-turn.expire")));
        return;
      }
      if (
        operation.dispatchAccepted &&
        operation.detachedAt === null &&
        operation.operationTokenExpiresAt <= (yield* Clock.currentTimeMillis)
      ) {
        yield* store
          .detachInternal(operationId, yield* nowIso)
          .pipe(Effect.mapError(repositoryFailure("thread-turn.expire-detach")));
      }
      const outcome = yield* turnStarts
        .getOutcomeByMessageId({
          threadId: operation.threadId,
          messageId: operation.messageId,
        })
        .pipe(Effect.mapError(repositoryFailure("thread-turn.projection")));
      const shell = yield* query
        .getThreadShellById(operation.threadId)
        .pipe(Effect.mapError(repositoryFailure("thread-turn.projection")));
      if (Option.isNone(shell)) {
        yield* store
          .finalize({
            operationId,
            occurredAt: yield* nowIso,
            outcome: "failed",
            speechOutcome: "failed",
            failureCode: "target-unavailable",
            retryable: false,
          })
          .pipe(Effect.mapError(repositoryFailure("thread-turn.finalize-target")));
        return;
      }
      if (Option.isSome(shell)) {
        const nextAttention = shell.value.hasPendingApprovals
          ? ("approval" as const)
          : shell.value.hasPendingUserInput
            ? ("user-input" as const)
            : undefined;
        if (nextAttention !== undefined && nextAttention !== attention) {
          attention = nextAttention;
          yield* append(
            operationId,
            {
              type: "attention-required",
              occurredAt: yield* nowIso,
              attention: nextAttention,
            },
            { phase: "attention-required" },
          );
        } else if (nextAttention === undefined && attention !== undefined) {
          attention = undefined;
          yield* append(
            operationId,
            { type: "phase", occurredAt: yield* nowIso, phase: "waiting" },
            { phase: "waiting" },
          );
        }
      }
      if (
        Option.isNone(outcome) ||
        outcome.value.start.state === "pending" ||
        outcome.value.start.state === "submitting"
      ) {
        yield* Effect.sleep("250 millis");
        continue;
      }
      if (outcome.value.start.state === "failed" || outcome.value.start.state === "ambiguous") {
        yield* store
          .finalize({
            operationId,
            occurredAt: yield* nowIso,
            outcome: "failed",
            speechOutcome: "no-speech",
            failureCode: "turn-failed",
            retryable: false,
          })
          .pipe(Effect.mapError(repositoryFailure("thread-turn.finalize")));
        return;
      }
      const turn = outcome.value.turn;
      if (turn === null) {
        yield* Effect.sleep("250 millis");
        continue;
      }
      if (operation.turnId === null) {
        yield* append(
          operationId,
          {
            type: "dispatch-correlation",
            occurredAt: yield* nowIso,
            commandId: operation.commandId!,
            messageId: operation.messageId,
            turnId: turn.turnId,
          },
          { turnId: turn.turnId },
        );
      }
      const correlatedAssistants = (yield* messages
        .listByThreadId({ threadId: operation.threadId })
        .pipe(Effect.mapError(repositoryFailure("thread-turn.messages"))))
        .filter((message) => message.role === "assistant" && message.turnId === turn.turnId)
        .slice(0, 256);
      yield* store
        .recordAssistantMessages(
          operationId,
          correlatedAssistants.map((message, index) => ({
            messageId: message.messageId,
            firstSeenSequence: index + 1,
            createdAt: message.createdAt,
          })),
        )
        .pipe(Effect.mapError(repositoryFailure("thread-turn.message-correlation")));
      if (shouldAdvertiseSpeech(operation) && turn.assistantMessageId !== null) {
        const assistant = yield* messages
          .getByMessageId({ messageId: turn.assistantMessageId })
          .pipe(Effect.mapError(repositoryFailure("thread-turn.message")));
        if (Option.isSome(assistant)) {
          const text = assistant.value.text;
          if (recoveryPending) {
            if (text.length < emittedOffset) {
              yield* Effect.sleep("50 millis");
              continue;
            }
            const persistedText = yield* Effect.forEach(
              persistedSegments,
              (segment) =>
                store
                  .getSpeechSegmentText(operationId, segment.segmentIndex)
                  .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-recovery"))),
              { concurrency: 1 },
            );
            const inconsistent = persistedSegments.some(
              (segment, index) =>
                segment.assistantMessageId !== assistant.value.messageId ||
                segment.endOffset > text.length ||
                persistedText[index] === undefined ||
                text.slice(segment.startOffset, segment.endOffset) !== persistedText[index],
            );
            if (inconsistent)
              return yield* voiceError(
                "invalid-context",
                "thread-turn.speech-recovery",
                "Persisted speech identity does not match the canonical assistant response",
                false,
              );
            priorText = text.slice(0, emittedOffset);
            recoveryPending = false;
          }
          const previousText = priorText;
          const prefixUpdate = text.startsWith(priorText);
          const delta = prefixUpdate ? text.slice(priorText.length) : "";
          priorText = text;
          const terminal = turn.state !== "running";
          const revision = yield* store
            .resolveAssistantRevision(assistant.value.messageId)
            .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-revision")));
          if (revision === undefined || hashToken(text) !== revision.sourceTextSha256) {
            priorText = previousText;
            yield* Effect.sleep("50 millis");
            continue;
          }
          if (!prefixUpdate) revisedNonPrefix = true;
          const chunked =
            revisedNonPrefix || chunker.finished
              ? { state: chunker, segments: [] }
              : appendSpeechText(chunker, delta, terminal);
          chunker = chunked.state;
          for (const segment of chunked.segments) {
            const startOffset = text.indexOf(segment.text, emittedOffset);
            if (startOffset < 0)
              return yield* voiceError(
                "invalid-context",
                "thread-turn.segment",
                "Canonical assistant speech boundary could not be resolved",
                false,
              );
            const endOffset = startOffset + segment.text.length;
            emittedOffset = endOffset;
            const occurredAt = yield* nowIso;
            const inserted = yield* store
              .putSpeechSegmentAndEvent({
                operationId,
                segmentIndex: segment.index,
                assistantMessageId: assistant.value.messageId,
                startOffset,
                endOffset,
                finalSegment: segment.finalSegment,
                ...revision,
                createdAt: occurredAt,
              })
              .pipe(Effect.mapError(repositoryFailure("thread-turn.segment")));
            if (inserted === "mismatch")
              return yield* voiceError(
                "invalid-context",
                "thread-turn.segment-conflict",
                "Speech segment identity changed",
                false,
              );
            if (inserted === "terminal") return;
            if (inserted === "detached") break;
          }
        }
      }
      if (turn.state === "running") {
        yield* Effect.sleep("250 millis");
        continue;
      }
      const occurredAt = yield* nowIso;
      const terminal = turn.state === "completed" ? ("completed" as const) : ("failed" as const);
      const latest = yield* load(operationId);
      const correlation = yield* store
        .getReceiptCorrelation(operationId)
        .pipe(Effect.mapError(repositoryFailure("thread-turn.receipt")));
      const speechSegmentCount =
        correlation?.highestAdvertisedSegment === null ||
        correlation?.highestAdvertisedSegment === undefined
          ? 0
          : correlation.highestAdvertisedSegment + 1;
      const speechOutcome =
        latest.lastSequence > 0 && speechSegmentCount > 0
          ? ("completed" as const)
          : ("no-speech" as const);
      yield* Effect.logInfo("Native thread voice monitor completed", {
        operationId,
        turnId: turn.turnId,
        speechSegmentCount,
        speechOutcome,
        turnOutcome: terminal,
      });
      yield* store
        .finalize({
          operationId,
          occurredAt,
          outcome: terminal,
          speechOutcome,
          ...(terminal === "failed"
            ? { failureCode: "turn-failed" as const, retryable: false }
            : {}),
        })
        .pipe(Effect.mapError(repositoryFailure("thread-turn.finalize")));
      return;
    }
  });

  const ensureMonitor = Effect.fn("VoiceThreadTurnService.ensureMonitor")(function* (
    operationId: VoiceThreadTurnOperationId,
  ) {
    const started = yield* Effect.sync(() => {
      if (activeMonitors.has(operationId)) return false;
      activeMonitors.add(operationId);
      return true;
    });
    if (!started) return;
    yield* monitorLoop(operationId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Native thread voice monitor failed", {
              operationId,
              cause,
            }).pipe(
              Effect.andThen(
                nowIso.pipe(
                  Effect.flatMap((occurredAt) =>
                    store.finalize({
                      operationId,
                      occurredAt,
                      outcome: "failed",
                      speechOutcome: "failed",
                      failureCode: "turn-failed",
                      retryable: true,
                    }),
                  ),
                ),
              ),
              Effect.ignore,
            ),
      ),
      Effect.ensuring(Effect.sync(() => activeMonitors.delete(operationId))),
      Effect.forkIn(serviceScope),
    );
  });

  const reconcileOrDispatch = Effect.fn("VoiceThreadTurnService.reconcileOrDispatch")(function* (
    operation: PersistedVoiceThreadTurn,
    operationTokenHash: string,
    leaseToken: string,
    transcript?: string,
  ) {
    const commandId = CommandId.make(`native-thread-turn:${operation.operationId}`);
    const messageId = MessageId.make(`native-thread-message:${operation.operationId}`);
    const existing = yield* messages
      .getByMessageId({ messageId })
      .pipe(Effect.mapError(repositoryFailure("thread-turn.reconcile")));
    if (Option.isNone(existing)) {
      if (transcript === undefined)
        return yield* voiceError(
          "invalid-phase",
          "thread-turn.reconcile",
          "Audio must be re-uploaded before dispatch",
          true,
        );
      const thread = yield* query.getThreadShellById(operation.threadId).pipe(
        Effect.mapError(repositoryFailure("thread-turn.target")),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                voiceError(
                  "conversation-not-found",
                  "thread-turn.target",
                  "Thread target is unavailable",
                  false,
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (thread.projectId !== operation.projectId)
        return yield* voiceError(
          "conversation-not-found",
          "thread-turn.target",
          "Thread target changed",
          false,
        );
      const dispatchCommitted = yield* store
        .beginDispatch(
          operation.operationId,
          operationTokenHash,
          leaseToken,
          yield* Clock.currentTimeMillis,
          yield* nowIso,
        )
        .pipe(Effect.mapError(repositoryFailure("thread-turn.begin-dispatch")));
      if (!dispatchCommitted)
        return yield* voiceError(
          "invalid-phase",
          "thread-turn.dispatch-fenced",
          "Operation was cancelled or displaced before dispatch",
          false,
        );
      yield* dispatcher
        .dispatch({
          type: "thread.turn.start",
          commandId,
          threadId: operation.threadId,
          message: {
            messageId,
            role: "user",
            text: transcript,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: yield* nowIso,
        })
        .pipe(
          Effect.mapError((cause) =>
            voiceError(
              "provider-unavailable",
              "thread-turn.dispatch",
              "Thread turn dispatch failed",
              true,
              cause,
            ),
          ),
        );
    }
    if (Option.isSome(existing)) {
      const dispatchCommitted = yield* store
        .beginDispatch(
          operation.operationId,
          operationTokenHash,
          leaseToken,
          yield* Clock.currentTimeMillis,
          yield* nowIso,
        )
        .pipe(Effect.mapError(repositoryFailure("thread-turn.begin-dispatch")));
      if (!dispatchCommitted)
        return yield* voiceError(
          "invalid-phase",
          "thread-turn.dispatch-fenced",
          "Operation was cancelled or displaced before reconciliation",
          false,
        );
    }
    const accepted = yield* store
      .acceptDispatch({
        operationId: operation.operationId,
        tokenHash: operationTokenHash,
        leaseToken,
        occurredAt: yield* nowIso,
        commandId,
        messageId,
      })
      .pipe(Effect.mapError(repositoryFailure("thread-turn.accept-dispatch")));
    if (!accepted)
      return yield* voiceError(
        "invalid-phase",
        "thread-turn.dispatch-fenced",
        "Operation lost authority while dispatching",
        false,
      );
    yield* Effect.logInfo("Native thread voice dispatch accepted", {
      operationId: operation.operationId,
      commandId,
      messageId,
    });
    yield* ensureMonitor(operation.operationId);
  });

  const create: VoiceThreadTurnService["Service"]["create"] = Effect.fn(
    "VoiceThreadTurnService.create",
  )(function* (principal, input) {
    yield* getEnabledVoiceSettings;
    yield* maintain();
    const runtimeId = VoiceRuntimeId.make(input.runtimeId);
    const authority = yield* runtimeAuthorities
      .find(principal.sessionId, runtimeId)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.authority")));
    if (
      authority === undefined ||
      authority.target.mode !== "thread" ||
      authority.generation !== input.generation ||
      encodeRuntimeTarget(authority.target) !== encodeRuntimeTarget(input.target)
    )
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.create",
        "Runtime authority is stale or belongs to a different session",
        false,
      );
    const threadTarget = authority.target;
    const now = yield* Clock.currentTimeMillis;
    const operationId = VoiceThreadTurnOperationId.make(
      `native-thread-turn:${deterministicHash(principal.sessionId, runtimeId, input.runtimeInstanceId, String(authority.generation), input.modeSessionId, input.turnClientOperationId)}`,
    );
    const currentAuthority = yield* runtimeAuthorities
      .find(principal.sessionId, runtimeId)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.authority")));
    if (
      currentAuthority === undefined ||
      currentAuthority.target.mode !== "thread" ||
      currentAuthority.generation !== authority.generation ||
      encodeRuntimeTarget(currentAuthority.target) !== encodeRuntimeTarget(authority.target)
    )
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.create-claim",
        "Runtime credential was revoked before the operation could be claimed",
        false,
      );
    const claim = yield* store
      .claim({
        operationId,
        authSessionId: principal.sessionId,
        runtimeId,
        runtimeInstanceId: input.runtimeInstanceId,
        runtimeGeneration: authority.generation,
        modeSessionId: input.modeSessionId,
        turnClientOperationId: input.turnClientOperationId,
        projectId: threadTarget.projectId,
        threadId: threadTarget.threadId,
        speechPreset: threadTarget.speechPreset,
        speechEnabled: threadTarget.speechEnabled,
        autoRearm: threadTarget.autoRearm,
        submissionPolicy: input.submissionPolicy,
        speechPlanId: input.speechPlanId,
        tokenHash: ownershipHash(principal.sessionId, operationId),
        operationTokenExpiresAt: now + OPERATION_TTL_MILLIS,
        retentionExpiresAt: now + TERMINAL_RETENTION_MILLIS,
        nowEpochMillis: now,
        now: yield* nowIso,
      })
      .pipe(
        Effect.mapError((cause) =>
          voiceError(
            "lease-conflict",
            "thread-turn.create",
            "Another Active Thread operation is already active",
            true,
            cause,
          ),
        ),
      );
    if (claim.status === "revoked")
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.create-claim",
        "Runtime authority changed before the operation could be claimed",
        false,
      );
    if (claim.status === "expired")
      return yield* voiceError(
        "invalid-phase",
        "thread-turn.create-expired",
        "The idempotent operation has expired; use a new client operation id",
        false,
      );
    if (claim.status === "mismatch")
      return yield* voiceError(
        "invalid-context",
        "thread-turn.create-mismatch",
        "The idempotent operation parameters do not match",
        false,
      );
    const created = claim.operation;
    if (created.dispatchAccepted && !terminalPhase(created.phase))
      yield* ensureMonitor(operationId);
    yield* Effect.logInfo("Native thread voice operation claimed", {
      operationId,
      runtimeId: created.runtimeId,
      generation: created.runtimeGeneration,
      phase: created.phase,
    });
    return { snapshot: yield* hydrateSnapshot(created) };
  });

  const uploadAudio: VoiceThreadTurnService["Service"]["uploadAudio"] = Effect.fn(
    "VoiceThreadTurnService.uploadAudio",
  )(function* (authSessionId, operationId, bytes, language) {
    const operation = yield* authorize(authSessionId, operationId);
    const operationTokenHash = ownershipHash(authSessionId, operationId);
    if (terminalPhase(operation.phase))
      return {
        snapshot: yield* hydrateSnapshot(operation),
        disposition: "terminal",
      };
    if (operation.dispatchAccepted) {
      yield* ensureMonitor(operationId);
      return {
        snapshot: yield* hydrateSnapshot(operation),
        disposition: "already-dispatched",
      };
    }
    const settings = yield* getEnabledVoiceSettings;
    if (bytes.byteLength > settings.maxUploadBytes)
      return yield* voiceError(
        "payload-too-large",
        "thread-turn.audio",
        "Audio exceeds configured limit",
        false,
      );
    const validation = yield* inspectVoiceMp4(bytes, settings.maxInputDurationSeconds).pipe(
      Effect.mapError((cause) =>
        voiceError("unsupported-media", "thread-turn.audio", cause.reason, false, cause),
      ),
      Effect.result,
    );
    if (Result.isFailure(validation)) {
      yield* store
        .finalize({
          operationId,
          occurredAt: yield* nowIso,
          outcome: "failed",
          speechOutcome: "failed",
          failureCode: "audio-invalid",
          retryable: false,
          requireUnleased: true,
        })
        .pipe(Effect.mapError(repositoryFailure("thread-turn.finalize-audio")));
      return yield* validation.failure;
    }
    const validated = validation.success;
    const now = yield* Clock.currentTimeMillis;
    const leaseToken = yield* crypto
      .randomBytes(32)
      .pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);
    const processing = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* store
          .claimProcessing(
            operationId,
            operationTokenHash,
            leaseToken,
            now,
            now + PROCESSING_LEASE_MILLIS,
            yield* nowIso,
          )
          .pipe(Effect.mapError(repositoryFailure("thread-turn.processing-lease")));
        if (!claimed)
          return yield* voiceError(
            "lease-conflict",
            "thread-turn.audio",
            "Operation is already processing",
            true,
          );
        const admittedOperation = yield* load(operationId);
        const releaseAbandonedLease = nowIso.pipe(
          Effect.flatMap((occurredAt) =>
            store.releaseProcessing(
              operationId,
              leaseToken,
              occurredAt,
              "transcription-failed",
              true,
            ),
          ),
          Effect.ignore,
        );
        return yield* restore(
          Effect.gen(function* () {
            yield* append(
              operationId,
              {
                type: "phase",
                occurredAt: yield* nowIso,
                phase: "transcribing",
              },
              { phase: "transcribing" },
            );
            const deterministicMessageId = MessageId.make(
              `native-thread-message:${admittedOperation.operationId}`,
            );
            const reconciledMessage = yield* messages
              .getByMessageId({ messageId: deterministicMessageId })
              .pipe(Effect.mapError(repositoryFailure("thread-turn.reconcile")));
            const transcript = Option.isSome(reconciledMessage)
              ? undefined
              : yield* Effect.gen(function* () {
                  const provider = yield* providers.resolve("transcription.request");
                  if (provider.transcriber === undefined)
                    return yield* voiceError(
                      "not-configured",
                      "thread-turn.transcribe",
                      "No transcriber is configured",
                      false,
                    );
                  const transcription = provider.transcriber
                    .transcribe({
                      requestId: VoiceRequestId.make(`native-thread-transcript:${operationId}`),
                      bytes,
                      mediaType: validated.mediaType,
                      ...(language === undefined ? {} : { language }),
                    })
                    .pipe(
                      Stream.runFold(
                        () => "",
                        (current, event) => (event.type === "final" ? event.result.text : current),
                      ),
                    );
                  return yield* boundVoiceMediaEffect(
                    transcription,
                    settings.mediaRequestTimeoutSeconds,
                  ).pipe(
                    Effect.flatMap((text) =>
                      new TextEncoder().encode(text).byteLength >
                      VOICE_TRANSCRIPTION_OUTPUT_MAX_BYTES
                        ? Effect.fail(
                            voiceError(
                              "payload-too-large",
                              "thread-turn.transcript-limit",
                              "Transcription exceeds the configured output limit",
                              false,
                            ),
                          )
                        : text.length === 0
                          ? Effect.fail(
                              voiceError(
                                "invalid-context",
                                "thread-turn.transcribe",
                                "Transcription produced no speech",
                                false,
                              ),
                            )
                          : Effect.succeed(text),
                    ),
                    Effect.mapError((cause) =>
                      isVoiceError(cause)
                        ? cause
                        : voiceError(
                            "provider-unavailable",
                            "thread-turn.transcribe",
                            "Transcription failed",
                            true,
                            cause,
                          ),
                    ),
                  );
                });
            if (admittedOperation.submissionPolicy === "draft") {
              if (transcript === undefined)
                return yield* voiceError(
                  "invalid-context",
                  "thread-turn.draft",
                  "Draft transcript is unavailable",
                  false,
                );
              const nonce = NodeCrypto.randomBytes(12);
              const cipher = NodeCrypto.createCipheriv("aes-256-gcm", draftKey, nonce);
              cipher.setAAD(Buffer.from(admittedOperation.operationId));
              const encrypted = Buffer.concat([
                cipher.update(transcript, "utf8"),
                cipher.final(),
                cipher.getAuthTag(),
              ]);
              const completed = yield* store
                .completeDraft({
                  operationId: admittedOperation.operationId,
                  tokenHash: operationTokenHash,
                  leaseToken,
                  draftId: VoiceDraftArtifactId.make(
                    `voice-draft:${admittedOperation.operationId}`,
                  ),
                  cipherVersion: 1,
                  nonce,
                  ciphertext: encrypted,
                  expiresAt: (yield* Clock.currentTimeMillis) + DRAFT_TTL_MILLIS,
                  occurredAt: yield* nowIso,
                })
                .pipe(Effect.mapError(repositoryFailure("thread-turn.draft-store")));
              if (completed === "invalid")
                return yield* voiceError(
                  "invalid-phase",
                  "thread-turn.draft",
                  "Draft completion lost operation authority",
                  false,
                );
            } else {
              yield* reconcileOrDispatch(
                admittedOperation,
                operationTokenHash,
                leaseToken,
                transcript,
              );
            }
          }).pipe(
            Effect.onInterrupt(() => releaseAbandonedLease),
            Effect.catchCause((cause) =>
              Cause.hasDies(cause)
                ? releaseAbandonedLease.pipe(Effect.andThen(Effect.failCause(cause)))
                : Effect.failCause(cause),
            ),
            Effect.result,
          ),
        );
      }),
    );
    if (Result.isFailure(processing)) {
      const error = processing.failure;
      const occurredAt = yield* nowIso;
      const code =
        error.operation === "thread-turn.target"
          ? ("target-unavailable" as const)
          : error.operation.startsWith("thread-turn.dispatch") ||
              error.operation === "thread-turn.begin-dispatch" ||
              error.operation === "thread-turn.accept-dispatch"
            ? ("dispatch-failed" as const)
            : ("transcription-failed" as const);
      if (!error.retryable) {
        yield* store
          .finalize({
            operationId,
            occurredAt,
            outcome: "failed",
            speechOutcome: "failed",
            failureCode: code,
            retryable: false,
            leaseToken,
          })
          .pipe(Effect.mapError(repositoryFailure("thread-turn.finalize")));
      } else {
        yield* store
          .releaseProcessing(operationId, leaseToken, occurredAt, code, true)
          .pipe(Effect.mapError(repositoryFailure("thread-turn.release-processing")));
      }
      yield* Effect.logWarning("Native thread voice processing failed", {
        operationId,
        code,
        retryable: error.retryable,
        phase: error.retryable ? "created" : "failed",
      });
      return yield* error;
    }
    const current = yield* load(operationId);
    return {
      snapshot: yield* hydrateSnapshot(current),
      disposition: current.phase === "draft-ready" ? "draft-ready" : "processing",
    };
  });

  const beginAudioUpload: VoiceThreadTurnService["Service"]["beginAudioUpload"] = Effect.fn(
    "VoiceThreadTurnService.beginAudioUpload",
  )(function* (authSessionId, operationId) {
    yield* authorize(authSessionId, operationId);
    const settings = yield* getEnabledVoiceSettings;
    const permit = yield* limiter
      .acquire(settings.maxConcurrentMediaRequests)
      .pipe(
        Effect.mapError((cause) =>
          voiceError("quota-exceeded", "thread-turn.audio-admission", cause.reason, true, cause),
        ),
      );
    return {
      maximumBytes: settings.maxUploadBytes,
      bodyTimeoutSeconds: Math.max(30, settings.maxInputDurationSeconds + 30),
      upload: (bytes: Uint8Array, language?: string) =>
        uploadAudio(authSessionId, operationId, bytes, language),
      release: permit.release,
    };
  });

  const setDraftDisposition: VoiceThreadTurnService["Service"]["setDraftDisposition"] = Effect.fn(
    "VoiceThreadTurnService.setDraftDisposition",
  )(function* (authSessionId, operationId) {
    yield* authorize(authSessionId, operationId);
    const result = yield* store
      .setDraftDisposition(
        operationId,
        ownershipHash(authSessionId, operationId),
        yield* Clock.currentTimeMillis,
        yield* nowIso,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.disposition")));
    if (result === "revoked")
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.disposition",
        "Operation credential is no longer authorized",
        false,
      );
    if (result === "invalid")
      return yield* voiceError(
        "invalid-phase",
        "thread-turn.disposition",
        "Submission policy can only change before audio admission",
        false,
      );
    return { snapshot: yield* hydrateSnapshot(yield* load(operationId)) };
  });

  const events: VoiceThreadTurnService["Service"]["events"] = Effect.fn(
    "VoiceThreadTurnService.events",
  )(function* (authSessionId, operationId, eventQuery) {
    yield* maintain();
    const readPage = Effect.fn("VoiceThreadTurnService.readEventPage")(function* () {
      yield* authorize(authSessionId, operationId);
      const page = yield* store
        .readEventPage(
          operationId,
          ownershipHash(authSessionId, operationId),
          yield* Clock.currentTimeMillis,
          eventQuery.afterSequence,
          EVENT_PAGE_LIMIT,
        )
        .pipe(Effect.mapError(repositoryFailure("thread-turn.events-page")));
      if (page === undefined)
        return yield* voiceError(
          "authorization-revoked",
          "thread-turn.events-page",
          "Operation credential is no longer authorized",
          false,
        );
      return page;
    });
    const started = yield* Clock.currentTimeMillis;
    let page = yield* readPage();
    if (page.operation.dispatchAccepted && !terminalPhase(page.operation.phase))
      yield* ensureMonitor(operationId);
    while (
      page.events.length === 0 &&
      (yield* Clock.currentTimeMillis) - started < eventQuery.waitMilliseconds
    ) {
      yield* Effect.sleep("100 millis");
      page = yield* readPage();
    }
    return {
      snapshot: yield* hydrateSnapshot(page.operation),
      events: page.events,
    };
  });

  const acknowledgeEvents: VoiceThreadTurnService["Service"]["acknowledgeEvents"] = Effect.fn(
    "VoiceThreadTurnService.acknowledgeEvents",
  )(function* (authSessionId, operationId, input) {
    yield* authorize(authSessionId, operationId);
    const accepted = yield* store
      .acknowledge(
        operationId,
        ownershipHash(authSessionId, operationId),
        { ...input, occurredAt: yield* nowIso },
        yield* Clock.currentTimeMillis,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.acknowledge")));
    if (accepted === "revoked")
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.acknowledge",
        "Operation credential is no longer authorized",
        false,
      );
    if (accepted === "invalid")
      return yield* voiceError(
        "invalid-context",
        "thread-turn.acknowledge",
        "Acknowledgement exceeds produced sequence",
        false,
      );
    return yield* hydrateSnapshot(yield* load(operationId));
  });

  const speech: VoiceThreadTurnService["Service"]["speech"] = Effect.fn(
    "VoiceThreadTurnService.speech",
  )(function* (authSessionId, operationId, segmentIndex) {
    const operation = yield* authorize(authSessionId, operationId);
    if (!operation.speechEnabled)
      return yield* voiceError(
        "invalid-phase",
        "thread-turn.speech-disabled",
        "Speech synthesis is disabled for this operation",
        false,
      );
    const tokenHash = ownershipHash(authSessionId, operationId);
    const authorizedSegment = yield* store
      .getSpeechSegmentAuthorized(
        operationId,
        segmentIndex,
        tokenHash,
        yield* Clock.currentTimeMillis,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-segment")));
    if (authorizedSegment.status !== "ready") {
      if (authorizedSegment.status === "revoked")
        return yield* voiceError(
          "authorization-revoked",
          "thread-turn.speech-segment",
          "Operation credential is no longer authorized",
          false,
        );
      if (authorizedSegment.status === "detached")
        return yield* voiceError(
          "invalid-phase",
          "thread-turn.speech-segment",
          "Operation is detached from speech playback",
          false,
        );
      return yield* voiceError(
        "session-not-found",
        "thread-turn.speech-segment",
        "Speech segment was not found",
        false,
      );
    }
    const segment = authorizedSegment.segment;
    const text = yield* store
      .getSpeechSegmentText(operationId, segmentIndex)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-message")));
    if (text === undefined)
      return yield* voiceError(
        "invalid-context",
        "thread-turn.speech-message",
        "Immutable assistant speech revision is unavailable",
        false,
      );
    const settings = yield* getEnabledVoiceSettings;
    if (new TextEncoder().encode(text).byteLength > settings.maxSpeechTextBytes)
      return yield* voiceError(
        "payload-too-large",
        "thread-turn.speech-text-limit",
        "Speech segment exceeds the configured text limit",
        false,
      );
    const provider = yield* providers.resolve("speech.streaming");
    if (provider.speechSynthesizer === undefined)
      return yield* voiceError(
        "not-configured",
        "thread-turn.speech",
        "No speech synthesizer is configured",
        false,
      );
    const finalAuthorization = yield* store
      .getSpeechSegmentAuthorized(
        operationId,
        segmentIndex,
        tokenHash,
        yield* Clock.currentTimeMillis,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-authorize")));
    if (finalAuthorization.status !== "ready")
      return yield* voiceError(
        finalAuthorization.status === "revoked" ? "authorization-revoked" : "invalid-phase",
        "thread-turn.speech-authorize",
        "Speech playback authority changed before synthesis",
        false,
      );
    const permit = yield* limiter
      .acquire(settings.maxConcurrentMediaRequests)
      .pipe(
        Effect.mapError((cause) =>
          voiceError("quota-exceeded", "thread-turn.speech", cause.reason, true, cause),
        ),
      );
    return boundVoiceByteStream(
      provider.speechSynthesizer.synthesize({
        requestId: VoiceRequestId.make(`native-thread-speech:${operationId}:${segmentIndex}`),
        playbackId: VoicePlaybackId.make(`native-thread:${operationId}`),
        segmentIndex,
        finalSegment: segment.finalSegment,
        text,
        preset: operation.speechPreset,
      }),
      {
        maximumBytes: settings.maxSpeechOutputBytes,
        firstByteTimeoutSeconds: Math.min(15, settings.mediaRequestTimeoutSeconds),
        totalTimeoutSeconds: settings.mediaRequestTimeoutSeconds,
      },
    ).pipe(
      Stream.mapError((cause) =>
        isVoiceError(cause)
          ? cause
          : voiceError(
              "provider-unavailable",
              "thread-turn.speech",
              "Speech synthesis failed",
              true,
              cause,
            ),
      ),
      Stream.ensuring(permit.release),
    );
  });

  const cancel: VoiceThreadTurnService["Service"]["cancel"] = Effect.fn(
    "VoiceThreadTurnService.cancel",
  )(function* (authSessionId, operationId) {
    const operation = yield* authorize(authSessionId, operationId);
    if (terminalPhase(operation.phase))
      return {
        snapshot: yield* hydrateSnapshot(operation),
        cancelled: operation.phase === "cancelled",
      };
    const result = yield* store
      .cancel(
        operationId,
        ownershipHash(authSessionId, operationId),
        yield* nowIso,
        yield* Clock.currentTimeMillis,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.cancel")));
    if (result === "revoked")
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.cancel",
        "Operation credential is no longer authorized",
        false,
      );
    if (result === "dispatch-committed")
      return {
        snapshot: yield* hydrateSnapshot(yield* load(operationId)),
        cancelled: false,
      };
    return {
      snapshot: yield* hydrateSnapshot(yield* load(operationId)),
      cancelled: true,
    };
  });

  const readDraft: VoiceThreadTurnService["Service"]["readDraft"] = Effect.fn(
    "VoiceThreadTurnService.readDraft",
  )(function* (authSessionId, operationId) {
    const normalizedOperationId = VoiceThreadTurnOperationId.make(operationId);
    yield* authorize(authSessionId, normalizedOperationId);
    const result = yield* store
      .readDraftAuthorized(
        normalizedOperationId,
        ownershipHash(authSessionId, operationId),
        yield* Clock.currentTimeMillis,
        yield* nowIso,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.draft-read")));
    if (result.status !== "ready") {
      if (result.status === "revoked")
        return yield* voiceError(
          "authorization-revoked",
          "thread-turn.draft-read",
          "Operation credential is no longer authorized",
          false,
        );
      return yield* voiceError(
        "session-not-found",
        "thread-turn.draft-read",
        "Draft is unavailable",
        false,
      );
    }
    const draft = result.draft;
    if (draft.cipherVersion !== 1)
      return yield* voiceError(
        "invalid-context",
        "thread-turn.draft-decrypt",
        "Draft encryption version is unsupported",
        false,
      );
    const transcript = yield* Effect.try({
      try: () => {
        const bytes = Buffer.from(draft.ciphertext!);
        if (bytes.length < 17) throw new Error("encrypted draft is truncated");
        const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", draftKey, draft.nonce!);
        decipher.setAAD(Buffer.from(normalizedOperationId));
        decipher.setAuthTag(bytes.subarray(bytes.length - 16));
        return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(
          "utf8",
        );
      },
      catch: (cause) =>
        voiceError(
          "invalid-context",
          "thread-turn.draft-decrypt",
          "Draft could not be decrypted",
          false,
          cause,
        ),
    });
    return {
      operationId: normalizedOperationId,
      transcript,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(draft.expiresAt)),
    };
  });

  const consumeDraft: VoiceThreadTurnService["Service"]["consumeDraft"] = Effect.fn(
    "VoiceThreadTurnService.consumeDraft",
  )(function* (authSessionId, operationId) {
    const normalizedOperationId = VoiceThreadTurnOperationId.make(operationId);
    yield* authorize(authSessionId, normalizedOperationId);
    const result = yield* store
      .consumeDraft(
        normalizedOperationId,
        VoiceDraftArtifactId.make(`voice-draft:${normalizedOperationId}`),
        ownershipHash(authSessionId, operationId),
        yield* Clock.currentTimeMillis,
        yield* nowIso,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.draft-consume")));
    if (result === "revoked")
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.draft-consume",
        "Operation credential is no longer authorized",
        false,
      );
    if (result === "not-found" || result === "expired")
      return yield* voiceError(
        "session-not-found",
        "thread-turn.draft-consume",
        "Draft is unavailable",
        false,
      );
    return {
      snapshot: yield* hydrateSnapshot(yield* load(normalizedOperationId)),
      consumed: result === "consumed",
    };
  });

  const detach: VoiceThreadTurnService["Service"]["detach"] = Effect.fn(
    "VoiceThreadTurnService.detach",
  )(function* (authSessionId, operationId) {
    const normalizedOperationId = VoiceThreadTurnOperationId.make(operationId);
    yield* authorize(authSessionId, normalizedOperationId);
    const result = yield* store
      .detach(
        normalizedOperationId,
        ownershipHash(authSessionId, operationId),
        yield* Clock.currentTimeMillis,
        yield* nowIso,
      )
      .pipe(Effect.mapError(repositoryFailure("thread-turn.detach")));
    if (result === "revoked")
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.detach",
        "Operation credential is no longer authorized",
        false,
      );
    return yield* hydrateSnapshot(yield* load(normalizedOperationId));
  });

  yield* Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => store.listRecoverableOperationIds(now)),
    Effect.mapError(repositoryFailure("thread-turn.monitor-recovery")),
    Effect.flatMap((operationIds) =>
      Effect.forEach(operationIds, ensureMonitor, { discard: true }),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("Native thread voice monitor recovery failed", { cause }),
    ),
  );

  yield* maintain().pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );

  return VoiceThreadTurnService.of({
    authorizeOperation: (authSessionId, operationId) =>
      authorize(authSessionId, operationId).pipe(Effect.flatMap(hydrateSnapshot)),
    beginAudioUpload,
    create,
    uploadAudio,
    setDraftDisposition,
    events,
    acknowledgeEvents,
    speech,
    cancel,
    readDraft,
    consumeDraft,
    detach,
    revokeRuntime: (authSessionId, runtimeId) =>
      store.revokeRuntime(authSessionId, runtimeId).pipe(Effect.orDie),
  });
});

export const VoiceThreadTurnServiceLive = Layer.effect(VoiceThreadTurnService, make);

export const __testing = { restoreSpeechCursor, shouldAdvertiseSpeech };

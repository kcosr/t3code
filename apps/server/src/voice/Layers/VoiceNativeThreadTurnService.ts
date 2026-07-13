import {
  CommandId,
  MessageId,
  VoiceNativeThreadTurnOperationId,
  VoicePlaybackId,
  VoiceRequestId,
  type VoicePublicErrorReason,
  type VoiceNativeThreadTurnSnapshot,
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
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnStartRepository } from "../../persistence/Services/ProjectionTurnStarts.ts";
import {
  VoiceNativeThreadTurnStore,
  type PersistedVoiceNativeThreadTurn,
  type VoiceNativeThreadTurnEventWithoutSequence,
} from "../../persistence/Services/VoiceNativeThreadTurns.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VoiceError } from "../Errors.ts";
import { inspectVoiceMp4 } from "../Services/VoiceMp4Inspector.ts";
import {
  boundVoiceByteStream,
  boundVoiceMediaEffect,
  VOICE_TRANSCRIPTION_OUTPUT_MAX_BYTES,
  VoiceMediaRequestLimiter,
} from "../Services/VoiceMediaPolicy.ts";
import { VoiceNativeRuntimeGrantRegistry } from "../Services/VoiceNativeRuntimeGrantRegistry.ts";
import { VoiceNativeThreadTurnService } from "../Services/VoiceNativeThreadTurnService.ts";
import { VoiceProviderRegistry } from "../Services/VoiceProviderRegistry.ts";

const OPERATION_TTL_MILLIS = 2 * 60 * 60 * 1_000;
const PROCESSING_LEASE_MILLIS = 5 * 60 * 1_000;
const EVENT_PAGE_LIMIT = 100;
const TERMINAL_RETENTION_MILLIS = 24 * 60 * 60 * 1_000;
const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
const deterministicHash = (...values: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(values.join("\0")).digest("base64url");
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

const snapshot = (record: PersistedVoiceNativeThreadTurn): VoiceNativeThreadTurnSnapshot => ({
  operationId: record.operationId,
  runtimeId: record.runtimeId,
  generation: record.runtimeGeneration,
  projectId: record.projectId,
  threadId: record.threadId,
  speechPreset: record.speechPreset,
  autoRearm: record.autoRearm,
  phase: record.phase,
  messageId: record.messageId,
  turnId: record.turnId,
  lastSequence: record.lastSequence,
  acknowledgedSequence: record.acknowledgedSequence,
  speechTerminal: record.speechTerminal,
  dispatchAccepted: record.dispatchAccepted,
  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(record.expiresAt)),
});

const terminalPhase = (phase: PersistedVoiceNativeThreadTurn["phase"]) =>
  phase === "completed" || phase === "failed" || phase === "cancelled";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const store = yield* VoiceNativeThreadTurnStore;
  const runtimeGrants = yield* VoiceNativeRuntimeGrantRegistry;
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
  const load = Effect.fn("VoiceNativeThreadTurnService.load")(function* (
    operationId: VoiceNativeThreadTurnOperationId,
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
  const authorize = Effect.fn("VoiceNativeThreadTurnService.authorize")(function* (
    token: string,
    operationId: VoiceNativeThreadTurnOperationId,
  ) {
    if (token.length === 0 || token.length > 128)
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.authorize",
        "Operation credential is invalid",
        false,
      );
    const now = yield* Clock.currentTimeMillis;
    const record = yield* store
      .authorize(operationId, hashToken(token), now)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.authorize")));
    if (record === undefined)
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.authorize",
        "Operation credential is invalid or expired",
        false,
      );
    return record;
  });
  const append = (
    operationId: VoiceNativeThreadTurnOperationId,
    event: VoiceNativeThreadTurnEventWithoutSequence,
    updates?: Parameters<typeof store.appendEvent>[2],
  ) =>
    store
      .appendEvent(operationId, event, updates)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.event")));

  const maintain = Effect.fn("VoiceNativeThreadTurnService.maintain")(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* store
      .expireAndPurge(now, yield* nowIso, now - TERMINAL_RETENTION_MILLIS)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.maintenance")));
  });

  const monitorLoop = Effect.fn("VoiceNativeThreadTurnService.monitor")(function* (
    operationId: VoiceNativeThreadTurnOperationId,
  ) {
    let priorText = "";
    let chunker = initialSpeechChunkerState();
    let emittedOffset = 0;
    let revisedNonPrefix = false;
    let attention: "approval" | "user-input" | undefined;
    while (true) {
      const operation = yield* load(operationId);
      if (terminalPhase(operation.phase) || operation.messageId === null) return;
      if (operation.expiresAt <= (yield* Clock.currentTimeMillis)) {
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
      if (turn.assistantMessageId !== null) {
        const assistant = yield* messages
          .getByMessageId({ messageId: turn.assistantMessageId })
          .pipe(Effect.mapError(repositoryFailure("thread-turn.message")));
        if (Option.isSome(assistant)) {
          const text = assistant.value.text;
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
          const chunked = revisedNonPrefix
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
      const speechOutcome =
        latest.lastSequence > 0 && chunker.nextIndex > 0
          ? ("completed" as const)
          : ("no-speech" as const);
      yield* Effect.logInfo("Native thread voice monitor completed", {
        operationId,
        turnId: turn.turnId,
        speechSegmentCount: chunker.nextIndex,
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

  const ensureMonitor = Effect.fn("VoiceNativeThreadTurnService.ensureMonitor")(function* (
    operationId: VoiceNativeThreadTurnOperationId,
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
          : Effect.logError("Native thread voice monitor failed", { operationId, cause }).pipe(
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

  const reconcileOrDispatch = Effect.fn("VoiceNativeThreadTurnService.reconcileOrDispatch")(
    function* (operation: PersistedVoiceNativeThreadTurn, leaseToken: string, transcript?: string) {
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
            message: { messageId, role: "user", text: transcript, attachments: [] },
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
    },
  );

  const create: VoiceNativeThreadTurnService["Service"]["create"] = Effect.fn(
    "VoiceNativeThreadTurnService.create",
  )(function* (runtimeToken, input) {
    yield* getEnabledVoiceSettings;
    yield* maintain();
    const grant = yield* runtimeGrants.authorize(runtimeToken);
    if (
      grant === undefined ||
      grant.target.mode !== "thread" ||
      grant.runtimeId !== input.runtimeId ||
      grant.generation !== input.generation
    )
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.create",
        "Runtime credential is invalid",
        false,
      );
    const token = yield* crypto
      .randomBytes(32)
      .pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);
    const now = yield* Clock.currentTimeMillis;
    const operationId = VoiceNativeThreadTurnOperationId.make(
      `native-thread-turn:${deterministicHash(grant.authSessionId, grant.runtimeId, String(grant.generation), input.clientOperationId)}`,
    );
    const currentGrant = yield* runtimeGrants.authorize(runtimeToken);
    if (
      currentGrant === undefined ||
      currentGrant.target.mode !== "thread" ||
      currentGrant.authSessionId !== grant.authSessionId ||
      currentGrant.runtimeId !== grant.runtimeId ||
      currentGrant.generation !== grant.generation
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
        authSessionId: grant.authSessionId,
        runtimeId: grant.runtimeId,
        runtimeGeneration: grant.generation,
        clientOperationId: input.clientOperationId,
        projectId: grant.target.projectId,
        threadId: grant.target.threadId,
        speechPreset: grant.target.speechPreset,
        autoRearm: grant.target.autoRearm,
        tokenHash: hashToken(token),
        expiresAt: Math.min(grant.expiresAt, now + OPERATION_TTL_MILLIS),
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
    return {
      snapshot: snapshot(created),
      operationGrant: {
        token,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(created.expiresAt)),
      },
    };
  });

  const uploadAudio: VoiceNativeThreadTurnService["Service"]["uploadAudio"] = Effect.fn(
    "VoiceNativeThreadTurnService.uploadAudio",
  )(function* (operationToken, operationId, bytes, language) {
    const operation = yield* authorize(operationToken, operationId);
    if (terminalPhase(operation.phase))
      return { snapshot: snapshot(operation), disposition: "terminal" };
    if (operation.dispatchAccepted) {
      yield* ensureMonitor(operationId);
      return { snapshot: snapshot(operation), disposition: "already-dispatched" };
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
              { type: "phase", occurredAt: yield* nowIso, phase: "transcribing" },
              { phase: "transcribing" },
            );
            const deterministicMessageId = MessageId.make(
              `native-thread-message:${operation.operationId}`,
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
            yield* reconcileOrDispatch(operation, leaseToken, transcript);
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
    return { snapshot: snapshot(current), disposition: "processing" };
  });

  const beginAudioUpload: VoiceNativeThreadTurnService["Service"]["beginAudioUpload"] = Effect.fn(
    "VoiceNativeThreadTurnService.beginAudioUpload",
  )(function* (operationToken, operationId) {
    yield* authorize(operationToken, operationId);
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
        uploadAudio(operationToken, operationId, bytes, language),
      release: permit.release,
    };
  });

  const events: VoiceNativeThreadTurnService["Service"]["events"] = Effect.fn(
    "VoiceNativeThreadTurnService.events",
  )(function* (operationToken, operationId, eventQuery) {
    yield* maintain();
    const readPage = Effect.fn("VoiceNativeThreadTurnService.readEventPage")(function* () {
      const page = yield* store
        .readEventPage(
          operationId,
          hashToken(operationToken),
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
    return { snapshot: snapshot(page.operation), events: page.events };
  });

  const acknowledgeEvents: VoiceNativeThreadTurnService["Service"]["acknowledgeEvents"] = Effect.fn(
    "VoiceNativeThreadTurnService.acknowledgeEvents",
  )(function* (operationToken, operationId, acknowledgedSequence) {
    yield* authorize(operationToken, operationId);
    const accepted = yield* store
      .acknowledge(
        operationId,
        hashToken(operationToken),
        acknowledgedSequence,
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
    return snapshot(yield* load(operationId));
  });

  const speech: VoiceNativeThreadTurnService["Service"]["speech"] = Effect.fn(
    "VoiceNativeThreadTurnService.speech",
  )(function* (operationToken, operationId, segmentIndex) {
    const operation = yield* authorize(operationToken, operationId);
    const segment = yield* store
      .getSpeechSegment(operationId, segmentIndex)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-segment")));
    if (segment === undefined)
      return yield* voiceError(
        "session-not-found",
        "thread-turn.speech-segment",
        "Speech segment was not found",
        false,
      );
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
    yield* authorize(operationToken, operationId);
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

  const cancel: VoiceNativeThreadTurnService["Service"]["cancel"] = Effect.fn(
    "VoiceNativeThreadTurnService.cancel",
  )(function* (operationToken, operationId) {
    const operation = yield* authorize(operationToken, operationId);
    if (terminalPhase(operation.phase))
      return { snapshot: snapshot(operation), cancelled: operation.phase === "cancelled" };
    const result = yield* store
      .cancel(operationId, hashToken(operationToken), yield* nowIso, yield* Clock.currentTimeMillis)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.cancel")));
    if (result === "revoked")
      return yield* voiceError(
        "authorization-revoked",
        "thread-turn.cancel",
        "Operation credential is no longer authorized",
        false,
      );
    if (result === "dispatch-committed")
      return { snapshot: snapshot(yield* load(operationId)), cancelled: false };
    return { snapshot: snapshot(yield* load(operationId)), cancelled: true };
  });

  yield* maintain().pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );

  return VoiceNativeThreadTurnService.of({
    authorizeCreate: (runtimeToken) =>
      runtimeGrants
        .authorize(runtimeToken)
        .pipe(
          Effect.flatMap((grant) =>
            grant?.target.mode === "thread"
              ? Effect.void
              : Effect.fail(
                  voiceError(
                    "authorization-revoked",
                    "thread-turn.create-authorize",
                    "Runtime credential is invalid",
                    false,
                  ),
                ),
          ),
        ),
    authorizeOperation: (operationToken, operationId) =>
      authorize(operationToken, operationId).pipe(Effect.map(snapshot)),
    beginAudioUpload,
    create,
    uploadAudio,
    events,
    acknowledgeEvents,
    speech,
    cancel,
    revokeRuntime: (authSessionId, runtimeId) =>
      store.revokeRuntime(authSessionId, runtimeId).pipe(Effect.orDie),
  });
});

export const VoiceNativeThreadTurnServiceLive = Layer.effect(VoiceNativeThreadTurnService, make);

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
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
  VoiceMediaRequestLimiter,
} from "../Services/VoiceMediaPolicy.ts";
import { VoiceNativeRuntimeGrantRegistry } from "../Services/VoiceNativeRuntimeGrantRegistry.ts";
import { VoiceNativeThreadTurnService } from "../Services/VoiceNativeThreadTurnService.ts";
import { VoiceProviderRegistry } from "../Services/VoiceProviderRegistry.ts";

const OPERATION_TTL_MILLIS = 2 * 60 * 60 * 1_000;
const PROCESSING_LEASE_MILLIS = 5 * 60 * 1_000;
const EVENT_PAGE_LIMIT = 100;
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
      const [outcome, shell] = yield* Effect.all([
        turnStarts.getOutcomeByMessageId({
          threadId: operation.threadId,
          messageId: operation.messageId,
        }),
        query.getThreadShellById(operation.threadId),
      ]).pipe(Effect.mapError(repositoryFailure("thread-turn.projection")));
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
        const occurredAt = yield* nowIso;
        yield* append(
          operationId,
          { type: "failure", occurredAt, code: "turn-failed", retryable: false },
          { phase: "failed" },
        );
        yield* append(
          operationId,
          { type: "speech-terminal", occurredAt, outcome: "no-speech" },
          { speechTerminal: "no-speech" },
        );
        yield* append(
          operationId,
          { type: "terminal", occurredAt, outcome: "failed" },
          { terminal: true },
        );
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
          const prefixUpdate = text.startsWith(priorText);
          const delta = prefixUpdate ? text.slice(priorText.length) : "";
          priorText = text;
          if (!prefixUpdate) revisedNonPrefix = true;
          const terminal = turn.state !== "running";
          const indexOffset = terminal && revisedNonPrefix ? chunker.nextIndex : 0;
          if (terminal && revisedNonPrefix) {
            chunker = initialSpeechChunkerState();
            emittedOffset = 0;
          }
          const chunked = appendSpeechText(
            chunker,
            terminal && revisedNonPrefix ? text : revisedNonPrefix ? "" : delta,
            terminal,
          );
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
              .putSpeechSegment({
                operationId,
                segmentIndex: segment.index + indexOffset,
                assistantMessageId: assistant.value.messageId,
                startOffset,
                endOffset,
                finalSegment: segment.finalSegment,
                createdAt: occurredAt,
              })
              .pipe(Effect.mapError(repositoryFailure("thread-turn.segment")));
            if (inserted) {
              yield* append(
                operationId,
                {
                  type: "speech-ready",
                  occurredAt,
                  segmentIndex: segment.index + indexOffset,
                  finalSegment: segment.finalSegment,
                },
                { phase: "speaking" },
              );
            }
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
      yield* append(
        operationId,
        { type: "speech-terminal", occurredAt, outcome: speechOutcome },
        { speechTerminal: speechOutcome },
      );
      if (terminal === "failed")
        yield* append(
          operationId,
          { type: "failure", occurredAt, code: "turn-failed", retryable: false },
          { phase: "failed" },
        );
      else
        yield* append(
          operationId,
          { type: "phase", occurredAt, phase: "completed" },
          { phase: "completed" },
        );
      yield* append(
        operationId,
        { type: "terminal", occurredAt, outcome: terminal },
        { terminal: true },
      );
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
      Effect.ensuring(Effect.sync(() => activeMonitors.delete(operationId))),
      Effect.forkDetach,
    );
  });

  const reconcileOrDispatch = Effect.fn("VoiceNativeThreadTurnService.reconcileOrDispatch")(
    function* (operation: PersistedVoiceNativeThreadTurn, transcript?: string) {
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
                    "invalid-context",
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
            "invalid-context",
            "thread-turn.target",
            "Thread target changed",
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
      yield* append(
        operation.operationId,
        {
          type: "dispatch-correlation",
          occurredAt: yield* nowIso,
          commandId,
          messageId,
          turnId: null,
        },
        {
          phase: "waiting",
          commandId,
          messageId,
          dispatchAccepted: true,
          clearProcessingLease: true,
        },
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
    const created = yield* store
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
    const deterministicMessageId = MessageId.make(`native-thread-message:${operation.operationId}`);
    const reconciledMessage = yield* messages
      .getByMessageId({ messageId: deterministicMessageId })
      .pipe(Effect.mapError(repositoryFailure("thread-turn.reconcile")));
    if (Option.isSome(reconciledMessage)) {
      yield* reconcileOrDispatch(operation);
      return {
        snapshot: snapshot(yield* load(operationId)),
        disposition: "already-dispatched",
      };
    }
    const settings = yield* getVoiceSettings;
    if (bytes.byteLength > settings.maxUploadBytes)
      return yield* voiceError(
        "payload-too-large",
        "thread-turn.audio",
        "Audio exceeds configured limit",
        false,
      );
    const validated = yield* inspectVoiceMp4(bytes, settings.maxInputDurationSeconds).pipe(
      Effect.mapError((cause) =>
        voiceError("unsupported-media", "thread-turn.audio", cause.reason, false, cause),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    const claimed = yield* store
      .claimProcessing(operationId, now, now + PROCESSING_LEASE_MILLIS, yield* nowIso)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.processing-lease")));
    if (!claimed)
      return yield* voiceError(
        "lease-conflict",
        "thread-turn.audio",
        "Operation is already processing",
        true,
      );
    yield* append(
      operationId,
      { type: "phase", occurredAt: yield* nowIso, phase: "transcribing" },
      { phase: "transcribing" },
    );
    const processing = yield* Effect.gen(function* () {
      const permit = yield* limiter
        .acquire(settings.maxConcurrentMediaRequests)
        .pipe(
          Effect.mapError((cause) =>
            voiceError("quota-exceeded", "thread-turn.audio", cause.reason, true, cause),
          ),
        );
      const transcript = yield* Effect.gen(function* () {
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
            text.length === 0
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
      }).pipe(Effect.ensuring(permit.release));
      yield* append(
        operationId,
        { type: "phase", occurredAt: yield* nowIso, phase: "dispatching" },
        { phase: "dispatching" },
      );
      yield* reconcileOrDispatch(operation, transcript);
    }).pipe(Effect.result);
    if (Result.isFailure(processing)) {
      const error = processing.failure;
      const occurredAt = yield* nowIso;
      const code = error.operation.includes("dispatch")
        ? ("dispatch-failed" as const)
        : ("transcription-failed" as const);
      yield* append(
        operationId,
        { type: "failure", occurredAt, code, retryable: error.retryable },
        {
          phase: error.retryable ? "created" : "failed",
          clearProcessingLease: true,
          ...(error.retryable ? {} : { terminal: true }),
        },
      );
      if (!error.retryable) {
        yield* append(
          operationId,
          { type: "speech-terminal", occurredAt, outcome: "failed" },
          { speechTerminal: "failed" },
        );
        yield* append(
          operationId,
          { type: "terminal", occurredAt, outcome: "failed" },
          { terminal: true },
        );
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

  const events: VoiceNativeThreadTurnService["Service"]["events"] = Effect.fn(
    "VoiceNativeThreadTurnService.events",
  )(function* (operationToken, operationId, eventQuery) {
    const operation = yield* authorize(operationToken, operationId);
    if (operation.dispatchAccepted && !terminalPhase(operation.phase))
      yield* ensureMonitor(operationId);
    const started = yield* Clock.currentTimeMillis;
    let found = yield* store
      .listEvents(operationId, eventQuery.afterSequence, EVENT_PAGE_LIMIT)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.events")));
    while (
      found.length === 0 &&
      (yield* Clock.currentTimeMillis) - started < eventQuery.waitMilliseconds
    ) {
      yield* Effect.sleep("100 millis");
      found = yield* store
        .listEvents(operationId, eventQuery.afterSequence, EVENT_PAGE_LIMIT)
        .pipe(Effect.mapError(repositoryFailure("thread-turn.events")));
    }
    return { snapshot: snapshot(yield* load(operationId)), events: found };
  });

  const acknowledgeEvents: VoiceNativeThreadTurnService["Service"]["acknowledgeEvents"] = Effect.fn(
    "VoiceNativeThreadTurnService.acknowledgeEvents",
  )(function* (operationToken, operationId, acknowledgedSequence) {
    yield* authorize(operationToken, operationId);
    const accepted = yield* store
      .acknowledge(operationId, acknowledgedSequence)
      .pipe(Effect.mapError(repositoryFailure("thread-turn.acknowledge")));
    if (!accepted)
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
    const assistant = yield* messages
      .getByMessageId({ messageId: segment.assistantMessageId })
      .pipe(Effect.mapError(repositoryFailure("thread-turn.speech-message")));
    if (Option.isNone(assistant) || assistant.value.role !== "assistant")
      return yield* voiceError(
        "session-not-found",
        "thread-turn.speech-message",
        "Canonical assistant message was not found",
        false,
      );
    const text = assistant.value.text.slice(segment.startOffset, segment.endOffset);
    if (text.length === 0 || segment.endOffset > assistant.value.text.length)
      return yield* voiceError(
        "invalid-context",
        "thread-turn.speech-message",
        "Canonical assistant speech boundary is unavailable",
        false,
      );
    const settings = yield* getVoiceSettings;
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
    const occurredAt = yield* nowIso;
    yield* append(
      operationId,
      { type: "phase", occurredAt, phase: "cancelled" },
      { phase: "cancelled" },
    );
    yield* append(
      operationId,
      { type: "terminal", occurredAt, outcome: "cancelled" },
      { terminal: true },
    );
    return { snapshot: snapshot(yield* load(operationId)), cancelled: true };
  });

  return VoiceNativeThreadTurnService.of({
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

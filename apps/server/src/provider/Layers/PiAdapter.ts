/**
 * PiAdapterLive — stock Pi RPC (`pi --mode rpc`) mapped to canonical T3 events.
 *
 * @module PiAdapterLive
 */

// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  EventId,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  clampPiThinkingLevel,
  encodePiModelSlug,
  isPiThinkingLevel,
  isValidPiSessionId,
  parsePiModelSlug,
  preferPiSessionIdFromThreadId,
  type PiThinkingLevel,
} from "../pi/modelSlug.ts";
import { isPiExtensionUiRequest, isPiResumeCursor, type PiResumeCursor } from "../pi/protocol.ts";
import { classifyPiTurnFailure } from "../pi/turnFailure.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  buildPiEnvironment,
  makePiSessionRuntime,
  type PiRuntimeNativeEvent,
  type PiSessionRuntimeError,
  type PiSessionRuntimeShape,
  type PiSpawnArgs,
} from "./PiSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const PROVIDER = ProviderDriverKind.make("piAgent");
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_DETAIL_CHARS = 8_000;
const PI_EXTENSION_LIMITED_BRIDGE_MESSAGE =
  "Pi extensions are loaded with T3's limited UI bridge. select/confirm/input/editor/notify are supported; TUI-only widgets and editor hooks are ignored.";

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Test seam: inject a runtime factory instead of spawning Pi. */
  readonly makeRuntime?: (
    options: Parameters<typeof makePiSessionRuntime>[0],
  ) => Effect.Effect<
    PiSessionRuntimeShape,
    never,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

interface PendingConfirm {
  readonly nativeId: string;
  readonly requestType: "unknown";
}

interface PendingUserInput {
  readonly nativeId: string;
  readonly method: "select" | "input" | "editor";
  readonly options: ReadonlyArray<string>;
}

interface ActiveMessageItem {
  readonly itemId: string;
  readonly kind: "assistant_message" | "reasoning";
}

interface ActiveToolItem {
  readonly itemId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  lastDetail: string | undefined;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly runtime: PiSessionRuntimeShape;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingConfirms: Map<ApprovalRequestId, PendingConfirm>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  activeMessage: ActiveMessageItem | undefined;
  readonly activeTools: Map<string, ActiveToolItem>;
  /** Open context-compaction item awaiting compaction_end. */
  activeCompactionItemId: string | undefined;
  /** One-shot warnings for TUI-only extension UI methods. */
  readonly unsupportedExtensionMethods: Set<string>;
  extensionLimitedBridgeWarned: boolean;
  generation: number;
  stopped: boolean;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function mapPiRuntimeError(
  error: PiSessionRuntimeError,
  operation: string,
  threadId: ThreadId | string = "unknown",
): ProviderAdapterProcessError | ProviderAdapterRequestError | ProviderAdapterValidationError {
  switch (error._tag) {
    case "PiSessionRuntimeSpawnError":
      return new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: String(threadId),
        detail: `${operation}: ${error.message}`,
        cause: error.cause,
      });
    case "PiSessionRuntimeStateError":
    case "PiSessionRuntimeCommandError":
      return new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: error.message,
      });
    case "PiSessionRuntimeTimeoutError":
    case "PiSessionRuntimeProtocolError":
    case "PiSessionRuntimeExitedError":
    case "PiSessionRuntimeClosedError":
      return new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: String(threadId),
        detail: `${operation}: ${error.message}`,
      });
  }
}

function assertFullAccessRuntimeMode(
  runtimeMode: RuntimeMode,
  operation: string,
): Effect.Effect<void, ProviderAdapterValidationError> {
  if (runtimeMode !== "full-access") {
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: `Pi only supports full-access runtime mode (received '${runtimeMode}'). Project trust does not provide Codex-equivalent sandboxing.`,
      }),
    );
  }
  return Effect.void;
}

function toolItemType(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "dynamic_tool_call";
    case "edit":
    case "write":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

function toolTitle(toolName: string): string {
  switch (toolName) {
    case "bash":
      return "Ran command";
    case "edit":
    case "write":
      return "File change";
    case "read":
      return "Read file";
    case "grep":
    case "find":
    case "ls":
      return "Search";
    default:
      return toolName || "Tool call";
  }
}

function boundText(value: unknown, max = MAX_TOOL_DETAIL_CHARS): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  }
  if (value === undefined || value === null) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return undefined;
    return encoded.length > max ? `${encoded.slice(0, max)}…` : encoded;
  } catch {
    return undefined;
  }
}

function extractToolTextResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return boundText(result);
  }
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const parts: string[] = [];
    for (const part of record.content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          parts.push(text);
        }
      }
    }
    if (parts.length > 0) {
      return boundText(parts.join(""));
    }
  }
  return boundText(result);
}

function isPathInsideDirectory(candidatePath: string, directory: string): boolean {
  const resolvedCandidate = NodePath.resolve(candidatePath);
  const resolvedDir = NodePath.resolve(directory);
  if (resolvedCandidate === resolvedDir) {
    return true;
  }
  const prefix = resolvedDir.endsWith(NodePath.sep) ? resolvedDir : `${resolvedDir}${NodePath.sep}`;
  return resolvedCandidate.startsWith(prefix);
}

function parseResumeCursor(
  raw: unknown,
  sessionDir: string | undefined,
): Effect.Effect<PiResumeCursor, ProviderAdapterValidationError> {
  if (!isPiResumeCursor(raw)) {
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "Invalid Pi resume cursor (expected versioned { sessionId, sessionPath, cwd }).",
      }),
    );
  }
  if (!raw.sessionId.trim() || !raw.sessionPath.trim() || !raw.cwd.trim()) {
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "Pi resume cursor fields must be non-empty absolute paths / ids.",
      }),
    );
  }
  if (sessionDir) {
    const expanded = expandHomePath(sessionDir);
    if (!isPathInsideDirectory(raw.sessionPath, expanded)) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Pi resume session path is outside the configured session directory.",
        }),
      );
    }
  }
  return Effect.succeed(raw);
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("piAgent");
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processEnv = options?.environment ?? process.env;
    const makeRuntime = options?.makeRuntime ?? makePiSessionRuntime;

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessionsRef = yield* SynchronizedRef.make(new Map<ThreadId, PiSessionContext>());

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

    /** Widen partial runtime events into the canonical union for PubSub. */
    const publishRuntime = (event: Record<string, unknown>) => emit(event as ProviderRuntimeEvent);

    const buildEventBase = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly raw?: unknown;
      readonly method?: string | undefined;
    }) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: nowIso,
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          ...(input.itemId !== undefined ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId !== undefined
            ? { requestId: RuntimeRequestId.make(input.requestId) }
            : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "pi.rpc" as const,
                  ...(input.method !== undefined ? { method: input.method } : {}),
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    const writeNative = (threadId: ThreadId, event: unknown) => {
      if (!nativeEventLogger) {
        return Effect.void;
      }
      return nowIso.pipe(
        Effect.flatMap((observedAt) =>
          nativeEventLogger.write(
            {
              observedAt,
              provider: PROVIDER,
              threadId,
              payload: event,
            },
            threadId,
          ),
        ),
        Effect.ignore,
      );
    };

    const settlePendingAsCancelled = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        for (const [requestId, pending] of ctx.pendingConfirms) {
          yield* publishRuntime({
            ...(yield* buildEventBase({
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              requestId,
            })),
            type: "request.resolved",
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
          }).pipe(Effect.ignore);
        }
        ctx.pendingConfirms.clear();
        for (const [requestId] of ctx.pendingUserInputs) {
          yield* publishRuntime({
            ...(yield* buildEventBase({
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              requestId,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          }).pipe(Effect.ignore);
        }
        ctx.pendingUserInputs.clear();
      });

    const clearTurnLocalState = (ctx: PiSessionContext) => {
      ctx.activeTurnId = undefined;
      ctx.activeMessage = undefined;
      ctx.activeTools.clear();
      ctx.activeCompactionItemId = undefined;
    };

    const stopContext = (
      ctx: PiSessionContext,
      reason: string,
      recoverable: boolean,
      options?: { readonly interruptEventFiber?: boolean },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) {
          return;
        }
        ctx.stopped = true;
        ctx.generation += 1;
        const eventFiber = ctx.eventFiber;
        ctx.eventFiber = undefined;
        if (ctx.activeTurnId) {
          yield* publishRuntime({
            ...(yield* buildEventBase({ threadId: ctx.threadId, turnId: ctx.activeTurnId })),
            type: "turn.completed",
            payload: {
              state: "interrupted",
              errorMessage: reason,
            },
          }).pipe(Effect.ignore);
          clearTurnLocalState(ctx);
        }
        yield* settlePendingAsCancelled(ctx);
        // Emit session.exited and close resources before any event-fiber interrupt so a
        // process_exit handler running ON that fiber still finishes map removal + teardown.
        yield* publishRuntime({
          ...(yield* buildEventBase({ threadId: ctx.threadId })),
          type: "session.exited",
          payload: {
            reason,
            recoverable,
            exitKind: recoverable ? "error" : "graceful",
          },
        }).pipe(Effect.ignore);
        yield* ctx.runtime.close.pipe(Effect.ignore);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        // Never interrupt the currently-running event drain fiber (process_exit path).
        // The stream ends after process exit; stopSession/stopAll may interrupt from outside.
        if (options?.interruptEventFiber !== false && eventFiber) {
          yield* Fiber.interrupt(eventFiber).pipe(Effect.ignore);
        }
      });

    const handleNativeEvent = (ctx: PiSessionContext, event: PiRuntimeNativeEvent) =>
      Effect.gen(function* () {
        if (ctx.stopped) {
          return;
        }
        yield* writeNative(ctx.threadId, event);
        const turnId = ctx.activeTurnId;
        const type = event.type;

        if (type === "t3.pi.process_exit") {
          yield* SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
            Effect.gen(function* () {
              if (sessions.get(ctx.threadId) !== ctx) {
                return sessions;
              }
              const next = new Map(sessions);
              next.delete(ctx.threadId);
              yield* stopContext(
                ctx,
                typeof event.detail === "string" ? event.detail : "Pi process exited",
                true,
                { interruptEventFiber: false },
              );
              return next;
            }),
          );
          return;
        }

        if (isPiExtensionUiRequest(event)) {
          yield* handleExtensionUi(ctx, event);
          return;
        }

        switch (type) {
          case "agent_start": {
            // turn already started on sendTurn; keep as marker only
            break;
          }
          case "message_start": {
            const message = event.message as Record<string, unknown> | undefined;
            const role = typeof message?.role === "string" ? message.role : "assistant";
            if (role === "assistant" || role === "thinking" || role === "reasoning") {
              const itemId = `pi-msg-${yield* randomUUIDv4}`;
              const kind =
                role === "thinking" || role === "reasoning" ? "reasoning" : "assistant_message";
              ctx.activeMessage = { itemId, kind };
              yield* publishRuntime({
                ...(yield* buildEventBase({
                  threadId: ctx.threadId,
                  turnId,
                  itemId,
                  raw: event,
                  method: type,
                })),
                type: "item.started",
                payload: {
                  itemType: kind,
                  status: "inProgress",
                  title: kind === "reasoning" ? "Reasoning" : "Assistant message",
                },
              });
            }
            break;
          }
          case "message_update": {
            const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
            const ameType = typeof ame?.type === "string" ? ame.type : "";
            if (ameType === "error") {
              const reason = typeof ame?.reason === "string" ? ame.reason : "error";
              const message =
                typeof ame?.errorMessage === "string"
                  ? ame.errorMessage
                  : reason === "aborted"
                    ? "Interrupted by user."
                    : "Pi assistant message failed.";
              if (turnId && ctx.activeTurnId === turnId) {
                const classification =
                  reason === "aborted"
                    ? { state: "interrupted" as const, stopReason: "aborted" as const }
                    : classifyPiTurnFailure(message);
                clearTurnLocalState(ctx);
                ctx.session = {
                  ...ctx.session,
                  status: "ready",
                  activeTurnId: undefined,
                  updatedAt: yield* nowIso,
                  lastError: message,
                };
                yield* publishRuntime({
                  ...(yield* buildEventBase({
                    threadId: ctx.threadId,
                    turnId,
                    raw: event,
                    method: type,
                  })),
                  type: "turn.completed",
                  payload: {
                    state: classification.state,
                    stopReason: classification.stopReason,
                    errorMessage: message,
                  },
                });
              }
              break;
            }
            if (ameType === "text_delta" || ameType === "thinking_delta") {
              const delta = typeof ame?.delta === "string" ? ame.delta : "";
              if (delta.length === 0) break;
              if (!ctx.activeMessage) {
                const itemId = `pi-msg-${yield* randomUUIDv4}`;
                const kind = ameType === "thinking_delta" ? "reasoning" : "assistant_message";
                ctx.activeMessage = { itemId, kind };
                yield* publishRuntime({
                  ...(yield* buildEventBase({
                    threadId: ctx.threadId,
                    turnId,
                    itemId,
                    raw: event,
                    method: type,
                  })),
                  type: "item.started",
                  payload: {
                    itemType: kind,
                    status: "inProgress",
                    title: kind === "reasoning" ? "Reasoning" : "Assistant message",
                  },
                });
              }
              yield* publishRuntime({
                ...(yield* buildEventBase({
                  threadId: ctx.threadId,
                  turnId,
                  itemId: ctx.activeMessage.itemId,
                  raw: event,
                  method: type,
                })),
                type: "content.delta",
                payload: {
                  streamKind: ameType === "thinking_delta" ? "reasoning_text" : "assistant_text",
                  delta,
                },
              });
            }
            break;
          }
          case "message_end": {
            if (ctx.activeMessage) {
              yield* publishRuntime({
                ...(yield* buildEventBase({
                  threadId: ctx.threadId,
                  turnId,
                  itemId: ctx.activeMessage.itemId,
                  raw: event,
                  method: type,
                })),
                type: "item.completed",
                payload: {
                  itemType: ctx.activeMessage.kind,
                  status: "completed",
                  title: ctx.activeMessage.kind === "reasoning" ? "Reasoning" : "Assistant message",
                },
              });
              ctx.activeMessage = undefined;
            }
            break;
          }
          case "tool_execution_start": {
            const toolCallId =
              typeof event.toolCallId === "string"
                ? event.toolCallId
                : `tool-${yield* randomUUIDv4}`;
            const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
            const detail = boundText(event.args);
            ctx.activeTools.set(toolCallId, {
              itemId: toolCallId,
              toolCallId,
              toolName,
              lastDetail: detail,
            });
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                itemId: toolCallId,
                raw: event,
                method: type,
              })),
              type: "item.started",
              payload: {
                itemType: toolItemType(toolName),
                status: "inProgress",
                title: toolTitle(toolName),
                ...(detail ? { detail } : {}),
                data: { toolName, args: event.args },
              },
              providerRefs: { providerItemId: ProviderItemId.make(toolCallId) },
            });
            break;
          }
          case "tool_execution_update": {
            const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
            if (!toolCallId) break;
            const tool = ctx.activeTools.get(toolCallId);
            if (!tool) break;
            const detail =
              extractToolTextResult(event.partialResult) ?? tool.lastDetail ?? undefined;
            // Replace, do not append accumulated progress.
            if (detail === tool.lastDetail) break;
            tool.lastDetail = detail;
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                itemId: tool.itemId,
                raw: event,
                method: type,
              })),
              type: "item.updated",
              payload: {
                itemType: toolItemType(tool.toolName),
                status: "inProgress",
                title: toolTitle(tool.toolName),
                ...(detail ? { detail } : {}),
              },
            });
            break;
          }
          case "tool_execution_end": {
            const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
            if (!toolCallId) break;
            const tool = ctx.activeTools.get(toolCallId);
            const toolName =
              tool?.toolName ?? (typeof event.toolName === "string" ? event.toolName : "tool");
            const isError = event.isError === true;
            const detail = extractToolTextResult(event.result) ?? tool?.lastDetail;
            ctx.activeTools.delete(toolCallId);
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                itemId: toolCallId,
                raw: event,
                method: type,
              })),
              type: "item.completed",
              payload: {
                itemType: toolItemType(toolName),
                status: isError ? "failed" : "completed",
                title: toolTitle(toolName),
                ...(detail ? { detail } : {}),
              },
            });
            break;
          }
          case "compaction_start": {
            const itemId = `pi-compact-${yield* randomUUIDv4}`;
            ctx.activeCompactionItemId = itemId;
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                itemId,
                raw: event,
                method: type,
              })),
              type: "item.started",
              payload: {
                itemType: "context_compaction",
                status: "inProgress",
                title: "Compacting context",
                detail: typeof event.reason === "string" ? event.reason : undefined,
              },
            });
            break;
          }
          case "compaction_end": {
            const aborted = event.aborted === true;
            const failed =
              !aborted && event.result == null && typeof event.errorMessage === "string";
            const compactionItemId = ctx.activeCompactionItemId;
            ctx.activeCompactionItemId = undefined;
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                ...(compactionItemId ? { itemId: compactionItemId } : {}),
                raw: event,
                method: type,
              })),
              type: "item.completed",
              payload: {
                itemType: "context_compaction",
                status: aborted || failed ? "failed" : "completed",
                title: "Compacting context",
                detail:
                  typeof event.errorMessage === "string"
                    ? event.errorMessage
                    : boundText(event.result),
              },
            });
            break;
          }
          case "auto_retry_start": {
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                raw: event,
                method: type,
              })),
              type: "runtime.warning",
              payload: {
                message:
                  typeof event.errorMessage === "string"
                    ? `Retrying after provider error (attempt ${String(event.attempt)}/${String(event.maxAttempts)}): ${event.errorMessage}`
                    : `Retrying provider request (attempt ${String(event.attempt)}).`,
              },
            });
            break;
          }
          case "auto_retry_end": {
            if (event.success === false && turnId && ctx.activeTurnId === turnId) {
              const message =
                typeof event.finalError === "string"
                  ? event.finalError
                  : "Pi automatic retry exhausted.";
              const classification = classifyPiTurnFailure(message);
              clearTurnLocalState(ctx);
              ctx.session = {
                ...ctx.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: yield* nowIso,
                lastError: message,
              };
              yield* publishRuntime({
                ...(yield* buildEventBase({
                  threadId: ctx.threadId,
                  turnId,
                  raw: event,
                  method: type,
                })),
                type: "turn.completed",
                payload: {
                  state: classification.state,
                  stopReason: classification.stopReason,
                  errorMessage: message,
                },
              });
            }
            break;
          }
          case "extension_error": {
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                raw: event,
                method: type,
              })),
              type: "runtime.error",
              payload: {
                message:
                  typeof event.error === "string"
                    ? `Pi extension error: ${event.error}`
                    : "Pi extension error",
                class: "provider_error",
              },
            });
            break;
          }
          case "agent_end": {
            // message_update error may have already completed the turn.
            if (!turnId || ctx.activeTurnId !== turnId) break;
            clearTurnLocalState(ctx);
            ctx.session = {
              ...ctx.session,
              status: "ready",
              activeTurnId: undefined,
              updatedAt: yield* nowIso,
            };
            yield* publishRuntime({
              ...(yield* buildEventBase({
                threadId: ctx.threadId,
                turnId,
                raw: event,
                method: type,
              })),
              type: "turn.completed",
              payload: {
                state: "completed",
              },
            });
            break;
          }
          default:
            break;
        }
      });

    const warnUnsupportedExtensionMethod = (ctx: PiSessionContext, method: string) =>
      Effect.gen(function* () {
        if (ctx.unsupportedExtensionMethods.has(method)) {
          return;
        }
        ctx.unsupportedExtensionMethods.add(method);
        yield* publishRuntime({
          ...(yield* buildEventBase({
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            method: `extension/${method}`,
          })),
          type: "runtime.warning",
          payload: {
            message: `Pi extension UI API '${method}' is not supported in T3 yet.`,
            detail: { method },
          },
        });
      }).pipe(Effect.ignore);

    const ensureExtensionLimitedBridgeWarning = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.extensionLimitedBridgeWarned) {
          return;
        }
        ctx.extensionLimitedBridgeWarned = true;
        yield* publishRuntime({
          ...(yield* buildEventBase({ threadId: ctx.threadId })),
          type: "runtime.warning",
          payload: { message: PI_EXTENSION_LIMITED_BRIDGE_MESSAGE },
        });
      }).pipe(Effect.ignore);

    const handleExtensionUi = (
      ctx: PiSessionContext,
      event: Record<string, unknown> & { id: string; method: string },
    ) =>
      Effect.gen(function* () {
        const method = event.method;
        if (
          method === "notify" ||
          method === "setStatus" ||
          method === "setWidget" ||
          method === "setTitle" ||
          method === "set_editor_text"
        ) {
          if (method === "notify" && typeof event.message === "string" && event.message.trim()) {
            const notifyType = typeof event.notifyType === "string" ? event.notifyType : "info";
            if (notifyType === "warning" || notifyType === "error") {
              yield* publishRuntime({
                ...(yield* buildEventBase({
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  raw: event,
                  method,
                })),
                type: "runtime.warning",
                payload: {
                  message: event.message.trim(),
                  detail: { type: notifyType },
                },
              });
            } else {
              yield* publishRuntime({
                ...(yield* buildEventBase({
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  raw: event,
                  method,
                })),
                type: "tool.progress",
                payload: {
                  toolName: "Pi plugin",
                  summary: event.message.trim(),
                },
              });
            }
          } else if (method === "setStatus") {
            const statusText = typeof event.statusText === "string" ? event.statusText.trim() : "";
            if (statusText) {
              yield* publishRuntime({
                ...(yield* buildEventBase({
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  raw: event,
                  method,
                })),
                type: "tool.progress",
                payload: {
                  toolName: "Pi plugin",
                  summary: statusText,
                },
              });
            }
          } else if (
            method === "setWidget" ||
            method === "setTitle" ||
            method === "set_editor_text"
          ) {
            yield* warnUnsupportedExtensionMethod(ctx, method);
          }
          return;
        }

        yield* ensureExtensionLimitedBridgeWarning(ctx);

        if (method === "confirm") {
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          ctx.pendingConfirms.set(requestId, {
            nativeId: event.id,
            requestType: "unknown",
          });
          const title = typeof event.title === "string" ? event.title : "Confirm";
          const message = typeof event.message === "string" ? event.message : title;
          yield* publishRuntime({
            ...(yield* buildEventBase({
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              requestId,
              raw: event,
              method,
            })),
            type: "request.opened",
            payload: {
              requestType: "unknown",
              detail: `${title}\n${message}`.trim(),
              args: event,
            },
          });
          return;
        }

        if (method === "select" || method === "input" || method === "editor") {
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const options =
            method === "select" && Array.isArray(event.options)
              ? event.options.filter(
                  (o): o is string => typeof o === "string" && o.trim().length > 0,
                )
              : [];
          ctx.pendingUserInputs.set(requestId, {
            nativeId: event.id,
            method,
            options,
          });
          const title =
            typeof event.title === "string" && event.title.trim()
              ? event.title.trim()
              : method === "select"
                ? "Select an option"
                : "Input required";
          yield* publishRuntime({
            ...(yield* buildEventBase({
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              requestId,
              raw: event,
              method,
            })),
            type: "user-input.requested",
            payload: {
              questions: [
                {
                  id: "value",
                  header: title,
                  question:
                    method === "editor" && typeof event.prefill === "string"
                      ? event.prefill
                      : typeof event.placeholder === "string"
                        ? event.placeholder
                        : title,
                  options: options.map((label) => ({ label, description: label })),
                  multiSelect: false,
                },
              ],
            },
          });
        }
      });

    const startEventPump = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const generation = ctx.generation;
        ctx.eventFiber = yield* Stream.runForEach(ctx.runtime.events, (event) =>
          Effect.gen(function* () {
            if (ctx.stopped || ctx.generation !== generation) {
              return;
            }
            yield* handleNativeEvent(ctx, event);
          }),
        ).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(ctx.scope),
        );
      });

    const resolveImages = (
      attachments:
        | ReadonlyArray<{ type: string; id?: string; name?: string; path?: string }>
        | undefined,
    ) =>
      Effect.gen(function* () {
        if (!attachments || attachments.length === 0) {
          return [] as Array<{ type: "image"; data: string; mimeType: string }>;
        }
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        for (const attachment of attachments) {
          if (attachment.type !== "image") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Pi only supports image attachments (received '${attachment.type}').`,
            });
          }
          const resolved = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: attachment as never,
          });
          if (!resolved) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Unable to resolve image attachment path.",
            });
          }
          const bytes = yield* fs.readFile(resolved).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "attachments/read",
                  detail: "Failed to read image attachment.",
                  cause,
                }),
            ),
          );
          if (bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Image attachment exceeds ${MAX_IMAGE_ATTACHMENT_BYTES} bytes.`,
            });
          }
          const ext = path.extname(resolved).toLowerCase();
          const mimeType =
            ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : ext === ".webp"
                ? "image/webp"
                : ext === ".gif"
                  ? "image/gif"
                  : "image/png";
          images.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType,
          });
        }
        return images;
      });

    const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        yield* assertFullAccessRuntimeMode(input.runtimeMode, "startSession");
        if (input.approvalPolicy !== undefined || input.sandboxMode !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Pi does not support explicit approvalPolicy/sandboxMode. Use full-access only.",
          });
        }

        const cwd = input.cwd?.trim();
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Pi sessions require a working directory (cwd).",
          });
        }

        // Replace any existing session for this thread.
        yield* SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
          Effect.gen(function* () {
            const existing = sessions.get(input.threadId);
            if (existing) {
              yield* stopContext(existing, "Replaced by a new Pi session.", false);
              const next = new Map(sessions);
              next.delete(input.threadId);
              return next;
            }
            return sessions;
          }),
        );

        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const parsedModel = parsePiModelSlug(modelSelection?.model);
        const thinkingRaw = getModelSelectionStringOptionValue(modelSelection, "thinkingLevel");
        const thinkingLevel =
          thinkingRaw && isPiThinkingLevel(thinkingRaw) ? thinkingRaw : undefined;

        const resume = input.resumeCursor
          ? yield* parseResumeCursor(input.resumeCursor, nonEmpty(piSettings.sessionDir))
          : undefined;

        const environment = buildPiEnvironment(piSettings, processEnv);
        const sessionScope = yield* Scope.make();

        let sessionId: string | undefined;
        let sessionPath: string | undefined;
        if (resume) {
          sessionPath = resume.sessionPath;
        } else {
          sessionId =
            preferPiSessionIdFromThreadId(String(input.threadId)) ??
            `t3-${(yield* randomUUIDv4).replaceAll("-", "").slice(0, 24)}`;
          if (!isValidPiSessionId(sessionId)) {
            sessionId = `t3${sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 30) || "session"}`;
          }
        }

        const spawn: PiSpawnArgs = {
          binaryPath: piSettings.binaryPath || "pi",
          cwd: resume?.cwd ?? cwd,
          environment,
          projectTrust: piSettings.projectTrust,
          ...(nonEmpty(piSettings.sessionDir)
            ? { sessionDir: nonEmpty(piSettings.sessionDir) }
            : {}),
          ...(sessionPath ? { sessionPath } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(parsedModel ? { provider: parsedModel.provider, model: parsedModel.modelId } : {}),
        };

        const runtime = yield* makeRuntime({
          spawn,
          ...(resume
            ? {
                expectedSessionId: resume.sessionId,
                expectedSessionPath: resume.sessionPath,
              }
            : {}),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Scope.Scope, sessionScope),
        );

        const state = yield* runtime.start().pipe(
          Effect.mapError((error) => mapPiRuntimeError(error, "startSession", input.threadId)),
          Effect.tapError(() => runtime.close.pipe(Effect.ignore)),
        );

        if (thinkingLevel) {
          yield* runtime.setThinkingLevel(thinkingLevel).pipe(
            Effect.mapError((error) => mapPiRuntimeError(error, "startSession", input.threadId)),
            Effect.ignore,
          );
        }

        const resumeCursor = yield* runtime
          .buildResumeCursor()
          .pipe(
            Effect.mapError((error) => mapPiRuntimeError(error, "startSession", input.threadId)),
          );

        const createdAt = yield* nowIso;
        const modelSlug =
          modelSelection?.model ??
          (state.model &&
          typeof state.model === "object" &&
          typeof (state.model as { provider?: unknown }).provider === "string" &&
          typeof (state.model as { id?: unknown }).id === "string"
            ? encodePiModelSlug(
                (state.model as { provider: string }).provider,
                (state.model as { id: string }).id,
              )
            : undefined);

        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: spawn.cwd,
          ...(modelSlug ? { model: modelSlug } : {}),
          threadId: input.threadId,
          resumeCursor,
          createdAt,
          updatedAt: createdAt,
        };

        const context: PiSessionContext = {
          threadId: input.threadId,
          session,
          scope: sessionScope,
          runtime,
          eventFiber: undefined,
          pendingConfirms: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          activeTurnId: undefined,
          activeMessage: undefined,
          activeTools: new Map(),
          activeCompactionItemId: undefined,
          unsupportedExtensionMethods: new Set(),
          extensionLimitedBridgeWarned: false,
          generation: 0,
          stopped: false,
        };

        yield* startEventPump(context);
        yield* SynchronizedRef.update(sessionsRef, (sessions) => {
          const next = new Map(sessions);
          next.set(input.threadId, context);
          return next;
        });

        yield* publishRuntime({
          ...(yield* buildEventBase({ threadId: input.threadId, raw: state, method: "get_state" })),
          type: "session.started",
          payload: {
            message: resume ? "Pi session resumed" : "Pi session started",
            resume: resumeCursor,
          },
        });
        yield* publishRuntime({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: state.sessionId,
          },
        });
        // Project-local extensions may load under full-access; warn once that TUI-only
        // extension UI methods are not bridged.
        if (!context.extensionLimitedBridgeWarned && piSettings.projectTrust === "approve") {
          context.extensionLimitedBridgeWarned = true;
          yield* publishRuntime({
            ...(yield* buildEventBase({ threadId: input.threadId })),
            type: "runtime.warning",
            payload: { message: PI_EXTENSION_LIMITED_BRIDGE_MESSAGE },
          });
        }

        return session;
      },
    );

    const ensureSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const sessions = yield* SynchronizedRef.get(sessionsRef);
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return ctx;
      });

    /**
     * Apply in-session model and/or thinking changes on an idle Pi process.
     * Verifies with get_state after successful RPC commands.
     */
    const applyIdleModelSelection = (input: {
      readonly ctx: PiSessionContext;
      readonly operation: string;
      readonly modelSelection:
        | {
            readonly instanceId: ProviderInstanceId;
            readonly model: string;
            readonly options?: ReadonlyArray<{ id: string; value: string | boolean }>;
          }
        | undefined;
    }) =>
      Effect.gen(function* () {
        const { ctx, modelSelection, operation } = input;
        if (!modelSelection || modelSelection.instanceId !== boundInstanceId) {
          return;
        }
        if (ctx.activeTurnId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "set_model",
            detail: "Cannot change Pi model or thinking while a turn is active.",
          });
        }

        const parsed = parsePiModelSlug(modelSelection.model);
        if (!parsed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: "Pi model selection must use the 'provider/modelId' format.",
          });
        }

        let modelChanged = false;
        if (modelSelection.model !== ctx.session.model) {
          yield* ctx.runtime
            .setModel(parsed.provider, parsed.modelId)
            .pipe(Effect.mapError((error) => mapPiRuntimeError(error, operation, ctx.threadId)));
          modelChanged = true;
        }

        const thinkingRaw = getModelSelectionStringOptionValue(modelSelection, "thinkingLevel");
        // When the model changed, clamp thinking against the new model's reported
        // state after set_model; otherwise apply the requested level if valid.
        if (thinkingRaw !== undefined || modelChanged) {
          const state = yield* ctx.runtime
            .getState()
            .pipe(Effect.mapError((error) => mapPiRuntimeError(error, operation, ctx.threadId)));
          const stateModel =
            state.model && typeof state.model === "object"
              ? (state.model as { reasoning?: unknown; thinkingLevelMap?: unknown })
              : { reasoning: true };
          const effectiveThinking = clampPiThinkingLevel(
            stateModel,
            typeof thinkingRaw === "string" ? thinkingRaw : undefined,
          );
          if (effectiveThinking) {
            yield* ctx.runtime
              .setThinkingLevel(effectiveThinking)
              .pipe(Effect.mapError((error) => mapPiRuntimeError(error, operation, ctx.threadId)));
          }
        }

        if (modelChanged) {
          ctx.session = {
            ...ctx.session,
            model: modelSelection.model,
            updatedAt: yield* nowIso,
          };
        }
      });

    const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const ctx = yield* ensureSession(input.threadId);
      if (ctx.activeTurnId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: "Pi session is busy with an active turn. Wait for completion or interrupt.",
        });
      }

      const text = input.input?.trim() ?? "";
      const images = yield* resolveImages(input.attachments as never);
      if (!text && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text input or at least one image attachment.",
        });
      }

      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      yield* applyIdleModelSelection({
        ctx,
        operation: "sendTurn",
        modelSelection,
      });

      const turnId = TurnId.make(`pi-turn-${yield* randomUUIDv4}`);
      ctx.activeTurnId = turnId;
      ctx.activeMessage = undefined;
      ctx.activeTools.clear();
      ctx.session = {
        ...ctx.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
        lastError: undefined,
      };
      ctx.turns = [...ctx.turns, { id: turnId, items: [] }];

      yield* publishRuntime({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {
          model: ctx.session.model,
        },
      });

      yield* ctx.runtime
        .prompt({
          message: text || " ",
          ...(images.length > 0 ? { images } : {}),
        })
        .pipe(
          Effect.mapError((error) => mapPiRuntimeError(error, "sendTurn", input.threadId)),
          Effect.tapError((requestError) =>
            Effect.gen(function* () {
              ctx.activeTurnId = undefined;
              ctx.session = {
                ...ctx.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: yield* nowIso,
                lastError: requestError.message,
              };
              yield* publishRuntime({
                ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: requestError.message,
                },
              });
            }),
          ),
        );

      const resumeCursorOption = yield* ctx.runtime.buildResumeCursor().pipe(Effect.option);
      if (Option.isSome(resumeCursorOption)) {
        ctx.session = { ...ctx.session, resumeCursor: resumeCursorOption.value };
      }

      return {
        threadId: input.threadId,
        turnId,
        ...(Option.isSome(resumeCursorOption) ? { resumeCursor: resumeCursorOption.value } : {}),
      };
    });

    const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const ctx = yield* ensureSession(threadId);
        yield* ctx.runtime
          .abort()
          .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "interruptTurn", threadId)));
        const active = turnId ?? ctx.activeTurnId;
        if (active) {
          ctx.activeTurnId = undefined;
          ctx.session = {
            ...ctx.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
          };
          yield* publishRuntime({
            ...(yield* buildEventBase({ threadId, turnId: active })),
            type: "turn.completed",
            payload: {
              state: "interrupted",
              errorMessage: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
      function* (threadId, requestId, decision: ProviderApprovalDecision) {
        const ctx = yield* ensureSession(threadId);
        const pending = ctx.pendingConfirms.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending Pi confirmation request: ${requestId}`,
          });
        }
        ctx.pendingConfirms.delete(requestId);
        const body =
          decision === "cancel"
            ? { type: "extension_ui_response", id: pending.nativeId, cancelled: true as const }
            : {
                type: "extension_ui_response",
                id: pending.nativeId,
                confirmed: decision === "accept" || decision === "acceptForSession",
              };
        yield* ctx.runtime
          .respondExtensionUi(body)
          .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "respondToRequest", threadId)));
        yield* publishRuntime({
          ...(yield* buildEventBase({ threadId, turnId: ctx.activeTurnId, requestId })),
          type: "request.resolved",
          payload: {
            requestType: pending.requestType,
            decision,
          },
        });
      },
    );

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers: ProviderUserInputAnswers) {
      const ctx = yield* ensureSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending Pi user-input request: ${requestId}`,
        });
      }
      ctx.pendingUserInputs.delete(requestId);

      const raw = answers.value ?? answers["value"];
      const value = Array.isArray(raw) ? raw[0] : raw;

      let body: Record<string, unknown>;
      if (value === undefined || value === null || value === "") {
        body = { type: "extension_ui_response", id: pending.nativeId, cancelled: true };
      } else if (pending.method === "select") {
        const selected = String(value);
        if (pending.options.length > 0 && !pending.options.includes(selected)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: `Selected option '${selected}' is not in the original Pi option set.`,
          });
        }
        body = { type: "extension_ui_response", id: pending.nativeId, value: selected };
      } else {
        body = { type: "extension_ui_response", id: pending.nativeId, value: String(value) };
      }

      yield* ctx.runtime
        .respondExtensionUi(body)
        .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "respondToUserInput", threadId)));
      yield* publishRuntime({
        ...(yield* buildEventBase({ threadId, turnId: ctx.activeTurnId, requestId })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

    const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        yield* SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
          Effect.gen(function* () {
            const ctx = sessions.get(threadId);
            if (!ctx) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              });
            }
            if (ctx.activeTurnId) {
              yield* ctx.runtime.abort().pipe(Effect.ignore);
            }
            yield* stopContext(ctx, "Session stopped.", false);
            const next = new Map(sessions);
            next.delete(threadId);
            return next;
          }),
        );
      },
    );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      SynchronizedRef.get(sessionsRef).pipe(
        Effect.map((sessions) =>
          Array.from(sessions.values())
            .filter((ctx) => !ctx.stopped)
            .map((ctx) => ctx.session),
        ),
      );

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      SynchronizedRef.get(sessionsRef).pipe(
        Effect.map((sessions) => {
          const ctx = sessions.get(threadId);
          return Boolean(ctx && !ctx.stopped);
        }),
      );

    const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
      const ctx = yield* ensureSession(threadId);
      const messages = yield* ctx.runtime
        .getMessages()
        .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "readThread", threadId)));
      // Best-effort: map messages into turn snapshots without inventing Pi history rewrites.
      return {
        threadId,
        turns:
          ctx.turns.length > 0
            ? ctx.turns.map((turn) => ({ id: turn.id, items: turn.items }))
            : messages.map((_, index) => ({
                id: TurnId.make(`pi-read-${index}`),
                items: [messages[index]],
              })),
      };
    });

    const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const ctx = yield* ensureSession(threadId);
        if (ctx.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Cannot roll back while a Pi turn is active.",
          });
        }
        if (ctx.pendingConfirms.size > 0 || ctx.pendingUserInputs.size > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Cannot roll back while a Pi extension UI request is pending.",
          });
        }
        if (numTurns <= 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be positive.",
          });
        }

        const forkMessages = yield* ctx.runtime
          .getForkMessages()
          .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "rollbackThread", threadId)));
        if (forkMessages.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "No Pi user messages available to fork/roll back.",
          });
        }
        const target = forkMessages[Math.max(0, forkMessages.length - numTurns)];
        if (!target) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Unable to locate a Pi fork entry for the requested turn count.",
          });
        }
        const forkResult = yield* ctx.runtime
          .fork(target.entryId)
          .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "rollbackThread", threadId)));
        if (forkResult.cancelled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Pi fork was cancelled by an extension.",
          });
        }

        // After fork, Pi switches the active session — refresh resume cursor.
        const state = yield* ctx.runtime
          .getState()
          .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "rollbackThread", threadId)));
        const resumeCursor = yield* ctx.runtime
          .buildResumeCursor()
          .pipe(Effect.mapError((error) => mapPiRuntimeError(error, "rollbackThread", threadId)));
        ctx.session = {
          ...ctx.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
        // Drop local turn history past the fork point (best-effort).
        if (ctx.turns.length >= numTurns) {
          ctx.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
        }

        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
          // expose state session id in items via empty structure already
          ...(state ? {} : {}),
        };
      },
    );

    const stopAll: PiAdapterShape["stopAll"] = Effect.fn("stopAll")(function* () {
      yield* SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from(sessions.values()),
            (ctx) => stopContext(ctx, "Adapter stopAll.", false),
            { concurrency: 4, discard: true },
          );
          return new Map();
        }),
      );
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* stopAll().pipe(Effect.ignore);
        if (managedNativeEventLogger) {
          yield* managedNativeEventLogger.close().pipe(Effect.ignore);
        }
      }),
    );

    const adapter: PiAdapterShape = {
      provider: PROVIDER,
      // Idle sessions apply model/thinking via set_model / set_thinking_level on the
      // same RPC process (verified with get_state). Busy turns reject changes.
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    };

    return adapter;
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

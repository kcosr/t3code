/**
 * PiSessionRuntime — one stock `pi --mode rpc` process for one active T3 thread.
 *
 * Owns JSONL framing, command correlation, readiness, abort, and shutdown.
 * Canonical event mapping lives in PiAdapter.
 *
 * @module PiSessionRuntime
 */

import type { PiSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";
import { JsonlDecoder, JsonlProtocolError, serializeJsonLine } from "../pi/jsonl.ts";
import {
  isPiResponseEnvelope,
  type PiResumeCursor,
  type PiSessionState,
  PiSessionStateSchema,
} from "../pi/protocol.ts";
import type { PiThinkingLevel } from "../pi/modelSlug.ts";

const textEncoder = new TextEncoder();
const DEFAULT_COMMAND_TIMEOUT = Duration.seconds(60);
const READINESS_TIMEOUT = Duration.seconds(20);
const GRACEFUL_EXIT_WAIT = "2 seconds" as const;
const FORCE_KILL_WAIT = "1 second" as const;
const MAX_STDERR_TAIL = 8_000;

const decodePiSessionState = Schema.decodeUnknownEffect(PiSessionStateSchema);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

export type PiRuntimeNativeEvent = Record<string, unknown> & { readonly type: string };

export type PiSessionRuntimeError =
  | PiSessionRuntimeSpawnError
  | PiSessionRuntimeProtocolError
  | PiSessionRuntimeCommandError
  | PiSessionRuntimeTimeoutError
  | PiSessionRuntimeExitedError
  | PiSessionRuntimeClosedError
  | PiSessionRuntimeStateError;

export class PiSessionRuntimeSpawnError extends Schema.TaggedErrorClass<PiSessionRuntimeSpawnError>()(
  "PiSessionRuntimeSpawnError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PiSessionRuntimeProtocolError extends Schema.TaggedErrorClass<PiSessionRuntimeProtocolError>()(
  "PiSessionRuntimeProtocolError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PiSessionRuntimeCommandError extends Schema.TaggedErrorClass<PiSessionRuntimeCommandError>()(
  "PiSessionRuntimeCommandError",
  {
    command: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Pi RPC command '${this.command}' failed: ${this.detail}`;
  }
}

export class PiSessionRuntimeTimeoutError extends Schema.TaggedErrorClass<PiSessionRuntimeTimeoutError>()(
  "PiSessionRuntimeTimeoutError",
  {
    command: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Pi RPC command '${this.command}' timed out after ${this.timeoutMs}ms`;
  }
}

export class PiSessionRuntimeExitedError extends Schema.TaggedErrorClass<PiSessionRuntimeExitedError>()(
  "PiSessionRuntimeExitedError",
  {
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    signal: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PiSessionRuntimeClosedError extends Schema.TaggedErrorClass<PiSessionRuntimeClosedError>()(
  "PiSessionRuntimeClosedError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PiSessionRuntimeStateError extends Schema.TaggedErrorClass<PiSessionRuntimeStateError>()(
  "PiSessionRuntimeStateError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface PiSpawnArgs {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionId?: string | undefined;
  readonly sessionPath?: string | undefined;
  readonly sessionDir?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly projectTrust?: PiSettings["projectTrust"] | undefined;
  readonly noSession?: boolean | undefined;
  readonly noTools?: boolean | undefined;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
}

export interface PiSessionRuntimeOptions {
  readonly spawn: PiSpawnArgs;
  readonly expectedSessionId?: string;
  readonly expectedSessionPath?: string;
}

export interface PiSessionRuntimeShape {
  readonly pid: number | undefined;
  readonly start: () => Effect.Effect<PiSessionState, PiSessionRuntimeError>;
  readonly getState: () => Effect.Effect<PiSessionState, PiSessionRuntimeError>;
  readonly prompt: (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
  }) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly abort: () => Effect.Effect<void, PiSessionRuntimeError>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly getAvailableModels: () => Effect.Effect<
    ReadonlyArray<Record<string, unknown>>,
    PiSessionRuntimeError
  >;
  readonly getMessages: () => Effect.Effect<ReadonlyArray<unknown>, PiSessionRuntimeError>;
  readonly getEntries: () => Effect.Effect<
    { readonly entries: ReadonlyArray<Record<string, unknown>>; readonly leafId: string | null },
    PiSessionRuntimeError
  >;
  readonly getForkMessages: () => Effect.Effect<
    ReadonlyArray<{ readonly entryId: string; readonly text: string }>,
    PiSessionRuntimeError
  >;
  readonly fork: (
    entryId: string,
  ) => Effect.Effect<{ readonly text: string; readonly cancelled: boolean }, PiSessionRuntimeError>;
  readonly respondExtensionUi: (
    response: Record<string, unknown>,
  ) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly command: (
    body: Record<string, unknown>,
    timeout?: Duration.Input,
  ) => Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly events: Stream.Stream<PiRuntimeNativeEvent, never>;
  readonly close: Effect.Effect<void>;
  readonly buildResumeCursor: () => Effect.Effect<PiResumeCursor, PiSessionRuntimeError>;
}

interface PendingCommand {
  readonly command: string;
  readonly deferred: Deferred.Deferred<
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false; readonly error: string },
    never
  >;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function buildPiEnvironment(
  settings: Pick<PiSettings, "agentDir" | "sessionDir">,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PI_OFFLINE: baseEnv.PI_OFFLINE ?? "1",
    PI_SKIP_VERSION_CHECK: baseEnv.PI_SKIP_VERSION_CHECK ?? "1",
    PI_TELEMETRY: baseEnv.PI_TELEMETRY ?? "0",
  };
  const agentDir = nonEmpty(settings.agentDir);
  if (agentDir) {
    env.PI_CODING_AGENT_DIR = expandHomePath(agentDir);
  }
  const sessionDir = nonEmpty(settings.sessionDir);
  if (sessionDir) {
    env.PI_CODING_AGENT_SESSION_DIR = expandHomePath(sessionDir);
  }
  return env;
}

export function buildPiRpcArgv(spawn: PiSpawnArgs): string[] {
  const args = ["--mode", "rpc"];
  if (spawn.noSession) {
    args.push("--no-session");
  }
  if (spawn.noTools) {
    args.push("--no-tools");
  }
  if (spawn.sessionPath) {
    args.push("--session", spawn.sessionPath);
  } else if (spawn.sessionId) {
    args.push("--session-id", spawn.sessionId);
  }
  const sessionDir = nonEmpty(spawn.sessionDir);
  if (sessionDir) {
    args.push("--session-dir", expandHomePath(sessionDir));
  }
  if (spawn.provider) {
    args.push("--provider", spawn.provider);
  }
  if (spawn.model) {
    args.push("--model", spawn.model);
  }
  if (spawn.projectTrust === "approve") {
    args.push("--approve");
  } else if (spawn.projectTrust === "deny") {
    args.push("--no-approve");
  }
  if (spawn.extraArgs) {
    args.push(...spawn.extraArgs);
  }
  return args;
}

// HostProcessPlatform is a Context.Reference with a defaultValue, so it does
// not need to appear in the explicit R channel.
export type PiSessionRuntimeEnv = ChildProcessSpawner.ChildProcessSpawner | Scope.Scope;

export function makePiSessionRuntime(
  options: PiSessionRuntimeOptions,
): Effect.Effect<PiSessionRuntimeShape, never, PiSessionRuntimeEnv> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<PiRuntimeNativeEvent>();
    const pendingRef = yield* Ref.make(new Map<string, PendingCommand>());
    const closedRef = yield* Ref.make(false);
    const stateRef = yield* Ref.make<PiSessionState | undefined>(undefined);
    const stderrTailRef = yield* Ref.make("");
    const exitErrorRef = yield* Ref.make<PiSessionRuntimeExitedError | undefined>(undefined);
    const nextIdRef = yield* Ref.make(1);
    const writeMutex = yield* Semaphore.make(1);
    const jsonl = new JsonlDecoder();
    // Long-lived stdin writer. Stream.run(handle.stdin) ends the Node writable when
    // the stream completes (endOnDone defaults true), so per-command Stream.succeed
    // writes close stdin after the first RPC request and Pi exits before follow-ups
    // (e.g. get_available_models after get_state). Pipe a single queue stream instead.
    const stdinQueue = yield* Queue.unbounded<Uint8Array>();

    let handle: ChildProcessSpawner.ChildProcessHandle | undefined;
    let stdoutFiber: Fiber.Fiber<void, never> | undefined;
    let stderrFiber: Fiber.Fiber<void, never> | undefined;
    let exitFiber: Fiber.Fiber<void, never> | undefined;
    let stdinFiber: Fiber.Fiber<void, never> | undefined;

    const failAllPending = (error: PiSessionRuntimeError) =>
      Effect.gen(function* () {
        const pending = yield* Ref.getAndSet(pendingRef, new Map());
        yield* Effect.forEach(
          Array.from(pending.values()),
          (entry) =>
            Deferred.succeed(entry.deferred, {
              success: false as const,
              error: error.message,
            }).pipe(Effect.ignore),
          { discard: true },
        );
      });

    const appendStderr = (chunk: string) =>
      Ref.update(stderrTailRef, (prev) => {
        const next = `${prev}${chunk}`;
        return next.length > MAX_STDERR_TAIL ? next.slice(next.length - MAX_STDERR_TAIL) : next;
      });

    const writeLine = (value: unknown) =>
      writeMutex.withPermits(1)(
        Effect.gen(function* () {
          if (!handle || !stdinFiber) {
            return yield* new PiSessionRuntimeClosedError({
              detail: "Pi RPC process is not running.",
            });
          }
          const closed = yield* Ref.get(closedRef);
          if (closed) {
            return yield* new PiSessionRuntimeClosedError({
              detail: "Pi RPC process is closed.",
            });
          }
          const payload = textEncoder.encode(serializeJsonLine(value));
          yield* Queue.offer(stdinQueue, payload).pipe(
            Effect.mapError(
              (cause) =>
                new PiSessionRuntimeProtocolError({
                  detail: "Failed to write to Pi RPC stdin.",
                  cause,
                }),
            ),
          );
        }),
      );

    const handleLine = (line: string) =>
      Effect.gen(function* () {
        const parsedResult = Effect.try({
          try: () => decodeUnknownJson(line),
          catch: (cause) =>
            new PiSessionRuntimeProtocolError({
              detail: `Malformed Pi RPC JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        });
        const parsed = yield* parsedResult.pipe(
          Effect.tapError((error) =>
            failAllPending(error).pipe(Effect.andThen(Ref.set(closedRef, true))),
          ),
        );

        if (isPiResponseEnvelope(parsed)) {
          const id = typeof parsed.id === "string" ? parsed.id : undefined;
          if (!id) {
            // Unsolicited response without id — ignore after validation.
            return;
          }
          const pending = yield* Ref.get(pendingRef);
          const entry = pending.get(id);
          if (!entry) {
            // Unknown response id — log-free ignore (spec).
            return;
          }
          const next = new Map(pending);
          next.delete(id);
          yield* Ref.set(pendingRef, next);
          if (parsed.success) {
            yield* Deferred.succeed(entry.deferred, {
              success: true as const,
              data: parsed.data,
            });
          } else {
            yield* Deferred.succeed(entry.deferred, {
              success: false as const,
              error: parsed.error ?? "Pi RPC command failed",
            });
          }
          return;
        }

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { type?: unknown }).type === "string"
        ) {
          yield* Queue.offer(eventQueue, parsed as PiRuntimeNativeEvent);
        } else {
          yield* failAllPending(
            new PiSessionRuntimeProtocolError({
              detail: "Pi RPC produced an invalid top-level message shape.",
            }),
          );
          yield* Ref.set(closedRef, true);
        }
      });

    const command = (
      body: Record<string, unknown>,
      timeout: Duration.Input = DEFAULT_COMMAND_TIMEOUT,
    ) =>
      Effect.gen(function* () {
        const closed = yield* Ref.get(closedRef);
        if (closed || !handle) {
          const exitError = yield* Ref.get(exitErrorRef);
          if (exitError) {
            return yield* exitError;
          }
          return yield* new PiSessionRuntimeClosedError({
            detail: "Pi RPC process is not running.",
          });
        }
        const commandType = typeof body.type === "string" ? body.type : "unknown";
        if ("id" in body) {
          return yield* new PiSessionRuntimeCommandError({
            command: commandType,
            detail: "Command id is assigned by PiSessionRuntime.",
          });
        }
        const seq = yield* Ref.updateAndGet(nextIdRef, (n) => n + 1);
        const id = `pi-${seq}`;
        const deferred = yield* Deferred.make<
          | { readonly success: true; readonly data: unknown }
          | { readonly success: false; readonly error: string }
        >();
        yield* Ref.update(pendingRef, (map) => {
          const next = new Map(map);
          next.set(id, { command: commandType, deferred });
          return next;
        });
        yield* writeLine({ ...body, id });
        const timeoutDuration = Duration.fromInputUnsafe(timeout);
        const timeoutMs = Duration.toMillis(timeoutDuration);
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(timeoutDuration),
          Effect.flatMap((option) => {
            if (Option.isNone(option)) {
              return Ref.update(pendingRef, (map) => {
                const next = new Map(map);
                next.delete(id);
                return next;
              }).pipe(
                Effect.andThen(
                  new PiSessionRuntimeTimeoutError({
                    command: commandType,
                    timeoutMs,
                  }),
                ),
              );
            }
            return Effect.succeed(option.value);
          }),
        );
        if (!result.success) {
          return yield* new PiSessionRuntimeCommandError({
            command: commandType,
            detail: result.error,
          });
        }
        return result.data;
      });

    const start = () =>
      Effect.gen(function* () {
        if (handle) {
          const existing = yield* Ref.get(stateRef);
          if (existing) {
            return existing;
          }
        }
        const argv = buildPiRpcArgv(options.spawn);
        // Pass argv as a vector (never shell-interpolated). On Unix, detach so
        // we can SIGTERM/SIGKILL the whole process group (Pi tool children).
        const child = yield* spawner
          .spawn(
            ChildProcess.make(options.spawn.binaryPath, argv, {
              cwd: options.spawn.cwd,
              env: options.spawn.environment,
              extendEnv: true,
              ...(hostPlatform === "win32" ? {} : { detached: true }),
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
            Effect.mapError(
              (cause) =>
                new PiSessionRuntimeSpawnError({
                  detail: `Failed to spawn Pi RPC process ('${options.spawn.binaryPath}').`,
                  cause,
                }),
            ),
          );
        handle = child;

        stdinFiber = yield* Stream.fromQueue(stdinQueue).pipe(
          Stream.run(child.stdin),
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(runtimeScope),
        );

        stdoutFiber = yield* Stream.runForEach(child.stdout, (chunk) =>
          Effect.gen(function* () {
            const linesResult = Effect.try({
              try: () => jsonl.push(chunk),
              catch: (error) => {
                const detail =
                  error instanceof JsonlProtocolError
                    ? error.message
                    : `Pi RPC framing error: ${String(error)}`;
                return new PiSessionRuntimeProtocolError({ detail, cause: error });
              },
            });
            const lines = yield* linesResult.pipe(
              Effect.tapError((error) =>
                failAllPending(error).pipe(Effect.andThen(Ref.set(closedRef, true))),
              ),
              Effect.catch(() => Effect.succeed([] as string[])),
            );
            yield* Effect.forEach(lines, handleLine, { discard: true });
          }),
        ).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(runtimeScope),
        );

        stderrFiber = yield* Stream.runForEach(child.stderr, (chunk) =>
          appendStderr(Buffer.from(chunk).toString("utf8")),
        ).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(runtimeScope),
        );

        exitFiber = yield* child.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              const stderrTail = yield* Ref.get(stderrTailRef);
              const detail = `Pi RPC process exited with code ${Number(code)}${
                stderrTail ? `: ${stderrTail.slice(-500)}` : ""
              }`;
              const error = new PiSessionRuntimeExitedError({
                detail,
                exitCode: Number(code),
              });
              yield* Ref.set(exitErrorRef, error);
              yield* Ref.set(closedRef, true);
              yield* failAllPending(error);
              yield* Queue.offer(eventQueue, {
                type: "t3.pi.process_exit",
                exitCode: Number(code),
                detail,
              });
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const error = new PiSessionRuntimeExitedError({
                detail: `Pi RPC process terminated unexpectedly: ${String(cause)}`,
              });
              yield* Ref.set(exitErrorRef, error);
              yield* Ref.set(closedRef, true);
              yield* failAllPending(error);
            }),
          ),
          Effect.forkIn(runtimeScope),
        );

        const data = yield* command({ type: "get_state" }, READINESS_TIMEOUT);
        const stateResult = yield* decodePiSessionState(data).pipe(
          Effect.mapError(
            (cause) =>
              new PiSessionRuntimeStateError({
                detail: `Pi get_state returned an unexpected payload: ${String(cause)}`,
              }),
          ),
        );
        // Durable coding sessions must report a session id. Ephemeral
        // `--no-session` probes (model discovery / utility text gen) may not.
        if (!options.spawn.noSession && !stateResult.sessionId?.trim()) {
          return yield* new PiSessionRuntimeStateError({
            detail: "Pi get_state returned an empty session id.",
          });
        }
        if (
          options.expectedSessionId &&
          stateResult.sessionId &&
          stateResult.sessionId !== options.expectedSessionId
        ) {
          return yield* new PiSessionRuntimeStateError({
            detail: `Pi session id mismatch: expected '${options.expectedSessionId}', got '${stateResult.sessionId}'.`,
          });
        }
        if (
          options.expectedSessionPath &&
          stateResult.sessionFile &&
          stateResult.sessionFile !== options.expectedSessionPath
        ) {
          return yield* new PiSessionRuntimeStateError({
            detail: `Pi session path mismatch: expected '${options.expectedSessionPath}', got '${stateResult.sessionFile}'.`,
          });
        }
        yield* Ref.set(stateRef, stateResult);
        return stateResult;
      });

    const getState = () =>
      command({ type: "get_state" }, READINESS_TIMEOUT).pipe(
        Effect.flatMap((data) =>
          decodePiSessionState(data).pipe(
            Effect.mapError(
              (cause) =>
                new PiSessionRuntimeStateError({
                  detail: `Pi get_state returned an unexpected payload: ${String(cause)}`,
                }),
            ),
          ),
        ),
        Effect.tap((state) => Ref.set(stateRef, state)),
      );

    const killProcessTree = (signal: "SIGTERM" | "SIGKILL") =>
      Effect.gen(function* () {
        if (!handle) {
          return;
        }
        if (hostPlatform === "win32") {
          yield* handle
            .kill({ killSignal: signal, forceKillAfter: FORCE_KILL_WAIT })
            .pipe(Effect.ignore);
          return;
        }
        // Detached spawn puts the Pi process in its own group; kill the group so
        // tool children (bash, etc.) do not outlive the adapter session.
        yield* Effect.sync(() => {
          try {
            process.kill(-Number(handle!.pid), signal);
          } catch {
            // Process may already have exited; fall through to direct kill.
          }
        });
        yield* handle.kill({ killSignal: signal }).pipe(Effect.ignore);
      });

    const close = Effect.gen(function* () {
      if (yield* Ref.getAndSet(closedRef, true)) {
        return;
      }
      yield* failAllPending(new PiSessionRuntimeClosedError({ detail: "Pi RPC runtime closed." }));
      if (!handle) {
        return;
      }
      // Best-effort graceful: end stdin (queue shutdown completes the write stream),
      // SIGTERM the process group, then SIGKILL.
      yield* Queue.shutdown(stdinQueue).pipe(Effect.ignore);
      if (stdinFiber) {
        yield* Fiber.join(stdinFiber).pipe(Effect.timeoutOption("500 millis"), Effect.ignore);
        stdinFiber = undefined;
      }
      yield* killProcessTree("SIGTERM");
      const exited = yield* handle.exitCode.pipe(
        Effect.timeoutOption(GRACEFUL_EXIT_WAIT),
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      );
      if (!exited) {
        yield* killProcessTree("SIGKILL");
        yield* handle.exitCode.pipe(Effect.timeoutOption(FORCE_KILL_WAIT), Effect.ignore);
      }
      if (stdoutFiber) {
        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      }
      if (stderrFiber) {
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
      }
      if (exitFiber) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
      }
    }).pipe(Effect.asVoid);

    const shape: PiSessionRuntimeShape = {
      get pid() {
        return handle?.pid !== undefined ? Number(handle.pid) : undefined;
      },
      start,
      getState,
      // Prompt ack is acceptance, not turn completion (events carry the rest).
      // Keep a generous bound so slow accept under load does not abort live work.
      prompt: (input) =>
        command(
          {
            type: "prompt",
            message: input.message,
            ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
          },
          Duration.seconds(120),
        ).pipe(Effect.asVoid),
      abort: () => command({ type: "abort" }, Duration.seconds(5)).pipe(Effect.asVoid),
      setModel: (provider, modelId) => command({ type: "set_model", provider, modelId }),
      setThinkingLevel: (level) =>
        command({ type: "set_thinking_level", level }).pipe(Effect.asVoid),
      getAvailableModels: () =>
        command({ type: "get_available_models" }, Duration.seconds(30)).pipe(
          Effect.map((data) => {
            if (
              data &&
              typeof data === "object" &&
              Array.isArray((data as { models?: unknown }).models)
            ) {
              return (data as { models: ReadonlyArray<Record<string, unknown>> }).models;
            }
            return [];
          }),
        ),
      getMessages: () =>
        command({ type: "get_messages" }).pipe(
          Effect.map((data) => {
            if (
              data &&
              typeof data === "object" &&
              Array.isArray((data as { messages?: unknown }).messages)
            ) {
              return (data as { messages: ReadonlyArray<unknown> }).messages;
            }
            return [];
          }),
        ),
      getEntries: () =>
        command({ type: "get_entries" }).pipe(
          Effect.map((data) => {
            const record =
              data && typeof data === "object" ? (data as Record<string, unknown>) : {};
            const entries = Array.isArray(record.entries)
              ? (record.entries as ReadonlyArray<Record<string, unknown>>)
              : [];
            const leafId =
              typeof record.leafId === "string" || record.leafId === null
                ? (record.leafId as string | null)
                : null;
            return { entries, leafId };
          }),
        ),
      getForkMessages: () =>
        command({ type: "get_fork_messages" }).pipe(
          Effect.map((data) => {
            if (
              data &&
              typeof data === "object" &&
              Array.isArray((data as { messages?: unknown }).messages)
            ) {
              return (
                data as {
                  messages: ReadonlyArray<{ entryId: string; text: string }>;
                }
              ).messages;
            }
            return [];
          }),
        ),
      fork: (entryId) =>
        command({ type: "fork", entryId }).pipe(
          Effect.map((data) => {
            const record =
              data && typeof data === "object" ? (data as Record<string, unknown>) : {};
            return {
              text: typeof record.text === "string" ? record.text : "",
              cancelled: record.cancelled === true,
            };
          }),
        ),
      respondExtensionUi: (response) => writeLine(response),
      command,
      events: Stream.fromQueue(eventQueue),
      close,
      buildResumeCursor: () =>
        Effect.gen(function* () {
          const state = (yield* Ref.get(stateRef)) ?? (yield* getState());
          const sessionPath = state.sessionFile?.trim();
          const sessionId = state.sessionId?.trim();
          if (!sessionPath) {
            return yield* new PiSessionRuntimeStateError({
              detail: "Pi session has no session file path for resume cursor.",
            });
          }
          if (!sessionId) {
            return yield* new PiSessionRuntimeStateError({
              detail: "Pi session has no session id for resume cursor.",
            });
          }
          return {
            version: 1 as const,
            sessionId,
            sessionPath,
            cwd: options.spawn.cwd,
          } satisfies PiResumeCursor;
        }),
    };

    yield* Scope.addFinalizer(runtimeScope, close.pipe(Effect.ignore));
    return shape;
  });
}

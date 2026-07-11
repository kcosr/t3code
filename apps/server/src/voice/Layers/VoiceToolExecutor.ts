import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ClientOrchestrationCommand,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  VoiceConfirmationId,
  VoiceToolCallId,
  VoiceToolName,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type VoiceConversationId,
  type VoiceSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ClientCommandDispatcher } from "../../orchestration/Services/ClientCommandDispatcher.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type DurableVoiceToolCall,
  VoiceToolCallRepository,
} from "../../persistence/Services/VoiceToolCalls.ts";
import { VoiceError } from "../Errors.ts";
import { VoiceConversationService } from "../Services/VoiceConversationService.ts";
import {
  VoiceToolExecutor,
  type VoiceToolCallInput,
  type VoiceToolCompletedResult,
  type VoiceToolExecutorShape,
  type VoiceToolInvokeResult,
} from "../Services/VoiceToolExecutor.ts";

const CONFIRMATION_TTL_MILLIS = 30_000;
const MAX_RETAINED_CALLS = 512;

const ListProjectsArguments = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
const ListThreadsArguments = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
const ThreadArguments = Schema.Struct({ threadId: ThreadId });
const CreateThreadArguments = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
});
const SendThreadMessageArguments = Schema.Struct({
  threadId: ThreadId,
  message: TrimmedNonEmptyString,
});
const decodeVoiceToolName = Schema.decodeUnknownEffect(VoiceToolName);

type PreparedMutation = {
  readonly tool: Extract<
    VoiceToolName,
    "create_thread" | "send_thread_message" | "interrupt_thread" | "archive_thread"
  >;
  readonly summary: string;
  readonly command: ClientOrchestrationCommand;
};

interface PendingCall {
  readonly type: "pending";
  readonly sessionId: VoiceSessionId;
  readonly conversationId: VoiceConversationId;
  readonly toolCallId: VoiceToolCallId;
  readonly providerFunctionCallId: string;
  readonly confirmationId: VoiceConfirmationId;
  readonly tool: PreparedMutation["tool"];
  readonly summary: string;
  readonly command: ClientOrchestrationCommand;
  readonly grantedScopes: VoiceToolCallInput["grantedScopes"];
  readonly expiresAtMillis: number;
  readonly expiresAt: string;
}

interface CompletedCall {
  readonly type: "completed";
  readonly sessionId: VoiceSessionId;
  readonly result: VoiceToolCompletedResult;
  readonly completedAtMillis: number;
}

type CallState = PendingCall | CompletedCall;
interface ExecutorState {
  readonly calls: ReadonlyMap<string, CallState>;
  readonly confirmations: ReadonlyMap<VoiceConfirmationId, string>;
}

const callKey = (conversationId: VoiceConversationId, toolCallId: VoiceToolCallId) =>
  `${conversationId}:${toolCallId}`;

const voiceError = (reason: VoiceError["reason"], operation: string, detail: string) =>
  new VoiceError({ reason, operation, detail, retryable: false });

const jsonOutput = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(ClientOrchestrationCommand));
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientOrchestrationCommand));

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeJsonValue(item)]),
  );
};

const canonicalizeArguments = (argumentsJson: string) =>
  Effect.try({
    try: () => jsonOutput(canonicalizeJsonValue(decodeJson(argumentsJson))),
    catch: () =>
      voiceError("invalid-phase", "tool.arguments", "Voice tool arguments were not valid JSON"),
  });

const deterministicId = (prefix: string, input: VoiceToolCallInput) =>
  `${prefix}:${input.conversationId}:${input.toolCallId}`;

const parseArguments = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  input: VoiceToolCallInput,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
    onExcessProperty: "error",
  })(input.argumentsJson).pipe(
    Effect.mapError(() =>
      voiceError("invalid-phase", "tool.arguments", "Voice tool arguments were invalid"),
    ),
  );

const projectOutput = (project: OrchestrationProjectShell) => ({
  projectId: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
});

const threadOutput = (thread: OrchestrationThreadShell) => ({
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  runtimeMode: thread.runtimeMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  turnState: thread.latestTurn?.state ?? null,
  sessionStatus: thread.session?.status ?? "stopped",
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  updatedAt: thread.updatedAt,
});

const mutationOutput = (command: ClientOrchestrationCommand, sequence: number) => {
  switch (command.type) {
    case "thread.create":
    case "thread.turn.start":
    case "thread.turn.interrupt":
    case "thread.archive":
      return jsonOutput({ sequence, threadId: command.threadId });
    default:
      return jsonOutput({ sequence });
  }
};

const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const dispatcher = yield* ClientCommandDispatcher;
  const conversations = yield* VoiceConversationService;
  const toolCalls = yield* VoiceToolCallRepository;
  const state = yield* SynchronizedRef.make<ExecutorState>({
    calls: new Map(),
    confirmations: new Map(),
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const appendJournal = Effect.fn("VoiceToolExecutor.appendJournal")(function* (
    input: VoiceToolCallInput,
    outcome: string,
    result?: string,
  ) {
    const canonicalArgumentsJson =
      outcome === "requested" ? yield* canonicalizeArguments(input.argumentsJson) : undefined;
    return yield* conversations.appendContextIdempotent({
      entryId: `voice-tool:${input.conversationId}:${input.toolCallId}:${outcome}`,
      conversationId: input.conversationId,
      kind: outcome === "requested" ? "tool-request" : "tool-result",
      payload:
        outcome === "requested"
          ? {
              toolCallId: input.toolCallId,
              providerFunctionCallId: input.providerFunctionCallId,
              tool: input.name,
              argumentsJson: canonicalArgumentsJson,
            }
          : {
              toolCallId: input.toolCallId,
              providerFunctionCallId: input.providerFunctionCallId,
              tool: input.name,
              outcome,
              ...(result === undefined ? {} : { result }),
            },
    });
  });

  const completed = (
    input: VoiceToolCallInput,
    tool: VoiceToolCompletedResult["tool"],
    outcome: VoiceToolCompletedResult["outcome"],
    output: string,
  ): VoiceToolCompletedResult => ({
    type: "completed",
    toolCallId: input.toolCallId,
    providerFunctionCallId: input.providerFunctionCallId,
    tool,
    outcome,
    output,
    submitOutput: true,
  });

  const requireThread = (threadId: ThreadId) =>
    query.getThreadShellById(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              voiceError("invalid-phase", "tool.thread", `Thread ${threadId} was not found`),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const prepareMutation = Effect.fn("VoiceToolExecutor.prepareMutation")(function* (
    input: VoiceToolCallInput,
    tool: PreparedMutation["tool"],
  ) {
    const createdAt = yield* nowIso;
    const commandId = CommandId.make(deterministicId("voice", input));
    switch (tool) {
      case "create_thread": {
        const args = yield* parseArguments(CreateThreadArguments, input);
        const project = yield* query.getProjectShellById(args.projectId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  voiceError(
                    "invalid-phase",
                    "tool.project",
                    `Project ${args.projectId} was not found`,
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const threadId = ThreadId.make(deterministicId("voice-thread", input));
        const title = args.title ?? "Voice thread";
        return {
          tool,
          summary: `Create thread "${title}" in project "${project.title}"`,
          command: {
            type: "thread.create",
            commandId,
            threadId,
            projectId: project.id,
            title,
            modelSelection: project.defaultModelSelection ?? {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          },
        } satisfies PreparedMutation;
      }
      case "send_thread_message": {
        const args = yield* parseArguments(SendThreadMessageArguments, input);
        const thread = yield* requireThread(args.threadId);
        return {
          tool,
          summary: `Send message to thread "${thread.title}": ${args.message.slice(0, 160)}`,
          command: {
            type: "thread.turn.start",
            commandId,
            threadId: thread.id,
            message: {
              messageId: MessageId.make(deterministicId("voice-message", input)),
              role: "user",
              text: args.message,
              attachments: [],
            },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt,
          },
        } satisfies PreparedMutation;
      }
      case "interrupt_thread": {
        const args = yield* parseArguments(ThreadArguments, input);
        const thread = yield* requireThread(args.threadId);
        return {
          tool,
          summary: `Interrupt the active turn in thread "${thread.title}"`,
          command: {
            type: "thread.turn.interrupt",
            commandId,
            threadId: thread.id,
            ...(thread.latestTurn === null ? {} : { turnId: thread.latestTurn.turnId }),
            createdAt,
          },
        } satisfies PreparedMutation;
      }
      case "archive_thread": {
        const args = yield* parseArguments(ThreadArguments, input);
        const thread = yield* requireThread(args.threadId);
        return {
          tool,
          summary: `Archive thread "${thread.title}"`,
          command: {
            type: "thread.archive",
            commandId,
            threadId: thread.id,
          },
        } satisfies PreparedMutation;
      }
    }
  });

  const executeRead = Effect.fn("VoiceToolExecutor.executeRead")(function* (
    input: VoiceToolCallInput,
    tool: Extract<VoiceToolName, "list_projects" | "list_threads" | "get_thread_status">,
  ) {
    switch (tool) {
      case "list_projects": {
        const args = yield* parseArguments(ListProjectsArguments, input);
        const snapshot = yield* query.getShellSnapshot();
        return jsonOutput({ projects: snapshot.projects.slice(0, args.limit).map(projectOutput) });
      }
      case "list_threads": {
        const args = yield* parseArguments(ListThreadsArguments, input);
        const snapshot = yield* query.getShellSnapshot();
        return jsonOutput({
          threads: snapshot.threads
            .filter((thread) => thread.projectId === args.projectId)
            .slice(0, args.limit)
            .map(threadOutput),
        });
      }
      case "get_thread_status": {
        const args = yield* parseArguments(ThreadArguments, input);
        return jsonOutput({ thread: threadOutput(yield* requireThread(args.threadId)) });
      }
    }
  });

  const prune = (current: ExecutorState, now: number): ExecutorState => {
    const retained = [...current.calls.entries()]
      .filter(([, call]) =>
        call.type === "pending"
          ? call.expiresAtMillis > now
          : now - call.completedAtMillis < 10 * 60_000,
      )
      .slice(-MAX_RETAINED_CALLS);
    const calls = new Map(retained);
    const confirmations = new Map(
      [...current.confirmations.entries()].filter(([, key]) => calls.get(key)?.type === "pending"),
    );
    return { calls, confirmations };
  };

  const persistenceFailure = (operation: string) =>
    Effect.mapError(
      (cause: unknown) =>
        new VoiceError({
          reason: "provider-unavailable",
          operation,
          detail: cause instanceof Error ? cause.message : "Voice tool persistence failed",
          retryable: true,
        }),
    );

  const validateDurableIdentity = (input: VoiceToolCallInput, call: DurableVoiceToolCall) =>
    Effect.gen(function* () {
      const canonicalArgumentsJson = yield* canonicalizeArguments(input.argumentsJson);
      if (
        call.providerFunctionCallId !== input.providerFunctionCallId ||
        call.toolName !== input.name ||
        call.canonicalArgumentsJson !== canonicalArgumentsJson
      ) {
        return yield* Effect.fail(
          voiceError(
            "invalid-phase",
            "tool.idempotency",
            "Voice tool-call identity was reused with different canonical input",
          ),
        );
      }
      return canonicalArgumentsJson;
    });

  const completedFromDurable = (
    call: DurableVoiceToolCall,
    submitOutput: boolean,
  ): VoiceToolCompletedResult => ({
    type: "completed",
    toolCallId: call.toolCallId,
    providerFunctionCallId: call.providerFunctionCallId,
    tool: Schema.is(VoiceToolName)(call.toolName) ? call.toolName : "unknown",
    outcome:
      call.status === "requested" || call.status === "pending-confirmation"
        ? "failed"
        : call.status,
    output: call.resultOutput ?? jsonOutput({ error: "Voice tool result was unavailable" }),
    submitOutput,
  });

  const pendingFromDurable = (
    call: DurableVoiceToolCall,
    grantedScopes: VoiceToolCallInput["grantedScopes"],
  ) =>
    Effect.gen(function* () {
      if (
        call.status !== "pending-confirmation" ||
        call.confirmationId === null ||
        call.summary === null ||
        call.commandJson === null ||
        call.expiresAt === null
      ) {
        return yield* Effect.fail(
          voiceError("invalid-phase", "tool.confirmation", "Persisted confirmation was incomplete"),
        );
      }
      const tool = yield* decodeVoiceToolName(call.toolName).pipe(
        Effect.mapError(() =>
          voiceError("invalid-phase", "tool.name", "Persisted voice tool name was invalid"),
        ),
      );
      if (tool === "list_projects" || tool === "list_threads" || tool === "get_thread_status") {
        return yield* Effect.fail(
          voiceError("invalid-phase", "tool.state", "Read tool cannot await confirmation"),
        );
      }
      const command = yield* decodeCommand(call.commandJson).pipe(
        Effect.mapError(() =>
          voiceError("invalid-phase", "tool.command", "Persisted voice command was invalid"),
        ),
      );
      return {
        type: "pending",
        sessionId: call.sessionId,
        conversationId: call.conversationId,
        toolCallId: call.toolCallId,
        providerFunctionCallId: call.providerFunctionCallId,
        confirmationId: call.confirmationId,
        tool,
        summary: call.summary,
        command,
        grantedScopes,
        expiresAtMillis: Date.parse(call.expiresAt),
        expiresAt: call.expiresAt,
      } satisfies PendingCall;
    });

  const persistCompleted = (
    input: VoiceToolCallInput,
    result: VoiceToolCompletedResult,
    updatedAt: string,
  ) =>
    conversations.get(input.conversationId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              voiceError(
                "conversation-not-found",
                "tool.persist-terminal",
                "Voice conversation was not found",
              ),
            ),
          onSome: (conversation) =>
            conversation.retention === "ephemeral"
              ? Effect.void
              : toolCalls
                  .markTerminal({
                    conversationId: input.conversationId,
                    toolCallId: input.toolCallId,
                    status: result.outcome,
                    resultOutput: result.output,
                    updatedAt,
                  })
                  .pipe(persistenceFailure("tool.persist-terminal")),
        }),
      ),
    );

  const invoke: VoiceToolExecutorShape["invoke"] = Effect.fn("VoiceToolExecutor.invoke")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const requestedAt = yield* nowIso;
      const canonicalArgumentsJson = yield* canonicalizeArguments(input.argumentsJson);
      const conversation = yield* conversations.get(input.conversationId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                voiceError(
                  "conversation-not-found",
                  "tool.persist-requested",
                  "Voice conversation was not found",
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      const claimed =
        conversation.retention === "durable"
          ? yield* toolCalls
              .createRequested({
                conversationId: input.conversationId,
                toolCallId: input.toolCallId,
                providerFunctionCallId: input.providerFunctionCallId,
                toolName: input.name,
                canonicalArgumentsJson,
                sessionId: input.sessionId,
                createdAt: requestedAt,
              })
              .pipe(persistenceFailure("tool.persist-requested"))
          : {
              created: true,
              call: {
                conversationId: input.conversationId,
                toolCallId: input.toolCallId,
                providerFunctionCallId: input.providerFunctionCallId,
                toolName: input.name,
                canonicalArgumentsJson,
                status: "requested",
                sessionId: input.sessionId,
                confirmationId: null,
                summary: null,
                commandId: null,
                commandJson: null,
                resultOutput: null,
                createdAt: requestedAt,
                updatedAt: requestedAt,
                expiresAt: null,
              } satisfies DurableVoiceToolCall,
            };
      yield* validateDurableIdentity(input, claimed.call);
      return yield* SynchronizedRef.modifyEffect<
        ExecutorState,
        VoiceToolInvokeResult,
        VoiceError,
        never
      >(state, (unpruned) => {
        const current = prune(unpruned, now);
        const key = callKey(input.conversationId, input.toolCallId);
        const existing = current.calls.get(key);
        if (existing?.type === "completed") {
          return Effect.succeed([{ ...existing.result, submitOutput: false }, current] as const);
        }
        if (existing?.type === "pending") {
          return Effect.succeed([
            {
              type: "confirmation-required",
              confirmationId: existing.confirmationId,
              toolCallId: existing.toolCallId,
              providerFunctionCallId: existing.providerFunctionCallId,
              tool: existing.tool,
              summary: existing.summary,
              expiresAt: existing.expiresAt,
              newlyCreated: false,
            } satisfies VoiceToolInvokeResult,
            current,
          ] as const);
        }

        if (claimed.call.status !== "requested" && claimed.call.status !== "pending-confirmation") {
          const result = completedFromDurable(claimed.call, true);
          return Effect.succeed([
            result,
            {
              ...current,
              calls: new Map(current.calls).set(key, {
                type: "completed",
                sessionId: input.sessionId,
                result,
                completedAtMillis: now,
              }),
            },
          ] as const);
        }

        if (claimed.call.status === "pending-confirmation") {
          return Effect.gen(function* () {
            if (claimed.call.sessionId !== input.sessionId) {
              return yield* Effect.fail(
                voiceError(
                  "invalid-phase",
                  "tool.confirmation",
                  "Pending voice tool call belongs to another session",
                ),
              );
            }
            const pending = yield* pendingFromDurable(claimed.call, input.grantedScopes);
            yield* appendJournal(input, "pending-confirmation");
            return [
              {
                type: "confirmation-required",
                confirmationId: pending.confirmationId,
                toolCallId: pending.toolCallId,
                providerFunctionCallId: pending.providerFunctionCallId,
                tool: pending.tool,
                summary: pending.summary,
                expiresAt: pending.expiresAt,
                newlyCreated: false,
              } satisfies VoiceToolInvokeResult,
              {
                calls: new Map(current.calls).set(key, pending),
                confirmations: new Map(current.confirmations).set(pending.confirmationId, key),
              },
            ] as const;
          });
        }

        return Effect.gen(function* () {
          yield* appendJournal(input, "requested");
          const decodedTool = yield* decodeVoiceToolName(input.name).pipe(Effect.option);
          if (Option.isNone(decodedTool)) {
            const result = completed(
              input,
              "unknown",
              "failed",
              jsonOutput({ error: `Unknown T3 tool: ${input.name}` }),
            );
            yield* appendJournal(input, result.outcome, result.output);
            yield* persistCompleted(input, result, requestedAt);
            return [
              result,
              {
                ...current,
                calls: new Map(current.calls).set(key, {
                  type: "completed",
                  sessionId: input.sessionId,
                  result,
                  completedAtMillis: now,
                }),
              },
            ] as const;
          }
          const tool = decodedTool.value;
          const isReadTool =
            tool === "list_projects" || tool === "list_threads" || tool === "get_thread_status";
          const requiredScope = isReadTool
            ? AuthOrchestrationReadScope
            : AuthOrchestrationOperateScope;
          if (!input.grantedScopes.has(requiredScope)) {
            const result = completed(
              input,
              tool,
              "failed",
              jsonOutput({ error: `Voice tool requires ${requiredScope}` }),
            );
            yield* appendJournal(input, result.outcome, result.output);
            yield* persistCompleted(input, result, requestedAt);
            return [
              result,
              {
                ...current,
                calls: new Map(current.calls).set(key, {
                  type: "completed",
                  sessionId: input.sessionId,
                  result,
                  completedAtMillis: now,
                }),
              },
            ] as const;
          }
          if (isReadTool) {
            const output = yield* executeRead(input, tool).pipe(
              Effect.mapError((cause) => cause),
              Effect.match({
                onFailure: (cause) =>
                  jsonOutput({
                    error: cause instanceof Error ? cause.message : "Invalid tool arguments",
                  }),
                onSuccess: (value) => value,
              }),
            );
            const outcome = output.startsWith('{"error"')
              ? ("failed" as const)
              : ("succeeded" as const);
            const result = completed(input, tool, outcome, output);
            yield* appendJournal(input, outcome, output);
            yield* persistCompleted(input, result, requestedAt);
            return [
              result,
              {
                ...current,
                calls: new Map(current.calls).set(key, {
                  type: "completed",
                  sessionId: input.sessionId,
                  result,
                  completedAtMillis: now,
                }),
              },
            ] as const;
          }

          const prepared = yield* prepareMutation(input, tool).pipe(
            Effect.match({
              onFailure: (cause) =>
                ({
                  error: cause instanceof Error ? cause.message : "Invalid tool arguments",
                }) as const,
              onSuccess: (value) => ({ value }) as const,
            }),
          );
          if ("error" in prepared) {
            const result = completed(input, tool, "failed", jsonOutput({ error: prepared.error }));
            yield* appendJournal(input, result.outcome, result.output);
            yield* persistCompleted(input, result, requestedAt);
            return [
              result,
              {
                ...current,
                calls: new Map(current.calls).set(key, {
                  type: "completed",
                  sessionId: input.sessionId,
                  result,
                  completedAtMillis: now,
                }),
              },
            ] as const;
          }
          const confirmationId = VoiceConfirmationId.make(deterministicId("voice-confirm", input));
          const expiresAtMillis = now + CONFIRMATION_TTL_MILLIS;
          const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis));
          const pending: PendingCall = {
            type: "pending",
            sessionId: input.sessionId,
            conversationId: input.conversationId,
            toolCallId: input.toolCallId,
            providerFunctionCallId: input.providerFunctionCallId,
            confirmationId,
            tool: prepared.value.tool,
            summary: prepared.value.summary,
            command: prepared.value.command,
            grantedScopes: input.grantedScopes,
            expiresAtMillis,
            expiresAt,
          };
          if (conversation.retention === "durable") {
            yield* toolCalls
              .markPending({
                conversationId: input.conversationId,
                toolCallId: input.toolCallId,
                sessionId: input.sessionId,
                confirmationId,
                summary: prepared.value.summary,
                commandId: prepared.value.command.commandId,
                commandJson: encodeCommand(prepared.value.command),
                updatedAt: requestedAt,
                expiresAt,
              })
              .pipe(persistenceFailure("tool.persist-pending"));
          }
          yield* appendJournal(input, "pending-confirmation");
          return [
            {
              type: "confirmation-required",
              confirmationId,
              toolCallId: input.toolCallId,
              providerFunctionCallId: input.providerFunctionCallId,
              tool: prepared.value.tool,
              summary: prepared.value.summary,
              expiresAt,
              newlyCreated: true,
            },
            {
              calls: new Map(current.calls).set(key, pending),
              confirmations: new Map(current.confirmations).set(confirmationId, key),
            },
          ] as const;
        });
      });
    },
  );

  const decide: VoiceToolExecutorShape["decide"] = Effect.fn("VoiceToolExecutor.decide")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      return yield* SynchronizedRef.modifyEffect(state, (unpruned) => {
        return Effect.gen(function* () {
          let working = unpruned;
          let key = working.confirmations.get(input.confirmationId);
          let pending = key === undefined ? undefined : working.calls.get(key);
          if (key === undefined || pending === undefined || pending.type !== "pending") {
            const durable = yield* toolCalls
              .getByConfirmationId(input.confirmationId)
              .pipe(persistenceFailure("tool.load-confirmation"));
            if (Option.isSome(durable) && durable.value.status === "pending-confirmation") {
              const hydrated = yield* pendingFromDurable(durable.value, new Set());
              key = callKey(hydrated.conversationId, hydrated.toolCallId);
              pending = hydrated;
              working = {
                calls: new Map(working.calls).set(key, hydrated),
                confirmations: new Map(working.confirmations).set(input.confirmationId, key),
              };
            }
          }
          if (
            key === undefined ||
            pending === undefined ||
            pending.type !== "pending" ||
            pending.sessionId !== input.sessionId ||
            pending.expiresAtMillis <= now
          ) {
            return yield* Effect.fail(
              voiceError(
                "confirmation-expired",
                "tool.confirmation",
                "Voice tool confirmation was not found, was already decided, or has expired",
              ),
            );
          }
          const toolInput: VoiceToolCallInput = {
            sessionId: pending.sessionId,
            conversationId: pending.conversationId,
            toolCallId: pending.toolCallId,
            providerFunctionCallId: pending.providerFunctionCallId,
            name: pending.tool,
            argumentsJson: "{}",
            grantedScopes: pending.grantedScopes,
          };
          const result =
            input.decision === "reject"
              ? completed(toolInput, pending.tool, "rejected", jsonOutput({ rejected: true }))
              : yield* dispatcher.dispatch(pending.command).pipe(
                  Effect.match({
                    onFailure: (cause) =>
                      completed(
                        toolInput,
                        pending.tool,
                        "failed",
                        jsonOutput({
                          error:
                            cause instanceof Error ? cause.message : "T3 command dispatch failed",
                        }),
                      ),
                    onSuccess: (receipt) =>
                      completed(
                        toolInput,
                        pending.tool,
                        "succeeded",
                        mutationOutput(pending.command, receipt.sequence),
                      ),
                  }),
                );
          const completedAt = yield* nowIso;
          yield* appendJournal(toolInput, result.outcome, result.output);
          yield* persistCompleted(toolInput, result, completedAt);
          const pendingKey = key;
          const calls = new Map(working.calls);
          calls.set(pendingKey, {
            type: "completed",
            sessionId: pending.sessionId,
            result,
            completedAtMillis: now,
          });
          const confirmations = new Map(working.confirmations);
          confirmations.delete(input.confirmationId);
          return [result, prune({ calls, confirmations }, now)] as const;
        });
      });
    },
  );

  const expire: VoiceToolExecutorShape["expire"] = Effect.fn("VoiceToolExecutor.expire")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      return yield* SynchronizedRef.modifyEffect(state, (current) => {
        const key = current.confirmations.get(input.confirmationId);
        const pending = key === undefined ? undefined : current.calls.get(key);
        if (
          key === undefined ||
          pending === undefined ||
          pending.type !== "pending" ||
          pending.sessionId !== input.sessionId ||
          pending.expiresAtMillis > now
        ) {
          return Effect.succeed([undefined, prune(current, now)] as const);
        }
        const toolInput: VoiceToolCallInput = {
          sessionId: pending.sessionId,
          conversationId: pending.conversationId,
          toolCallId: pending.toolCallId,
          providerFunctionCallId: pending.providerFunctionCallId,
          name: pending.tool,
          argumentsJson: "{}",
          grantedScopes: pending.grantedScopes,
        };
        const result = completed(
          toolInput,
          pending.tool,
          "expired",
          jsonOutput({ error: "Voice tool confirmation expired" }),
        );
        return nowIso.pipe(
          Effect.tap(() => appendJournal(toolInput, "expired", result.output)),
          Effect.flatMap((completedAt) => persistCompleted(toolInput, result, completedAt)),
          Effect.map(() => {
            const pendingKey = key;
            const calls = new Map(current.calls);
            calls.set(pendingKey, {
              type: "completed",
              sessionId: pending.sessionId,
              result,
              completedAtMillis: now,
            });
            const confirmations = new Map(current.confirmations);
            confirmations.delete(input.confirmationId);
            return [result, prune({ calls, confirmations }, now)] as const;
          }),
          Effect.orDie,
        );
      });
    },
  );

  const discardSession: VoiceToolExecutorShape["discardSession"] = (sessionId) =>
    SynchronizedRef.update(state, (current) => {
      const calls = new Map(
        [...current.calls.entries()].filter(([, call]) => call.sessionId !== sessionId),
      );
      const confirmations = new Map(
        [...current.confirmations.entries()].filter(([, key]) => calls.has(key)),
      );
      return { calls, confirmations };
    });

  return VoiceToolExecutor.of({ invoke, decide, expire, discardSession });
});

export const VoiceToolExecutorLive = Layer.effect(VoiceToolExecutor, make);

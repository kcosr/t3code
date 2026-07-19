import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthVoiceUseScope,
  type AuthEnvironmentScope,
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type HistoryReadInput as HistoryReadInputType,
  type HistorySearchInput as HistorySearchInputType,
  type HistoryVoiceScope as HistoryVoiceScopeType,
  type OrchestrationMessageTurnResult,
  ThreadId,
  VoiceConfirmationId,
  VoiceClientActionId,
  VoiceConversationEntryId,
  VoiceToolCallId,
  VoiceToolName,
  VoiceTerminalActionRequest,
  type OrchestrationProjectShell,
  type VoiceConversationId,
  type VoiceSessionId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ClientCommandDispatcher } from "../../orchestration/Services/ClientCommandDispatcher.ts";
import {
  HistorySearchService,
  type HistorySearchServiceError,
} from "../../history/Services/HistorySearchService.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadTurnOutcomeQuery } from "../../orchestration/Services/ThreadTurnOutcomeQuery.ts";
import {
  ProjectionThreadMessageCursor,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type DurableVoiceToolCall,
  VoiceToolCallRepository,
} from "../../persistence/Services/VoiceToolCalls.ts";
import { VoiceError } from "../Errors.ts";
import {
  CreateThreadTool,
  GetThreadMessagesArguments,
  ListProjectsArguments,
  ListThreadsTool,
  ReadHistoryArguments,
  SearchHistoryArguments,
  SendThreadMessageArguments,
  StopRealtimeArguments,
  ThreadArguments,
  VoiceToolHistoryVoiceScope,
  WaitForThreadTurnArguments,
  voiceThreadProjection as threadOutput,
} from "../modelTools/definitions.ts";
import { VoiceConversationService } from "../Services/VoiceConversationService.ts";
import {
  VoiceToolExecutor,
  isTerminalVoiceTool,
  terminalActionForVoiceTool,
  type TerminalVoiceTool,
  type VoiceToolCallInput,
  type VoiceToolCompletedResult,
  type VoiceToolExecutionResult,
  type VoiceToolExecutorShape,
  type VoiceToolInvokeResult,
  type VoiceToolTerminalResult,
} from "../Services/VoiceToolExecutor.ts";

const CONFIRMATION_TTL_MILLIS = 30_000;
const MAX_RETAINED_CALLS = 512;
const MAX_TOOL_MESSAGE_CHARS = 4_000;
const MAX_TOOL_PAGE_CHARS = 16_000;
const MAX_WAIT_MESSAGE_CHARS = 8_000;
const MAX_HISTORY_TOOL_OUTPUT_BYTES = 32_000;
const TURN_WAIT_POLL_INTERVAL = "250 millis";

type SearchHistoryArgumentsType = typeof SearchHistoryArguments.Type;
type ReadHistoryArgumentsType = typeof ReadHistoryArguments.Type;

const resolveHistoryVoiceScope = (
  scope: VoiceToolHistoryVoiceScope,
  conversationId: VoiceConversationId,
): HistoryVoiceScopeType =>
  scope.type === "current-conversation" ? { type: "conversation", conversationId } : scope;

const resolveSearchHistoryArguments = (
  args: SearchHistoryArgumentsType,
  conversationId: VoiceConversationId,
): HistorySearchInputType => {
  const { voiceScope: requestedVoiceScope, ...rest } = args;
  const voiceScope =
    requestedVoiceScope === undefined
      ? args.sources.includes("voice-entry")
        ? ({ type: "conversation", conversationId } as const)
        : undefined
      : resolveHistoryVoiceScope(requestedVoiceScope, conversationId);
  return voiceScope === undefined ? rest : { ...rest, voiceScope };
};

const resolveReadHistoryArguments = (
  args: ReadHistoryArgumentsType,
  conversationId: VoiceConversationId,
): HistoryReadInputType =>
  args.ref.type === "thread-message"
    ? {
        ref: {
          type: "thread-message",
          projectId: args.ref.projectId,
          threadId: args.ref.threadId,
          messageId: args.ref.messageId,
        },
        before: args.before,
        after: args.after,
      }
    : {
        ref: {
          type: "voice-entry",
          conversationId: args.ref.conversationId,
          entryId: args.ref.entryId,
        },
        voiceScope:
          args.voiceScope === undefined
            ? { type: "conversation", conversationId: args.ref.conversationId }
            : resolveHistoryVoiceScope(args.voiceScope, conversationId),
        before: args.before,
        after: args.after,
      };
const decodeVoiceToolName = Schema.decodeUnknownEffect(VoiceToolName);
const isVoiceToolName = Schema.is(VoiceToolName);
const decodeThreadMessagesCursor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectionThreadMessageCursor),
);
const encodeThreadMessagesCursor = Schema.encodeSync(
  Schema.fromJsonString(ProjectionThreadMessageCursor),
);

type ReadVoiceTool = Extract<
  VoiceToolName,
  | "list_projects"
  | "list_threads"
  | "get_thread_status"
  | "get_thread_messages"
  | "wait_for_thread_turn"
  | "search_history"
  | "read_history"
  | "activate_thread"
  | "stop_realtime_voice"
  | "switch_to_thread_voice"
>;
type MutationVoiceTool = Exclude<VoiceToolName, ReadVoiceTool>;
type HistoryVoiceTool = Extract<VoiceToolName, "search_history" | "read_history">;

const VOICE_TOOL_ACCESS = {
  list_projects: "orchestration-read",
  list_threads: "orchestration-read",
  get_thread_status: "orchestration-read",
  get_thread_messages: "orchestration-read",
  wait_for_thread_turn: "orchestration-read",
  search_history: "history-read",
  read_history: "history-read",
  activate_thread: "orchestration-read",
  stop_realtime_voice: "session",
  switch_to_thread_voice: "session",
  create_thread: "orchestration-operate",
  send_thread_message: "orchestration-operate",
  interrupt_thread: "orchestration-operate",
  archive_thread: "orchestration-operate",
} as const satisfies Record<
  VoiceToolName,
  "session" | "orchestration-read" | "history-read" | "orchestration-operate"
>;

const isReadTool = (tool: VoiceToolName): tool is ReadVoiceTool =>
  VOICE_TOOL_ACCESS[tool] !== "orchestration-operate";

const isHistoryToolName = (tool: string): tool is HistoryVoiceTool =>
  tool === "search_history" || tool === "read_history";

type PreparedMutation = {
  readonly tool: MutationVoiceTool;
  readonly summary: string;
  readonly command: ClientOrchestrationCommand;
};

interface PendingCall {
  readonly type: "pending";
  readonly authSessionId: VoiceToolCallInput["authSessionId"];
  readonly sessionId: VoiceSessionId;
  readonly conversationId: VoiceConversationId;
  readonly contextEpoch: number;
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
  readonly result: VoiceToolExecutionResult;
  readonly completedAtMillis: number;
}

interface ExecutingReadCall {
  readonly type: "executing-read";
  readonly sessionId: VoiceSessionId;
  readonly completion: Deferred.Deferred<VoiceToolExecutionResult, VoiceError>;
}

type CallState = PendingCall | CompletedCall | ExecutingReadCall;
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

const decodeCursor = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed(undefined);
  return Effect.try({
    try: () => Buffer.from(cursor, "base64url").toString("utf8"),
    catch: () => voiceError("invalid-phase", "tool.cursor", "Thread message cursor was invalid"),
  }).pipe(
    Effect.flatMap(decodeThreadMessagesCursor),
    Effect.mapError(() =>
      voiceError("invalid-phase", "tool.cursor", "Thread message cursor was invalid"),
    ),
  );
};

const encodeCursor = (cursor: ProjectionThreadMessageCursor) =>
  Buffer.from(encodeThreadMessagesCursor(cursor), "utf8").toString("base64url");

const boundedText = (text: string, limit: number) => ({
  text: text.slice(0, limit),
  truncated: text.length > limit,
});

const waitedTurnState = (result: OrchestrationMessageTurnResult) => {
  switch (result.state) {
    case "pending":
      return { state: "pending", turnId: null } as const;
    case "running":
    case "approval-required":
    case "user-input-required":
      return { state: result.state, turnId: result.turnId } as const;
    case "ambiguous":
      return {
        state: "failed",
        turnId: null,
        assistantMessage: null,
        ambiguous: true,
      } as const;
    case "failed":
      if (result.turnId === null) {
        return {
          state: "failed",
          turnId: null,
          assistantMessage: null,
          ambiguous: false,
        } as const;
      }
      break;
    case "completed":
    case "interrupted":
      break;
  }

  const assistantMessage =
    result.assistantMessage === null
      ? null
      : (() => {
          const bounded = boundedText(result.assistantMessage.text, MAX_WAIT_MESSAGE_CHARS);
          return {
            ...result.assistantMessage,
            ...bounded,
            truncated: result.assistantMessage.truncated || bounded.truncated,
          };
        })();
  return {
    state: result.state,
    turnId: result.turnId,
    assistantMessage,
  } as const;
};

const historyErrorOutput = (error: HistorySearchServiceError | VoiceError) => {
  switch (error._tag) {
    case "HistoryInvalidRequestError":
      return jsonOutput({ error: { code: error.reason, retryable: false } });
    case "HistoryItemNotFoundError":
      return jsonOutput({
        error: { code: "item_not_found", retryable: false },
      });
    case "HistorySearchUnavailableError":
      return jsonOutput({
        error: { code: "search_unavailable", retryable: true },
      });
    case "VoiceError":
      return jsonOutput({
        error: { code: "invalid_arguments", retryable: false },
      });
  }
};

const boundedHistoryOutput = (value: Record<string, unknown>) => {
  const output = jsonOutput({ contentTrust: "untrusted-history", ...value });
  return Buffer.byteLength(output, "utf8") <= MAX_HISTORY_TOOL_OUTPUT_BYTES
    ? output
    : jsonOutput({ error: { code: "result_too_large", retryable: false } });
};

const deterministicId = (prefix: string, input: VoiceToolCallInput) =>
  `${prefix}:${input.conversationId}:${input.toolCallId}`;

const terminalActionId = (input: {
  readonly sessionId: VoiceSessionId;
  readonly conversationId: VoiceConversationId;
  readonly contextEpoch: number;
  readonly toolCallId: VoiceToolCallId;
  readonly providerFunctionCallId: string;
  readonly name: string;
}) =>
  VoiceClientActionId.make(
    `voice-terminal:${NodeCrypto.createHash("sha256")
      .update(
        [
          input.sessionId,
          input.conversationId,
          String(input.contextEpoch),
          input.toolCallId,
          input.providerFunctionCallId,
          input.name,
        ].join("\0"),
      )
      .digest("base64url")}`,
  );

const PersistedTerminalResult = Schema.Struct({
  status: Schema.Literal("accepted"),
  terminalAction: VoiceTerminalActionRequest,
});
const decodePersistedTerminalResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedTerminalResult),
);

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

const mutationOutput = (command: ClientOrchestrationCommand, sequence: number) => {
  switch (command.type) {
    case "thread.turn.start":
      return jsonOutput({
        sequence,
        threadId: command.threadId,
        commandId: command.commandId,
        messageId: command.message.messageId,
      });
    case "thread.create":
    case "thread.turn.interrupt":
    case "thread.archive":
      return jsonOutput({
        sequence,
        threadId: command.threadId,
        commandId: command.commandId,
      });
    default:
      return jsonOutput({ sequence });
  }
};

const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const messages = yield* ProjectionThreadMessageRepository;
  const turnOutcomes = yield* ThreadTurnOutcomeQuery;
  const dispatcher = yield* ClientCommandDispatcher;
  const history = yield* HistorySearchService;
  const conversations = yield* VoiceConversationService;
  const toolCalls = yield* VoiceToolCallRepository;
  const state = yield* SynchronizedRef.make<ExecutorState>({
    calls: new Map(),
    confirmations: new Map(),
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const historyPrincipal = (input: VoiceToolCallInput) => ({
    sessionId: input.authSessionId,
    scopes: input.grantedScopes,
  });

  const requiredHistoryScopes = Effect.fn("VoiceToolExecutor.requiredHistoryScopes")(function* (
    input: VoiceToolCallInput,
    tool: HistoryVoiceTool,
  ) {
    if (tool === "search_history") {
      const args = yield* parseArguments(SearchHistoryArguments, input);
      return new Set<AuthEnvironmentScope>(
        args.sources.map((source) =>
          source === "thread-message" ? AuthOrchestrationReadScope : AuthVoiceUseScope,
        ),
      );
    }
    const args = yield* parseArguments(ReadHistoryArguments, input);
    return new Set<AuthEnvironmentScope>([
      args.ref.type === "thread-message" ? AuthOrchestrationReadScope : AuthVoiceUseScope,
    ]);
  });

  const appendJournal = Effect.fn("VoiceToolExecutor.appendJournal")(function* (
    input: VoiceToolCallInput,
    outcome: string,
    result?: string,
  ) {
    const canonicalArgumentsJson =
      outcome === "requested" ? yield* canonicalizeArguments(input.argumentsJson) : undefined;
    return yield* conversations.appendContextIdempotent({
      entryId: VoiceConversationEntryId.make(
        `voice-tool:${input.conversationId}:${input.toolCallId}:${outcome}`,
      ),
      conversationId: input.conversationId,
      expectedEpoch: input.contextEpoch,
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
              ...(result === undefined || isHistoryToolName(input.name) ? {} : { result }),
            },
    });
  });

  const durableResultOutput = (
    input: VoiceToolCallInput,
    result: VoiceToolExecutionResult,
  ): string =>
    isHistoryToolName(input.name)
      ? jsonOutput({
          contentTrust: "untrusted-history",
          result: {
            persisted: false,
            tool: input.name,
            outcome: result.outcome,
          },
        })
      : result.output;

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

  const resolveThreadVoiceTarget = Effect.fn("VoiceToolExecutor.resolveThreadVoiceTarget")(
    function* (threadId: ThreadId) {
      const thread = yield* requireThread(threadId);
      if (thread.archivedAt !== null) {
        return yield* voiceError(
          "invalid-phase",
          "tool.thread",
          `Thread ${threadId} is archived and unavailable for voice`,
        );
      }
      const project = yield* query.getProjectShellById(thread.projectId);
      if (Option.isNone(project)) {
        return yield* voiceError(
          "invalid-phase",
          "tool.project",
          `Project ${thread.projectId} for thread ${threadId} was not found`,
        );
      }
      if (thread.hasPendingApprovals) {
        return yield* voiceError(
          "invalid-phase",
          "tool.thread",
          `Thread ${threadId} is awaiting approval and cannot start voice`,
        );
      }
      if (thread.hasPendingUserInput) {
        return yield* voiceError(
          "invalid-phase",
          "tool.thread",
          `Thread ${threadId} is awaiting user input and cannot start voice`,
        );
      }
      if (
        thread.latestTurn?.state === "running" ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running"
      ) {
        return yield* voiceError(
          "invalid-phase",
          "tool.thread",
          `Thread ${threadId} is busy and cannot start voice`,
        );
      }
      if (thread.session?.status === "error") {
        return yield* voiceError(
          "invalid-phase",
          "tool.thread",
          `Thread ${threadId} is unavailable because its provider session is in error`,
        );
      }
      return {
        projectId: project.value.id,
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    },
  );

  const completeTerminalTool = Effect.fn("VoiceToolExecutor.completeTerminalTool")(function* (
    input: VoiceToolCallInput,
    tool: TerminalVoiceTool,
  ) {
    const actionId = terminalActionId(input);
    let terminalAction: VoiceTerminalActionRequest;
    if (tool === "stop_realtime_voice") {
      const args = yield* parseArguments(StopRealtimeArguments, input);
      if (Object.keys(args).length > 0) {
        return yield* voiceError(
          "invalid-phase",
          "tool.arguments",
          "stop_realtime_voice does not accept arguments",
        );
      }
      terminalAction = { actionId, action: "stop-realtime" };
    } else {
      const args = yield* parseArguments(ThreadArguments, input);
      terminalAction = {
        actionId,
        action: "switch-to-thread",
        target: yield* resolveThreadVoiceTarget(args.threadId),
      };
    }
    return {
      type: "terminal-completed",
      toolCallId: input.toolCallId,
      providerFunctionCallId: input.providerFunctionCallId,
      tool,
      outcome: "succeeded",
      output: jsonOutput({ status: "accepted", terminalAction }),
      terminalAction,
    } satisfies VoiceToolTerminalResult;
  });

  const prepareMutation = Effect.fn("VoiceToolExecutor.prepareMutation")(function* (
    input: VoiceToolCallInput,
    tool: PreparedMutation["tool"],
  ) {
    const createdAt = yield* nowIso;
    const commandId = CommandId.make(deterministicId("voice", input));
    switch (tool) {
      case "create_thread": {
        const args = yield* parseArguments(CreateThreadTool.inputSchema, input);
        const prepared = yield* CreateThreadTool.execute(
          {
            getProjectShellById: (projectId) => query.getProjectShellById(projectId),
            makeCommandId: Effect.succeed(commandId),
            makeThreadId: Effect.succeed(ThreadId.make(deterministicId("voice-thread", input))),
            nowIso: Effect.succeed(createdAt),
            projectNotFound: (projectId) =>
              voiceError("invalid-phase", "tool.project", `Project ${projectId} was not found`),
          },
          args,
        );
        return {
          tool,
          summary: prepared.summary,
          command: prepared.command,
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
    tool: Exclude<ReadVoiceTool, TerminalVoiceTool>,
  ) {
    switch (tool) {
      case "list_projects": {
        const args = yield* parseArguments(ListProjectsArguments, input);
        const snapshot = yield* query.getShellSnapshot();
        return jsonOutput({
          projects: snapshot.projects.slice(0, args.limit).map(projectOutput),
        });
      }
      case "list_threads": {
        const args = yield* parseArguments(ListThreadsTool.inputSchema, input);
        const result = yield* ListThreadsTool.execute(
          {
            getShellSnapshot: () => query.getShellSnapshot(),
          },
          args,
        );
        return jsonOutput(result);
      }
      case "get_thread_status": {
        const args = yield* parseArguments(ThreadArguments, input);
        return jsonOutput({
          thread: threadOutput(yield* requireThread(args.threadId)),
        });
      }
      case "activate_thread": {
        const args = yield* parseArguments(ThreadArguments, input);
        const thread = yield* requireThread(args.threadId);
        const resolution = yield* input.requestClientAction({
          actionId: VoiceClientActionId.make(deterministicId("voice-client-action", input)),
          action: "activate-thread",
          projectId: thread.projectId,
          threadId: thread.id,
        });
        return resolution.outcome === "succeeded"
          ? jsonOutput({ status: "thread-activated", threadId: thread.id })
          : jsonOutput({
              error: {
                code: resolution.reason ?? "client_action_failed",
                retryable: true,
              },
            });
      }
      case "get_thread_messages": {
        const args = yield* parseArguments(GetThreadMessagesArguments, input);
        yield* requireThread(args.threadId);
        const before = yield* decodeCursor(args.cursor);
        const page = yield* messages.listPageByThreadId({
          threadId: args.threadId,
          limit: args.limit,
          ...(before === undefined ? {} : { before }),
        });
        let remainingChars = MAX_TOOL_PAGE_CHARS;
        const outputNewestFirst = [];
        let budgetExcludedMessages = false;
        for (const message of page.messages.toReversed()) {
          if (remainingChars === 0) {
            budgetExcludedMessages = true;
            break;
          }
          const allowed = Math.min(MAX_TOOL_MESSAGE_CHARS, remainingChars);
          const content = boundedText(message.text, allowed);
          remainingChars -= content.text.length;
          outputNewestFirst.push({
            messageId: message.messageId,
            turnId: message.turnId,
            role: message.role,
            ...content,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          });
        }
        const outputMessages = outputNewestFirst.toReversed();
        const oldestEmitted = outputMessages.at(0);
        const nextCursor = budgetExcludedMessages
          ? oldestEmitted === undefined
            ? null
            : encodeCursor({
                createdAt: oldestEmitted.createdAt,
                messageId: oldestEmitted.messageId,
              })
          : page.nextCursor === null
            ? null
            : encodeCursor(page.nextCursor);
        return jsonOutput({
          messages: outputMessages,
          nextCursor,
        });
      }
      case "wait_for_thread_turn": {
        const args = yield* parseArguments(WaitForThreadTurnArguments, input);
        const readState = Effect.fn("VoiceToolExecutor.readWaitedTurn")(function* () {
          const lookup = yield* turnOutcomes.getByMessageId({
            threadId: args.threadId,
            messageId: args.messageId,
          });
          if (lookup.type === "thread-not-found") {
            return yield* voiceError(
              "invalid-phase",
              "tool.thread",
              `Thread ${args.threadId} was not found`,
            );
          }
          if (lookup.type === "message-not-found") {
            return yield* voiceError(
              "invalid-phase",
              "tool.wait-for-thread-turn",
              "The dispatched thread message was not found",
            );
          }
          return waitedTurnState(lookup.result);
        });

        type WaitedTurnState = Effect.Success<ReturnType<typeof readState>>;
        let lastObserved: WaitedTurnState = { state: "pending", turnId: null };
        const waitUntilSettled = Effect.gen(function* () {
          while (true) {
            const current = yield* readState();
            lastObserved = current;
            if (current.state !== "pending" && current.state !== "running") return current;
            yield* Effect.sleep(TURN_WAIT_POLL_INTERVAL);
          }
        });
        const waited = yield* waitUntilSettled.pipe(
          Effect.timeoutOption(`${args.waitMilliseconds} millis`),
        );
        return jsonOutput(Option.isSome(waited) ? waited.value : lastObserved);
      }
      case "search_history": {
        return yield* Effect.gen(function* () {
          const args = yield* parseArguments(SearchHistoryArguments, input);
          const result = yield* history.search(
            historyPrincipal(input),
            resolveSearchHistoryArguments(args, input.conversationId),
          );
          return boundedHistoryOutput(result);
        }).pipe(Effect.catch((error) => Effect.succeed(historyErrorOutput(error))));
      }
      case "read_history": {
        return yield* Effect.gen(function* () {
          const args = yield* parseArguments(ReadHistoryArguments, input);
          const resolved = resolveReadHistoryArguments(args, input.conversationId);
          if (resolved.ref.type === "voice-entry" && "voiceScope" in resolved) {
            if (
              resolved.voiceScope.type === "conversation" &&
              resolved.voiceScope.conversationId !== resolved.ref.conversationId
            ) {
              return jsonOutput({
                error: { code: "invalid_reference", retryable: false },
              });
            }
          }
          const result = yield* history.read(historyPrincipal(input), resolved);
          return boundedHistoryOutput(result);
        }).pipe(Effect.catch((error) => Effect.succeed(historyErrorOutput(error))));
      }
    }
  });

  const prune = (current: ExecutorState, now: number): ExecutorState => {
    const retained = [...current.calls.entries()].filter(([, call]) => {
      switch (call.type) {
        case "pending":
          return call.expiresAtMillis > now;
        case "completed":
          return now - call.completedAtMillis < 10 * 60_000;
        case "executing-read":
          return true;
      }
    });
    const executing = retained.filter(([, call]) => call.type === "executing-read");
    const settled = retained
      .filter(([, call]) => call.type !== "executing-read")
      .slice(-MAX_RETAINED_CALLS);
    const calls = new Map([...settled, ...executing]);
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
        call.sessionId !== input.sessionId ||
        call.contextEpoch !== input.contextEpoch ||
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
  ): VoiceToolExecutionResult => {
    if (
      isTerminalVoiceTool(call.toolName) &&
      call.status === "succeeded" &&
      call.resultOutput !== null
    ) {
      const persisted = decodePersistedTerminalResult(call.resultOutput);
      const expectedAction = terminalActionForVoiceTool(call.toolName);
      const expectedActionId = terminalActionId({ ...call, name: call.toolName });
      if (
        Option.isSome(persisted) &&
        persisted.value.terminalAction.action === expectedAction &&
        persisted.value.terminalAction.actionId === expectedActionId
      ) {
        return {
          type: "terminal-completed",
          toolCallId: call.toolCallId,
          providerFunctionCallId: call.providerFunctionCallId,
          tool: call.toolName,
          outcome: "succeeded",
          output: call.resultOutput,
          terminalAction: persisted.value.terminalAction,
        };
      }
      return {
        type: "completed",
        toolCallId: call.toolCallId,
        providerFunctionCallId: call.providerFunctionCallId,
        tool: call.toolName,
        outcome: "failed",
        output: jsonOutput({ error: "Persisted terminal action was invalid" }),
        submitOutput,
      };
    }
    return {
      type: "completed",
      toolCallId: call.toolCallId,
      providerFunctionCallId: call.providerFunctionCallId,
      tool: isVoiceToolName(call.toolName) ? call.toolName : "unknown",
      outcome:
        call.status === "requested" || call.status === "pending-confirmation"
          ? "failed"
          : call.status,
      output: call.resultOutput ?? jsonOutput({ error: "Voice tool result was unavailable" }),
      submitOutput,
    };
  };

  const pendingFromDurable = (
    call: DurableVoiceToolCall,
    authSessionId: VoiceToolCallInput["authSessionId"],
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
      if (isReadTool(tool)) {
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
        authSessionId,
        sessionId: call.sessionId,
        conversationId: call.conversationId,
        contextEpoch: call.contextEpoch,
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
    result: VoiceToolExecutionResult,
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
                    contextEpoch: input.contextEpoch,
                    toolCallId: input.toolCallId,
                    status: result.outcome,
                    resultOutput: durableResultOutput(input, result),
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
      const decodedRequestedTool = yield* decodeVoiceToolName(input.name).pipe(Effect.option);
      if (Option.isSome(decodedRequestedTool)) {
        const requestedTool = decodedRequestedTool.value;
        const access = VOICE_TOOL_ACCESS[requestedTool];
        let requiredScopes: ReadonlySet<AuthEnvironmentScope>;
        if (isHistoryToolName(requestedTool)) {
          const decodedScopes = yield* requiredHistoryScopes(input, requestedTool).pipe(
            Effect.option,
          );
          if (Option.isNone(decodedScopes)) {
            return completed(
              input,
              requestedTool,
              "failed",
              jsonOutput({
                error: { code: "invalid_arguments", retryable: false },
              }),
            );
          }
          requiredScopes = decodedScopes.value;
        } else {
          requiredScopes =
            access === "session"
              ? new Set()
              : new Set<AuthEnvironmentScope>([
                  access === "orchestration-read"
                    ? AuthOrchestrationReadScope
                    : AuthOrchestrationOperateScope,
                ]);
        }
        const missingScope = [...requiredScopes].find((scope) => !input.grantedScopes.has(scope));
        if (missingScope !== undefined) {
          return completed(
            input,
            requestedTool,
            "failed",
            access === "history-read"
              ? jsonOutput({
                  error: { code: "scope_required", retryable: false },
                })
              : jsonOutput({ error: `Voice tool requires ${missingScope}` }),
          );
        }
      }
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
      if (conversation.activeEpoch !== input.contextEpoch) {
        return yield* Effect.fail(
          voiceError(
            "invalid-phase",
            "tool.context-epoch",
            "Voice tool call belongs to an inactive conversation context",
          ),
        );
      }
      const claimed =
        conversation.retention === "durable"
          ? yield* toolCalls
              .createRequested({
                conversationId: input.conversationId,
                contextEpoch: input.contextEpoch,
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
                contextEpoch: input.contextEpoch,
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
      type InvokeAction =
        | {
            readonly action: "execute-read";
            readonly key: string;
            readonly tool: ReadVoiceTool;
            readonly completion: Deferred.Deferred<VoiceToolExecutionResult, VoiceError>;
          }
        | {
            readonly action: "await-read";
            readonly completion: Deferred.Deferred<VoiceToolExecutionResult, VoiceError>;
          };

      const resolution = yield* SynchronizedRef.modifyEffect<
        ExecutorState,
        VoiceToolInvokeResult | InvokeAction,
        VoiceError,
        never
      >(state, (unpruned) => {
        const current = prune(unpruned, now);
        const key = callKey(input.conversationId, input.toolCallId);
        const existing = current.calls.get(key);
        if (existing?.type === "completed") {
          return Effect.succeed([
            existing.result.type === "completed"
              ? { ...existing.result, submitOutput: false }
              : existing.result,
            current,
          ] as const);
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
        if (existing?.type === "executing-read") {
          return Effect.succeed([
            {
              action: "await-read",
              completion: existing.completion,
            } satisfies InvokeAction,
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
            const pending = yield* pendingFromDurable(
              claimed.call,
              input.authSessionId,
              input.grantedScopes,
            );
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
          if (Option.isNone(decodedRequestedTool)) {
            yield* appendJournal(input, "requested");
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
          const tool = decodedRequestedTool.value;
          const readTool = isReadTool(tool);
          if (readTool) {
            const completion = yield* Deferred.make<VoiceToolExecutionResult, VoiceError>();
            return [
              {
                action: "execute-read",
                key,
                tool,
                completion,
              } satisfies InvokeAction,
              {
                ...current,
                calls: new Map(current.calls).set(key, {
                  type: "executing-read",
                  sessionId: input.sessionId,
                  completion,
                }),
              },
            ] as const;
          }

          yield* appendJournal(input, "requested");
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
          if (tool === "create_thread" || tool === "send_thread_message") {
            const result = yield* dispatcher.dispatch(prepared.value.command).pipe(
              Effect.match({
                onFailure: (cause) =>
                  completed(
                    input,
                    tool,
                    "failed",
                    jsonOutput({
                      error: cause instanceof Error ? cause.message : "T3 command dispatch failed",
                    }),
                  ),
                onSuccess: (receipt) =>
                  completed(
                    input,
                    tool,
                    "succeeded",
                    mutationOutput(prepared.value.command, receipt.sequence),
                  ),
              }),
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
          const confirmationId = VoiceConfirmationId.make(deterministicId("voice-confirm", input));
          const expiresAtMillis = now + CONFIRMATION_TTL_MILLIS;
          const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis));
          const pending: PendingCall = {
            type: "pending",
            authSessionId: input.authSessionId,
            sessionId: input.sessionId,
            conversationId: input.conversationId,
            contextEpoch: input.contextEpoch,
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
                contextEpoch: input.contextEpoch,
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

      if (!("action" in resolution)) return resolution;
      if (resolution.action === "await-read") {
        return yield* Deferred.await(resolution.completion).pipe(
          Effect.map((result) =>
            result.type === "completed" ? { ...result, submitOutput: false } : result,
          ),
        );
      }

      const execution = Effect.gen(function* () {
        yield* appendJournal(input, "requested");
        if (
          resolution.tool === "stop_realtime_voice" ||
          resolution.tool === "switch_to_thread_voice"
        ) {
          const result = yield* completeTerminalTool(input, resolution.tool).pipe(
            Effect.match({
              onFailure: (cause) =>
                completed(
                  input,
                  resolution.tool,
                  "failed",
                  jsonOutput({
                    error: cause instanceof Error ? cause.message : "Invalid tool arguments",
                  }),
                ),
              onSuccess: (result) => result,
            }),
          );
          yield* appendJournal(input, result.outcome, result.output);
          yield* persistCompleted(input, result, requestedAt);
          return result;
        }
        const output = yield* executeRead(input, resolution.tool).pipe(
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
        const result = completed(input, resolution.tool, outcome, output);
        yield* appendJournal(input, outcome, output);
        yield* persistCompleted(input, result, requestedAt);
        return result;
      });

      return yield* execution.pipe(
        Effect.onExit((exit) =>
          SynchronizedRef.update(state, (current) => {
            const active = current.calls.get(resolution.key);
            if (active?.type !== "executing-read" || active.completion !== resolution.completion) {
              return current;
            }
            const calls = new Map(current.calls);
            if (Exit.isSuccess(exit)) {
              calls.set(resolution.key, {
                type: "completed",
                sessionId: input.sessionId,
                result: exit.value,
                completedAtMillis: now,
              });
            } else {
              calls.delete(resolution.key);
            }
            return { ...current, calls };
          }).pipe(Effect.andThen(Deferred.done(resolution.completion, exit))),
        ),
      );
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
              const hydrated = yield* pendingFromDurable(
                durable.value,
                input.authSessionId,
                new Set(),
              );
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
            authSessionId: pending.authSessionId,
            sessionId: pending.sessionId,
            conversationId: pending.conversationId,
            contextEpoch: pending.contextEpoch,
            toolCallId: pending.toolCallId,
            providerFunctionCallId: pending.providerFunctionCallId,
            name: pending.tool,
            argumentsJson: "{}",
            grantedScopes: pending.grantedScopes,
            requestClientAction: () =>
              Effect.die("Confirmed mutations cannot request client actions"),
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
          authSessionId: pending.authSessionId,
          sessionId: pending.sessionId,
          conversationId: pending.conversationId,
          contextEpoch: pending.contextEpoch,
          toolCallId: pending.toolCallId,
          providerFunctionCallId: pending.providerFunctionCallId,
          name: pending.tool,
          argumentsJson: "{}",
          grantedScopes: pending.grantedScopes,
          requestClientAction: () => Effect.die("Expired mutations cannot request client actions"),
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
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      yield* toolCalls
        .terminalizeSession({
          sessionId,
          resultOutput: jsonOutput({
            error: "Voice session ended before the tool completed",
          }),
          updatedAt,
        })
        .pipe(
          persistenceFailure("tool.terminalize-session"),
          Effect.catch((error) =>
            Effect.logWarning("Failed to terminalize durable voice tool calls").pipe(
              Effect.annotateLogs({ sessionId, reason: error.reason }),
            ),
          ),
        );
      yield* SynchronizedRef.update(state, (current) => {
        const calls = new Map(
          [...current.calls.entries()].filter(([, call]) => call.sessionId !== sessionId),
        );
        const confirmations = new Map(
          [...current.confirmations.entries()].filter(([, key]) => calls.has(key)),
        );
        return { calls, confirmations };
      });
    });

  return VoiceToolExecutor.of({ invoke, decide, expire, discardSession });
});

export const VoiceToolExecutorLive = Layer.effect(VoiceToolExecutor, make);

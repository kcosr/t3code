// @effect-diagnostics nodeBuiltinImport:off
/**
 * PiAdapter lifecycle tests via the `makeRuntime` seam (no real Pi binary).
 * Uses @effect/vitest so every test is supervised by the test runtime.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

import { afterEach, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProviderAdapterSessionNotFoundError, ProviderAdapterValidationError } from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type { PiSessionState } from "../pi/protocol.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import {
  type PiRuntimeNativeEvent,
  type PiSessionRuntimeOptions,
  type PiSessionRuntimeShape,
} from "./PiSessionRuntime.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const sessionDir = "/tmp/t3-pi-adapter-test-sessions";

const defaultSessionState = (spawnCwd: string): PiSessionState => ({
  sessionId: "pi-session-1",
  sessionFile: NodePath.join(spawnCwd, "sessions", "pi-session-1.jsonl"),
  model: { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
  thinkingLevel: "medium",
  isStreaming: false,
});

class FakePiRuntime implements PiSessionRuntimeShape {
  private readonly eventQueue: Queue.Queue<PiRuntimeNativeEvent>;
  private state: PiSessionState;

  public readonly startImpl = vi.fn(() => Promise.resolve(this.state));
  public readonly getStateImpl = vi.fn(() => Promise.resolve(this.state));
  public readonly promptImpl = vi.fn((_input: unknown) => Promise.resolve(undefined));
  public readonly abortImpl = vi.fn(() => Promise.resolve(undefined));
  public readonly setModelImpl = vi.fn((_provider: string, _modelId: string) =>
    Promise.resolve(undefined),
  );
  public readonly setThinkingLevelImpl = vi.fn((_level: string) => Promise.resolve(undefined));
  public readonly getAvailableModelsImpl = vi.fn(() => Promise.resolve([]));
  public readonly getMessagesImpl = vi.fn(() => Promise.resolve([]));
  public readonly getEntriesImpl = vi.fn(() =>
    Promise.resolve({
      entries: [] as Array<Record<string, unknown>>,
      leafId: null as string | null,
    }),
  );
  public readonly getForkMessagesImpl = vi.fn(() =>
    Promise.resolve([] as Array<{ entryId: string; text: string }>),
  );
  public readonly forkImpl = vi.fn((_entryId: string) =>
    Promise.resolve({ text: "", cancelled: false }),
  );
  public readonly respondExtensionUiImpl = vi.fn((_response: Record<string, unknown>) =>
    Promise.resolve(undefined),
  );
  public readonly commandImpl = vi.fn((_body: Record<string, unknown>) => Promise.resolve({}));
  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));
  public readonly buildResumeCursorImpl = vi.fn(() =>
    Promise.resolve({
      version: 1 as const,
      sessionId: this.state.sessionId ?? "pi-session-1",
      sessionPath: this.state.sessionFile ?? "/tmp/sessions/pi-session-1.jsonl",
      cwd: this.options.spawn.cwd,
    }),
  );

  readonly options: PiSessionRuntimeOptions;

  constructor(options: PiSessionRuntimeOptions, eventQueue: Queue.Queue<PiRuntimeNativeEvent>) {
    this.options = options;
    this.eventQueue = eventQueue;
    this.state = defaultSessionState(options.spawn.cwd);
    if (options.expectedSessionId) {
      this.state = { ...this.state, sessionId: options.expectedSessionId };
    }
    if (options.expectedSessionPath) {
      this.state = { ...this.state, sessionFile: options.expectedSessionPath };
    }
  }

  get pid() {
    return 42_001;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getState() {
    return Effect.promise(() => this.getStateImpl());
  }

  prompt(input: { readonly message: string; readonly images?: ReadonlyArray<unknown> }) {
    return Effect.promise(() => this.promptImpl(input));
  }

  abort() {
    return Effect.promise(() => this.abortImpl());
  }

  setModel(provider: string, modelId: string) {
    return Effect.promise(() => this.setModelImpl(provider, modelId));
  }

  setThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") {
    return Effect.promise(() => this.setThinkingLevelImpl(level));
  }

  getAvailableModels() {
    return Effect.promise(() => this.getAvailableModelsImpl());
  }

  getMessages() {
    return Effect.promise(() => this.getMessagesImpl());
  }

  getEntries() {
    return Effect.promise(() => this.getEntriesImpl());
  }

  getForkMessages() {
    return Effect.promise(() => this.getForkMessagesImpl());
  }

  fork(entryId: string) {
    return Effect.promise(() => this.forkImpl(entryId));
  }

  respondExtensionUi(response: Record<string, unknown>) {
    return Effect.promise(() => this.respondExtensionUiImpl(response));
  }

  command(body: Record<string, unknown>) {
    return Effect.promise(() => this.commandImpl(body));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  buildResumeCursor() {
    return Effect.promise(() => this.buildResumeCursorImpl());
  }

  emit(event: PiRuntimeNativeEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }

  endEvents() {
    return Queue.shutdown(this.eventQueue);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakePiRuntime> = [];
  const factory = vi.fn((options: PiSessionRuntimeOptions) =>
    Effect.gen(function* () {
      const eventQueue = yield* Queue.unbounded<PiRuntimeNativeEvent>();
      const runtime = new FakePiRuntime(options, eventQueue);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    get lastRuntime(): FakePiRuntime | undefined {
      return runtimes.at(-1);
    },
    clear() {
      runtimes.length = 0;
      factory.mockClear();
    },
  };
}

const envLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function collectUntil(
  adapter: PiAdapterShape,
  predicate: (event: ProviderRuntimeEvent) => boolean,
) {
  return Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const done = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (predicate(event)) {
          yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
        }
      }),
    ).pipe(Effect.forkChild);
    // Let the PubSub subscription attach before publishers run (fork alone is not enough).
    yield* Effect.yieldNow;
    yield* Effect.sleep("10 millis");
    return {
      events,
      await: Deferred.await(done).pipe(Effect.timeout("5 seconds")),
      interrupt: Fiber.interrupt(fiber).pipe(Effect.ignore),
    };
  });
}

function withAdapter<A, E>(
  runtimeFactory: ReturnType<typeof makeRuntimeFactory>,
  body: (
    adapter: PiAdapterShape,
    runtimeFactory: ReturnType<typeof makeRuntimeFactory>,
  ) => Effect.Effect<A, E>,
  settings: Record<string, unknown> = {},
): Effect.Effect<A> {
  return Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        decodePiSettings({
          binaryPath: "pi",
          sessionDir,
          projectTrust: "inherit",
          ...settings,
        }),
        { makeRuntime: runtimeFactory.factory },
      );
      return yield* body(adapter, runtimeFactory);
    }),
  ).pipe(Effect.provide(envLayer), Effect.orDie);
}

describe("PiAdapterLive validation", () => {
  it.live("rejects non full-access runtime modes", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("piAgent"),
            threadId: asThreadId("thread-sandbox"),
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);

        NodeAssert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        NodeAssert.equal(result.failure._tag, "ProviderAdapterValidationError");
        NodeAssert.match(result.failure.message, /full-access/i);
        NodeAssert.equal(runtimeFactory.factory.mock.calls.length, 0);
      }),
    );
  });

  it.live("requires a working directory", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("piAgent"),
            threadId: asThreadId("thread-no-cwd"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.result);

        NodeAssert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        NodeAssert.deepStrictEqual(
          result.failure,
          new ProviderAdapterValidationError({
            provider: ProviderDriverKind.make("piAgent"),
            operation: "startSession",
            issue: "Pi sessions require a working directory (cwd).",
          }),
        );
      }),
    );
  });

  it.live("rejects explicit approvalPolicy and sandboxMode", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("piAgent"),
            threadId: asThreadId("thread-policy"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            approvalPolicy: "never",
          })
          .pipe(Effect.result);

        NodeAssert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        NodeAssert.equal(result.failure._tag, "ProviderAdapterValidationError");
        NodeAssert.match(result.failure.message, /approvalPolicy|sandboxMode|full-access/i);
      }),
    );
  });

  it.live("rejects resume session paths outside the configured session directory", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("piAgent"),
            threadId: asThreadId("thread-resume-outside"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: {
              version: 1,
              sessionId: "resume-1",
              sessionPath: "/etc/passwd",
              cwd: process.cwd(),
            },
          })
          .pipe(Effect.result);

        NodeAssert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        NodeAssert.deepStrictEqual(
          result.failure,
          new ProviderAdapterValidationError({
            provider: ProviderDriverKind.make("piAgent"),
            operation: "startSession",
            issue: "Pi resume session path is outside the configured session directory.",
          }),
        );
        NodeAssert.equal(runtimeFactory.factory.mock.calls.length, 0);
      }),
    );
  });

  it.live("maps missing sessions to ProviderAdapterSessionNotFoundError", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .sendTurn({
            threadId: asThreadId("missing-session"),
            input: "hello",
            attachments: [],
          })
          .pipe(Effect.result);

        NodeAssert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        NodeAssert.deepStrictEqual(
          result.failure,
          new ProviderAdapterSessionNotFoundError({
            provider: ProviderDriverKind.make("piAgent"),
            threadId: asThreadId("missing-session"),
          }),
        );
      }),
    );
  });
});

describe("PiAdapterLive lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.live("starts a session, emits lifecycle events, and exposes resume cursor", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-start");
        const collector = yield* collectUntil(
          adapter,
          (event) => event.type === "thread.started" && event.threadId === threadId,
        );

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("piAgent"),
            "anthropic/claude-sonnet-4",
            [{ id: "thinkingLevel", value: "high" }],
          ),
        });

        yield* collector.await;
        yield* collector.interrupt;

        NodeAssert.equal(session.provider, "piAgent");
        NodeAssert.equal(session.status, "ready");
        NodeAssert.equal(session.model, "anthropic/claude-sonnet-4");
        NodeAssert.ok(session.resumeCursor);
        NodeAssert.equal(
          (session.resumeCursor as { sessionId?: string }).sessionId,
          "pi-session-1",
        );

        const types = new Set(collector.events.map((event) => event.type));
        NodeAssert.ok(types.has("session.started"));
        NodeAssert.ok(types.has("thread.started"));

        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        NodeAssert.equal(runtime.setThinkingLevelImpl.mock.calls[0]?.[0], "high");
        NodeAssert.equal(runtimeFactory.factory.mock.calls[0]?.[0].spawn.sessionId, "thread-start");

        yield* adapter.stopSession(threadId);
      }),
    );
  });

  it.live("accepts resume cursors whose session path is inside sessionDir", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-resume-inside");
        const sessionPath = NodePath.join(sessionDir, "nested", "resume.jsonl");

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: {
            version: 1,
            sessionId: "resume-inside",
            sessionPath,
            cwd: process.cwd(),
          },
        });

        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        NodeAssert.equal(runtime.options.spawn.sessionPath, sessionPath);
        NodeAssert.equal(runtime.options.expectedSessionId, "resume-inside");
        NodeAssert.equal(runtime.options.expectedSessionPath, sessionPath);
        NodeAssert.equal(
          (session.resumeCursor as { sessionId?: string }).sessionId,
          "resume-inside",
        );

        yield* adapter.stopSession(threadId);
      }),
    );
  });

  it.live("maps prompt + native message events through a full turn", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-turn");

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);

        const collector = yield* collectUntil(
          adapter,
          (event) => event.type === "turn.completed" && event.threadId === threadId,
        );

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello pi",
          attachments: [],
        });
        NodeAssert.ok(turn.turnId);

        yield* runtime.emit({
          type: "message_start",
          message: { role: "assistant" },
        });
        yield* runtime.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        });
        yield* runtime.emit({ type: "message_end" });
        yield* runtime.emit({ type: "agent_end" });

        yield* collector.await;
        yield* collector.interrupt;

        const types = new Set(collector.events.map((event) => event.type));
        NodeAssert.ok(types.has("turn.started"));
        NodeAssert.ok(types.has("item.started"));
        NodeAssert.ok(types.has("content.delta"));
        NodeAssert.ok(types.has("item.completed"));
        NodeAssert.ok(types.has("turn.completed"));

        const delta = collector.events.find((event) => event.type === "content.delta");
        NodeAssert.ok(delta);
        if (delta?.type === "content.delta") {
          NodeAssert.equal(delta.payload.delta, "hi");
          NodeAssert.equal(delta.payload.streamKind, "assistant_text");
        }

        const completed = collector.events.find((event) => event.type === "turn.completed");
        NodeAssert.ok(completed);
        if (completed?.type === "turn.completed") {
          NodeAssert.equal(completed.payload.state, "completed");
          NodeAssert.equal(completed.turnId, turn.turnId);
        }

        NodeAssert.deepStrictEqual(runtime.promptImpl.mock.calls[0]?.[0], {
          message: "hello pi",
        });

        yield* adapter.stopSession(threadId);
      }),
    );
  });

  it.live("correlates compaction_start and compaction_end with the same itemId", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-compaction");

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);

        const collector = yield* collectUntil(
          adapter,
          (event) =>
            event.type === "item.completed" &&
            event.threadId === threadId &&
            event.payload.itemType === "context_compaction",
        );

        yield* runtime.emit({ type: "compaction_start", reason: "token budget" });
        yield* runtime.emit({ type: "compaction_end", result: { ok: true } });

        yield* collector.await;
        yield* collector.interrupt;

        const started = collector.events.find(
          (event) =>
            event.type === "item.started" && event.payload.itemType === "context_compaction",
        );
        const completed = collector.events.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "context_compaction",
        );
        NodeAssert.ok(started);
        NodeAssert.ok(completed);
        NodeAssert.equal(started?.itemId, completed?.itemId);
        NodeAssert.ok(String(started?.itemId ?? "").startsWith("pi-compact-"));
        if (started?.type === "item.started") {
          NodeAssert.equal(started.payload.detail, "token budget");
        }

        yield* adapter.stopSession(threadId);
      }),
    );
  });

  it.live("tears down on process_exit without hanging (session.exited + close + drop)", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-process-exit");
        const collector = yield* collectUntil(
          adapter,
          (event) => event.type === "session.exited" && event.threadId === threadId,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        NodeAssert.equal(yield* adapter.hasSession(threadId), true);

        yield* runtime.emit({
          type: "t3.pi.process_exit",
          detail: "Pi process exited unexpectedly (code 1)",
        });

        // Wait for map removal (stopContext runs on the event pump fiber).
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (!(yield* adapter.hasSession(threadId))) break;
          yield* Effect.sleep("10 millis");
        }
        yield* runtime.endEvents();
        yield* collector.await.pipe(Effect.ignore);
        yield* collector.interrupt;

        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
        NodeAssert.ok(runtime.closeImpl.mock.calls.length >= 1);

        const exited = collector.events.find((event) => event.type === "session.exited");
        NodeAssert.ok(exited, "expected session.exited runtime event");
        if (exited?.type === "session.exited") {
          NodeAssert.equal(exited.payload.recoverable, true);
          NodeAssert.equal(exited.payload.exitKind, "error");
          const reason = exited.payload.reason;
          NodeAssert.ok(reason);
          NodeAssert.match(reason, /exited unexpectedly/);
        }

        const stopResult = yield* adapter.stopSession(threadId).pipe(Effect.result);
        NodeAssert.equal(stopResult._tag, "Failure");
        if (stopResult._tag === "Failure") {
          NodeAssert.equal(stopResult.failure._tag, "ProviderAdapterSessionNotFoundError");
        }
      }),
    );
  });

  it.live("interrupts an active turn on process_exit before session.exited", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-exit-mid-turn");
        const collector = yield* collectUntil(
          adapter,
          (event) => event.type === "session.exited" && event.threadId === threadId,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);

        yield* adapter.sendTurn({
          threadId,
          input: "still working",
          attachments: [],
        });

        yield* runtime.emit({
          type: "t3.pi.process_exit",
          detail: "Pi process crashed",
        });

        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (!(yield* adapter.hasSession(threadId))) break;
          yield* Effect.sleep("10 millis");
        }
        yield* runtime.endEvents();
        yield* collector.await.pipe(Effect.ignore);
        yield* collector.interrupt;

        const types = collector.events.map((event) => event.type);
        const turnCompletedIndex = types.indexOf("turn.completed");
        const sessionExitedIndex = types.indexOf("session.exited");
        NodeAssert.ok(turnCompletedIndex >= 0, "expected turn.completed");
        NodeAssert.ok(sessionExitedIndex >= 0, "expected session.exited");
        NodeAssert.ok(turnCompletedIndex < sessionExitedIndex);

        const turnCompleted = collector.events[turnCompletedIndex];
        if (turnCompleted?.type === "turn.completed") {
          NodeAssert.equal(turnCompleted.payload.state, "interrupted");
        }

        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      }),
    );
  });

  it.live("stopSession closes the runtime and removes the session", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-stop");

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        NodeAssert.equal(yield* adapter.hasSession(threadId), true);

        yield* adapter.stopSession(threadId);

        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
        NodeAssert.ok(runtime.closeImpl.mock.calls.length >= 1);
        NodeAssert.deepStrictEqual(yield* adapter.listSessions(), []);
      }),
    );
  });

  it.live("applies idle model selection on sendTurn when instance matches", () => {
    const runtimeFactory = makeRuntimeFactory();
    return withAdapter(runtimeFactory, (adapter) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-model");

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("piAgent"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        runtime.setModelImpl.mockClear();
        runtime.setThinkingLevelImpl.mockClear();
        // Dummy Pi model slug for in-session switch only (not a Keel/reviewer model).
        // Must differ from the session's current model or setModel is skipped.
        runtime.getStateImpl.mockImplementation(() =>
          Promise.resolve({
            ...defaultSessionState(process.cwd()),
            model: {
              provider: "google",
              id: "gemini-2.5-pro",
              reasoning: true,
              thinkingLevelMap: { off: 0, low: 1, medium: 2, high: 3 },
            },
          }),
        );

        const collector = yield* collectUntil(
          adapter,
          (event) => event.type === "turn.started" && event.threadId === threadId,
        );

        yield* adapter.sendTurn({
          threadId,
          input: "switch model",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("piAgent"),
            "google/gemini-2.5-pro",
            [{ id: "thinkingLevel", value: "high" }],
          ),
          attachments: [],
        });

        yield* collector.await;
        yield* collector.interrupt;

        NodeAssert.deepStrictEqual(runtime.setModelImpl.mock.calls[0], [
          "google",
          "gemini-2.5-pro",
        ]);
        NodeAssert.equal(runtime.setThinkingLevelImpl.mock.calls.at(-1)?.[0], "high");

        yield* adapter.stopSession(threadId);
      }),
    );
  });
});

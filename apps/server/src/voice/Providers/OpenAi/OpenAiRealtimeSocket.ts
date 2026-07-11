import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { VoiceError } from "../../Errors.ts";

export type OpenAiRealtimeSocketEvent =
  | { readonly type: "message"; readonly data: string }
  | { readonly type: "error"; readonly cause: unknown }
  | { readonly type: "closed"; readonly code: number; readonly reason: string };

export interface OpenAiRealtimeSocketConnection {
  readonly events: Stream.Stream<OpenAiRealtimeSocketEvent>;
  readonly send: (data: string) => Effect.Effect<void, VoiceError>;
  readonly close: Effect.Effect<void>;
}

export interface OpenAiRealtimeSocketShape {
  readonly connect: (input: {
    readonly url: string;
    readonly apiKey: string;
  }) => Effect.Effect<OpenAiRealtimeSocketConnection, VoiceError, Scope.Scope>;
}

export class OpenAiRealtimeSocket extends Context.Service<
  OpenAiRealtimeSocket,
  OpenAiRealtimeSocketShape
>()("t3/voice/Providers/OpenAi/OpenAiRealtimeSocket") {}

const socketError = (operation: string, cause: unknown) =>
  new VoiceError({
    reason: "provider-unavailable",
    operation,
    detail: "OpenAI Realtime sideband failed",
    retryable: true,
    cause,
  });

const connect: OpenAiRealtimeSocketShape["connect"] = Effect.fn("OpenAiRealtimeSocket.connect")(
  function* (input) {
    const events = yield* Queue.unbounded<OpenAiRealtimeSocketEvent>();
    const socket = yield* Effect.acquireRelease(
      Effect.callback<NodeWS.WebSocket, VoiceError>((resume) => {
        const ws = new NodeWS.WebSocket(input.url, {
          headers: { Authorization: `Bearer ${input.apiKey}` },
        });
        const onOpen = () => {
          ws.off("error", onOpenError);
          resume(Effect.succeed(ws));
        };
        const onOpenError = (cause: Error) => {
          ws.off("open", onOpen);
          resume(Effect.fail(socketError("openai.realtime.sideband.open", cause)));
        };
        ws.once("open", onOpen);
        ws.once("error", onOpenError);
        return Effect.sync(() => {
          ws.off("open", onOpen);
          ws.off("error", onOpenError);
          if (ws.readyState === NodeWS.WebSocket.CONNECTING) ws.terminate();
        });
      }),
      (ws) =>
        Effect.sync(() => {
          if (
            ws.readyState === NodeWS.WebSocket.OPEN ||
            ws.readyState === NodeWS.WebSocket.CONNECTING
          ) {
            ws.close(1000, "T3 voice session closed");
          }
        }),
    );

    const publish = (event: OpenAiRealtimeSocketEvent) => void Queue.offerUnsafe(events, event);
    socket.on("message", (data) => publish({ type: "message", data: data.toString() }));
    socket.on("error", (cause) => publish({ type: "error", cause }));
    socket.on("close", (code, reason) =>
      publish({ type: "closed", code, reason: reason.toString() }),
    );

    yield* Scope.addFinalizer(
      yield* Effect.scope,
      Effect.sync(() => {
        socket.removeAllListeners();
      }),
    );

    return {
      events: Stream.fromQueue(events).pipe(Stream.takeUntil((event) => event.type === "closed")),
      send: (data) =>
        Effect.try({
          try: () => socket.send(data),
          catch: (cause) => socketError("openai.realtime.sideband.send", cause),
        }),
      close: Effect.sync(() => {
        if (socket.readyState === NodeWS.WebSocket.OPEN) {
          socket.close(1000, "T3 voice session closed");
        }
      }),
    } satisfies OpenAiRealtimeSocketConnection;
  },
);

export const OpenAiRealtimeSocketLive = Layer.succeed(OpenAiRealtimeSocket, { connect });

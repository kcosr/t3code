// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - HTTP integration exercises the Node boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceConversationId,
  VoiceModeSessionId,
  VoiceSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { voiceRealtimeControlRoutesLayer } from "./realtimeControlHttp.ts";
import { VoiceRealtimeControlService } from "./Services/VoiceRealtimeControlService.ts";

const sessionId = VoiceSessionId.make("session-http");
const state = {
  sessionId,
  conversationId: VoiceConversationId.make("conversation-http"),
  mode: "realtime-agent" as const,
  phase: "listening" as const,
  leaseGeneration: 9,
  sequence: 0,
};
const fence = {
  runtimeId: "runtime-http",
  runtimeInstanceId: "instance-http",
  generation: 2,
  modeSessionId: "mode-http",
  leaseGeneration: 9,
};

const withServer = (run: (baseUrl: string) => Promise<void>) => {
  const service = Layer.mock(VoiceRealtimeControlService)({
    create: () =>
      Effect.succeed({
        state,
        transport: {
          kind: "webrtc-sdp-v1" as const,
          signalingPath: `/api/voice/runtime/realtime-sessions/${sessionId}/webrtc-offer`,
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
        heartbeatIntervalSeconds: 10,
        controlGrant: {
          token: "control-token",
          sessionId,
          leaseGeneration: 9,
          expiresAt: "2099-01-01T00:00:00.000Z",
          heartbeatIntervalSeconds: 10,
          failureGraceSeconds: 30,
        },
      }),
    offer: () => Effect.succeed({ sessionId, leaseGeneration: 9, sdp: "answer", replayed: false }),
    heartbeat: () =>
      Effect.succeed({
        state,
        disposition: "live" as const,
        handoffPending: false,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    actions: () => Effect.succeed({ state, actions: [] }),
    acknowledgeAction: (_token, _sessionId, actionId, input) =>
      Effect.succeed({
        actionId,
        actionSequence: input.actionSequence,
        outcome: input.action === "navigate-thread" ? input.outcome : "succeeded",
        replayed: false,
      }),
    updateFocus: (_token, _sessionId, input) =>
      Effect.succeed({ state, focus: input.focus, replayed: false }),
    exchangeHandoff: (_token, _sessionId, actionId, input) =>
      Effect.succeed({
        actionId,
        actionSequence: input.actionSequence,
        projectId: ProjectId.make("project-http"),
        threadId: ThreadId.make("thread-http"),
        autoRearm: true,
        transitionGrant: {
          token: "transition-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
          generation: input.nextGeneration,
          modeSessionId: input.threadModeSessionId,
          target: {
            mode: "thread" as const,
            environmentId: input.environmentId,
            projectId: ProjectId.make("project-http"),
            threadId: ThreadId.make("thread-http"),
            speechPreset: input.speechPreset,
            autoRearm: true,
            endpointPolicy: input.endpointPolicy,
            speechEnabled: input.speechEnabled,
            rearmGuardMs: input.rearmGuardMs,
          },
        },
        replayed: false,
      }),
    commitHandoff: (_token, _sessionId, actionId, input) =>
      Effect.succeed({
        actionId,
        actionSequence: input.actionSequence,
        committed: true as const,
        replayed: false,
      }),
    close: () =>
      Effect.succeed({ state: { ...state, phase: "ended" }, closed: true, replayed: false }),
  });
  const serverLayer = HttpRouter.serve(voiceRealtimeControlRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(service),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) throw new Error("Missing port");
      yield* Effect.promise(() => run(`http://127.0.0.1:${address.port}`));
    }).pipe(Effect.provide(serverLayer)),
  );
};

const post = (baseUrl: string, path: string, body: unknown, runtime = false) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-t3-voice-runtime-protocol-major": "1",
      [runtime ? "x-t3-voice-runtime" : "x-t3-voice-control"]: runtime
        ? "runtime-token"
        : "control-token",
    },
    body: JSON.stringify(body),
  });

describe("Realtime runtime HTTP", () => {
  it.effect("exposes only the canonical Realtime route family", () =>
    withServer(async (baseUrl) => {
      const created = await post(
        baseUrl,
        "/api/voice/runtime/realtime-sessions",
        {
          runtimeId: fence.runtimeId,
          runtimeInstanceId: fence.runtimeInstanceId,
          generation: fence.generation,
          modeSessionId: fence.modeSessionId,
          clientOperationId: "start-http",
        },
        true,
      );
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({
        transport: {
          signalingPath: `/api/voice/runtime/realtime-sessions/${sessionId}/webrtc-offer`,
        },
      });
      const offer = await post(
        baseUrl,
        `/api/voice/runtime/realtime-sessions/${sessionId}/webrtc-offer`,
        { ...fence, clientOperationId: "offer-http", sdp: "offer" },
      );
      expect(offer.status).toBe(200);
      const heartbeat = await post(
        baseUrl,
        `/api/voice/runtime/realtime-sessions/${sessionId}/heartbeat`,
        fence,
      );
      expect(heartbeat.status).toBe(200);
      const actions = await fetch(
        `${baseUrl}/api/voice/runtime/realtime-sessions/${sessionId}/actions?${new URLSearchParams({
          ...Object.fromEntries(Object.entries(fence).map(([key, value]) => [key, String(value)])),
          afterSequence: "0",
          waitMilliseconds: "0",
        })}`,
        {
          headers: {
            "x-t3-voice-control": "control-token",
            "x-t3-voice-runtime-protocol-major": "1",
          },
        },
      );
      expect(actions.status).toBe(200);
      const acknowledged = await post(
        baseUrl,
        `/api/voice/runtime/realtime-sessions/${sessionId}/actions/action-http/ack`,
        {
          ...fence,
          clientOperationId: "ack-http",
          actionSequence: 1,
          action: "navigate-thread",
          outcome: "succeeded",
        },
      );
      expect(acknowledged.status).toBe(200);
      const focus = await fetch(
        `${baseUrl}/api/voice/runtime/realtime-sessions/${sessionId}/focus`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-t3-voice-control": "control-token",
            "x-t3-voice-runtime-protocol-major": "1",
          },
          body: JSON.stringify({ ...fence, clientOperationId: "focus-http", focus: null }),
        },
      );
      expect(focus.status).toBe(200);
      const handoff = await post(
        baseUrl,
        `/api/voice/runtime/realtime-sessions/${sessionId}/handoffs/handoff-http/exchange`,
        {
          ...fence,
          clientOperationId: "handoff-http",
          actionSequence: 2,
          nextGeneration: 3,
          threadModeSessionId: VoiceModeSessionId.make("thread-mode-http"),
          environmentId: EnvironmentId.make("environment-http"),
          speechPreset: "default",
          endpointPolicy: {
            endSilenceMs: 2_200,
            noSpeechTimeoutMs: null,
            maximumUtteranceMs: 600_000,
          },
          speechEnabled: true,
          rearmGuardMs: 500,
        },
      );
      expect(handoff.status).toBe(200);
      const committed = await fetch(
        `${baseUrl}/api/voice/runtime/realtime-sessions/${sessionId}/handoffs/handoff-http/commit`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-t3-voice-transition": "transition-token",
            "x-t3-voice-runtime-protocol-major": "1",
          },
          body: JSON.stringify({
            ...fence,
            actionSequence: 2,
            nextGeneration: 3,
            threadModeSessionId: VoiceModeSessionId.make("thread-mode-http"),
          }),
        },
      );
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({ committed: true, replayed: false });
      const close = await post(baseUrl, `/api/voice/runtime/realtime-sessions/${sessionId}/close`, {
        ...fence,
        clientOperationId: "close-http",
      });
      expect(close.status).toBe(200);

      const incompatible = await fetch(
        `${baseUrl}/api/voice/runtime/realtime-sessions/${sessionId}/actions?${new URLSearchParams({
          ...Object.fromEntries(Object.entries(fence).map(([key, value]) => [key, String(value)])),
          afterSequence: "0",
          waitMilliseconds: "0",
        })}`,
        { headers: { "x-t3-voice-control": "control-token" } },
      );
      expect(incompatible.status).toBe(426);
      expect(await incompatible.json()).toEqual({
        code: "voice_runtime_protocol_incompatible",
        requiredMajor: 1,
      });

      for (const legacy of [
        "/api/voice/native/realtime-sessions",
        `/api/voice/native/realtime-sessions/${sessionId}/webrtc-offer`,
        `/api/voice/native/realtime-sessions/${sessionId}/close`,
        `/api/voice/sessions/${sessionId}/native-heartbeat`,
        "/api/voice/native/handoff-actions",
        "/api/voice/native/handoff-actions/action-http/ack",
      ]) {
        const rejected = await fetch(`${baseUrl}${legacy}`, { method: "POST" });
        expect(rejected.status).toBe(404);
      }
    }),
  );
});

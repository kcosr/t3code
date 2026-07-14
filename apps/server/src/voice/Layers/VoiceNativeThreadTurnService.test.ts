// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceNativeRuntimeId,
  VoiceNativeRuntimeTarget,
  VoiceModeSessionId,
  VoiceRuntimeInstanceId,
  VoiceRuntimeId,
  VoiceSpeechPlanId,
  VoiceTurnClientOperationId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ClientCommandDispatcher } from "../../orchestration/Services/ClientCommandDispatcher.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VoiceNativeThreadTurnStoreLive } from "../../persistence/Layers/VoiceNativeThreadTurns.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnStartRepository } from "../../persistence/Services/ProjectionTurnStarts.ts";
import { VoiceNativeThreadTurnStore } from "../../persistence/Services/VoiceNativeThreadTurns.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import type { VoiceProviderAdapter } from "../Services/VoiceProvider.ts";
import { VoiceMediaRequestLimiterLive } from "../Services/VoiceMediaPolicy.ts";
import { VoiceNativeRuntimeGrantRegistry } from "../Services/VoiceNativeRuntimeGrantRegistry.ts";
import { VoiceNativeThreadTurnService } from "../Services/VoiceNativeThreadTurnService.ts";
import { voiceProviderRegistryLayer } from "../Services/VoiceProviderRegistry.ts";
import { VoiceNativeThreadTurnServiceLive } from "./VoiceNativeThreadTurnService.ts";

const authSessionId = AuthSessionId.make("native-thread-service-auth");
const runtimeId = VoiceNativeRuntimeId.make("native-thread-service-runtime");
const runtimeInstanceId = VoiceRuntimeInstanceId.make("native-thread-service-instance");
const projectId = ProjectId.make("native-thread-service-project");
const environmentId = EnvironmentId.make("native-thread-service-environment");
const threadId = ThreadId.make("native-thread-service-thread");
const runtimeToken = "runtime-token";
const encodeRuntimeTarget = Schema.encodeSync(Schema.fromJsonString(VoiceNativeRuntimeTarget));
const fixture = NodeFS.readFileSync(
  new URL("../Services/fixtures/silence-aac-lc-mono.m4a", import.meta.url),
);

const thread: OrchestrationThreadShell = {
  id: threadId,
  projectId,
  title: "Native thread service",
  modelSelection: {
    instanceId: ProviderInstanceId.make("test-provider"),
    model: "test-model",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-07-13T12:00:00.000Z",
  updatedAt: "2026-07-13T12:00:00.000Z",
  archivedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const makeTestLayer = Effect.fn("test.makeNativeThreadTurnServiceLayer")(function* (
  transcription: "never" | "defect" | "success",
) {
  const transcriptionStarted = yield* Deferred.make<void>();
  const provider: VoiceProviderAdapter = {
    id: "fake",
    capabilities: new Set(["transcription.request"]),
    transcriber: {
      transcribe: (request) => {
        const afterStarted = <A, E>(stream: Stream.Stream<A, E>) =>
          Stream.unwrap(Deferred.succeed(transcriptionStarted, undefined).pipe(Effect.as(stream)));
        if (transcription === "never") return afterStarted(Stream.never);
        if (transcription === "defect") return afterStarted(Stream.die("transcriber defect"));
        return afterStarted(
          Stream.make({
            type: "final" as const,
            result: {
              requestId: request.requestId,
              text: "service transcript",
            },
          }),
        );
      },
    },
  };
  const sqlite = NodeSqliteClient.layerMemory();
  const store = VoiceNativeThreadTurnStoreLive.pipe(Layer.provide(sqlite));
  const dependencies = Layer.mergeAll(
    sqlite,
    store,
    serverSettingsLayerTest({ voice: { enabled: true } }),
    VoiceMediaRequestLimiterLive,
    voiceProviderRegistryLayer([provider], new Map([["transcription.request", "fake"]])),
    Layer.succeed(ServerSecretStore, {
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
    } as unknown as ServerSecretStore["Service"]),
    Layer.succeed(
      VoiceNativeRuntimeGrantRegistry,
      VoiceNativeRuntimeGrantRegistry.of({
        issue: () => Effect.die("unused"),
        activateTransition: () => Effect.die("unused"),
        authorize: (token) =>
          Effect.succeed(
            token === runtimeToken
              ? {
                  authSessionId,
                  runtimeId,
                  generation: 1,
                  grantedScopes: new Set(),
                  target: {
                    mode: "thread" as const,
                    environmentId,
                    projectId,
                    threadId,
                    speechPreset: "default" as const,
                    autoRearm: true,
                    endpointPolicy: {
                      endSilenceMs: 2_200,
                      noSpeechTimeoutMs: null,
                      maximumUtteranceMs: 120_000,
                    },
                    speechEnabled: true,
                    rearmGuardMs: 500,
                  },
                  expiresAt: 60_000,
                }
              : undefined,
          ),
        revokeRuntime: () => Effect.succeed(true),
        revokeAuthSession: () => Effect.void,
      }),
    ),
    Layer.succeed(ProjectionSnapshotQuery, {
      getThreadShellById: (id: ThreadId) =>
        Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Layer.succeed(ProjectionThreadMessageRepository, {
      getByMessageId: (_input: { readonly messageId: MessageId }) => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
    } as unknown as ProjectionThreadMessageRepository["Service"]),
    Layer.succeed(ProjectionTurnStartRepository, {
      getOutcomeByMessageId: () => Effect.die("monitor projection defect"),
    } as unknown as ProjectionTurnStartRepository["Service"]),
    Layer.succeed(
      ClientCommandDispatcher,
      ClientCommandDispatcher.of({
        dispatch: () => Effect.succeed({ sequence: 1 }),
      }),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return {
    layer: VoiceNativeThreadTurnServiceLive.pipe(Layer.provideMerge(dependencies)),
    transcriptionStarted,
  };
});

const initialize = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 47 });
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO auth_sessions (
    session_id, subject, scopes, method, client_device_type, issued_at, expires_at
  ) VALUES (
    ${authSessionId}, 'native-thread-service-test', '[]', 'bearer-access-token', 'mobile',
    '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
  )`;
  yield* sql`INSERT INTO voice_native_runtime_grants (
    token_hash, runtime_id, generation, auth_session_id, granted_scopes_json,
    target_json, expires_at, created_at
  ) VALUES (
    'runtime-hash', ${runtimeId}, 1, ${authSessionId}, '[]',
    ${encodeRuntimeTarget({
      mode: "thread",
      environmentId,
      projectId,
      threadId,
      speechPreset: "default",
      autoRearm: true,
      endpointPolicy: {
        endSilenceMs: 2_200,
        noSpeechTimeoutMs: null,
        maximumUtteranceMs: 120_000,
      },
      speechEnabled: true,
      rearmGuardMs: 500,
    })},
    ${now + 60_000}, ${now}
  )`;
});

const create = (
  clientOperationId: string,
  submissionPolicy: "auto-submit" | "draft" = "auto-submit",
) =>
  Effect.gen(function* () {
    const service = yield* VoiceNativeThreadTurnService;
    return yield* service.create(runtimeToken, {
      runtimeId: VoiceRuntimeId.make(runtimeId),
      runtimeInstanceId,
      generation: 1,
      modeSessionId: VoiceModeSessionId.make("service-mode"),
      turnClientOperationId: VoiceTurnClientOperationId.make(clientOperationId),
      submissionPolicy,
      speechPlanId: VoiceSpeechPlanId.make(`speech-plan:${clientOperationId}`),
    });
  });

describe.sequential("VoiceNativeThreadTurnService", () => {
  it.effect("returns one stable child grant for an idempotent create replay", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("never");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const store = yield* VoiceNativeThreadTurnStore;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* create("event-auth");
        const replay = yield* create("event-auth");

        expect(replay.snapshot.operationId).toBe(first.snapshot.operationId);
        expect(replay.operationGrant.token).toBe(first.operationGrant.token);
        expect(
          yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
            FROM voice_native_thread_turn_operations
            WHERE operation_id = ${first.snapshot.operationId}`,
        ).toEqual([{ count: 1 }]);

        expect(
          (yield* service.events(replay.operationGrant.token, replay.snapshot.operationId, {
            afterSequence: 0,
            waitMilliseconds: 0,
          })).events.map((event) => event.sequence),
        ).toEqual([1]);
        expect(
          yield* service.acknowledgeEvents(first.operationGrant.token, first.snapshot.operationId, {
            acknowledgedSequence: 1,
            speechPlanId: first.snapshot.speechPlanId,
            highestStartedSegment: null,
            highestDrainedSegment: null,
            segmentDispositions: [],
          }),
        ).toMatchObject({ acknowledgedSequence: 1 });
        expect(yield* store.get(first.snapshot.operationId)).toMatchObject({
          phase: "created",
        });
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("maps revoked runtime authority at both authorization and transactional claim", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("never");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        expect(
          (yield* service
            .create("unknown-runtime-token", {
              runtimeId: VoiceRuntimeId.make(runtimeId),
              runtimeInstanceId,
              generation: 1,
              modeSessionId: VoiceModeSessionId.make("unknown-mode"),
              turnClientOperationId: VoiceTurnClientOperationId.make("unknown-runtime"),
              submissionPolicy: "auto-submit",
              speechPlanId: VoiceSpeechPlanId.make("unknown-speech-plan"),
            })
            .pipe(Effect.flip)).reason,
        ).toBe("authorization-revoked");

        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM voice_native_runtime_grants
          WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;
        expect((yield* create("revoked-at-claim").pipe(Effect.flip)).reason).toBe(
          "authorization-revoked",
        );
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("preserves event-page consistency while a writer advances the stream", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("never");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const store = yield* VoiceNativeThreadTurnStore;
        const operation = yield* create("concurrent-event-page");
        for (let index = 0; index < 10; index += 1) {
          const before = yield* store.get(operation.snapshot.operationId);
          const afterSequence = before?.lastSequence ?? 0;
          const [response] = yield* Effect.all(
            [
              service.events(operation.operationGrant.token, operation.snapshot.operationId, {
                afterSequence,
                waitMilliseconds: 0,
              }),
              store.appendEvent(operation.snapshot.operationId, {
                type: "phase",
                occurredAt: `2026-07-13T12:00:00.${String(index).padStart(3, "0")}Z`,
                phase: "transcribing",
              }),
            ],
            { concurrency: "unbounded" },
          );
          if (response.snapshot.lastSequence > afterSequence)
            expect(response.events).not.toHaveLength(0);
          expect(response.events.at(-1)?.sequence ?? afterSequence).toBe(
            response.snapshot.lastSequence,
          );
        }
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("reports an accepted dispatch as non-cancellable", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("never");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const store = yield* VoiceNativeThreadTurnStore;
        const operation = yield* create("dispatch-cancel");
        const tokenHash = NodeCrypto.createHash("sha256")
          .update(operation.operationGrant.token)
          .digest("hex");
        const now = yield* Clock.currentTimeMillis;
        expect(
          yield* store.claimProcessing(
            operation.snapshot.operationId,
            tokenHash,
            "dispatch-lease",
            now,
            now + 1_000,
            "2026-07-13T12:00:00.000Z",
          ),
        ).toBe(true);
        yield* store.appendEvent(
          operation.snapshot.operationId,
          {
            type: "phase",
            occurredAt: "2026-07-13T12:00:00.000Z",
            phase: "transcribing",
          },
          { phase: "transcribing" },
        );
        expect(
          yield* store.beginDispatch(
            operation.snapshot.operationId,
            tokenHash,
            "dispatch-lease",
            now,
            "2026-07-13T12:00:00.000Z",
          ),
        ).toBe(true);
        expect(
          yield* store.acceptDispatch({
            operationId: operation.snapshot.operationId,
            tokenHash,
            leaseToken: "dispatch-lease",
            occurredAt: "2026-07-13T12:00:00.000Z",
            commandId: CommandId.make("dispatch-command"),
            messageId: MessageId.make("dispatch-message"),
          }),
        ).toBe(true);

        expect(
          yield* service.cancel(operation.operationGrant.token, operation.snapshot.operationId),
        ).toMatchObject({
          cancelled: false,
          snapshot: { phase: "waiting", dispatchAccepted: true },
        });
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("survives parent expiry but denies auth revocation without deleting the receipt", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("never");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const store = yield* VoiceNativeThreadTurnStore;
        const sql = yield* SqlClient.SqlClient;
        const operation = yield* create("authority-lifetime");
        yield* sql`UPDATE voice_native_runtime_grants SET expires_at = -1
          WHERE auth_session_id = ${authSessionId} AND runtime_id = ${runtimeId}`;

        expect(
          yield* service.events(operation.operationGrant.token, operation.snapshot.operationId, {
            afterSequence: 0,
            waitMilliseconds: 0,
          }),
        ).toMatchObject({
          snapshot: { operationId: operation.snapshot.operationId },
        });

        yield* sql`UPDATE auth_sessions SET revoked_at = '2026-07-13T12:00:01.000Z'
          WHERE session_id = ${authSessionId}`;
        expect(
          (yield* service
            .events(operation.operationGrant.token, operation.snapshot.operationId, {
              afterSequence: 0,
              waitMilliseconds: 0,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("authorization-revoked");
        expect(yield* store.getReceiptCorrelation(operation.snapshot.operationId)).toMatchObject({
          operationId: operation.snapshot.operationId,
        });
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("releases the durable processing lease when transcription is interrupted", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("never");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const store = yield* VoiceNativeThreadTurnStore;
        const operation = yield* create("interrupted-upload");
        const fiber = yield* service
          .uploadAudio(operation.operationGrant.token, operation.snapshot.operationId, fixture)
          .pipe(Effect.forkChild);
        yield* Deferred.await(test.transcriptionStarted);
        expect(
          (yield* service
            .uploadAudio(operation.operationGrant.token, operation.snapshot.operationId, fixture)
            .pipe(Effect.flip)).reason,
        ).toBe("lease-conflict");
        yield* Fiber.interrupt(fiber);

        expect(yield* store.get(operation.snapshot.operationId)).toMatchObject({
          phase: "created",
          processingLeaseToken: null,
          processingLeaseUntil: null,
        });
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("switches stop-to-composer to draft before upload and rejects it after admission", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("never");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const operation = yield* create("draft-disposition");
        expect(
          yield* service.setDraftDisposition(
            operation.operationGrant.token,
            operation.snapshot.operationId,
          ),
        ).toMatchObject({ snapshot: { submissionPolicy: "draft", phase: "created" } });
        expect(
          yield* service.setDraftDisposition(
            operation.operationGrant.token,
            operation.snapshot.operationId,
          ),
        ).toMatchObject({ snapshot: { submissionPolicy: "draft", phase: "created" } });
        yield* service.cancel(operation.operationGrant.token, operation.snapshot.operationId);

        const admitted = yield* create("admitted-disposition");
        const upload = yield* service
          .uploadAudio(admitted.operationGrant.token, admitted.snapshot.operationId, fixture)
          .pipe(Effect.forkChild);
        yield* Deferred.await(test.transcriptionStarted);
        expect(
          (yield* service
            .setDraftDisposition(admitted.operationGrant.token, admitted.snapshot.operationId)
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-phase");
        yield* Fiber.interrupt(upload);
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("releases the durable processing lease when transcription defects", () =>
    Effect.gen(function* () {
      const defect = yield* makeTestLayer("defect");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const store = yield* VoiceNativeThreadTurnStore;
        const operation = yield* create("defected-upload");
        yield* service
          .uploadAudio(operation.operationGrant.token, operation.snapshot.operationId, fixture)
          .pipe(Effect.exit);
        expect(yield* store.get(operation.snapshot.operationId)).toMatchObject({
          phase: "created",
          processingLeaseToken: null,
        });
      }).pipe(Effect.provide(defect.layer), Effect.timeout("2 seconds"));
    }),
  );

  it.effect("terminalizes a monitor defect", () =>
    Effect.gen(function* () {
      const monitor = yield* makeTestLayer("success");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const operation = yield* create("monitor-defect");
        yield* service.uploadAudio(
          operation.operationGrant.token,
          operation.snapshot.operationId,
          fixture,
        );
        yield* TestClock.adjust("50 millis");
        const result = yield* service.events(
          operation.operationGrant.token,
          operation.snapshot.operationId,
          { afterSequence: 0, waitMilliseconds: 0 },
        );
        expect(result.snapshot).toMatchObject({
          phase: "failed",
          speechTerminal: "failed",
        });
      }).pipe(Effect.provide(monitor.layer), Effect.timeout("3 seconds"));
    }),
  );

  it.effect("encrypts draft transcripts, reports corruption, and consumes atomically", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer("success");
      yield* Effect.gen(function* () {
        yield* initialize;
        const service = yield* VoiceNativeThreadTurnService;
        const sql = yield* SqlClient.SqlClient;
        const operation = yield* create("draft-service");
        yield* service.setDraftDisposition(
          operation.operationGrant.token,
          operation.snapshot.operationId,
        );
        const uploaded = yield* service.uploadAudio(
          operation.operationGrant.token,
          operation.snapshot.operationId,
          fixture,
        );
        expect(uploaded).toMatchObject({ disposition: "draft-ready" });
        expect(
          yield* service.readDraft(operation.operationGrant.token, operation.snapshot.operationId),
        ).toMatchObject({ transcript: "service transcript" });

        yield* sql`UPDATE voice_native_thread_turn_drafts
          SET ciphertext = ${new Uint8Array([1, 2, 3])}
          WHERE operation_id = ${operation.snapshot.operationId}`;
        expect(
          (yield* service
            .readDraft(operation.operationGrant.token, operation.snapshot.operationId)
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-context");

        const consumed = yield* service.consumeDraft(
          operation.operationGrant.token,
          operation.snapshot.operationId,
        );
        expect(consumed).toMatchObject({
          consumed: true,
          snapshot: { phase: "draft-ready" },
        });
        expect(
          yield* service.consumeDraft(
            operation.operationGrant.token,
            operation.snapshot.operationId,
          ),
        ).toMatchObject({ consumed: false });
        expect(
          yield* sql<{ readonly ciphertext: Uint8Array | null }>`
          SELECT ciphertext FROM voice_native_thread_turn_drafts
          WHERE operation_id = ${operation.snapshot.operationId}`,
        ).toEqual([{ ciphertext: null }]);
      }).pipe(Effect.provide(test.layer));
    }),
  );
});

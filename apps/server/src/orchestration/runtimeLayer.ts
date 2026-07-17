import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnStartRepositoryLive } from "../persistence/Layers/ProjectionTurnStarts.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { ThreadTurnOutcomeQueryLive } from "./Layers/ThreadTurnOutcomeQuery.ts";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const ThreadTurnOutcomePersistenceLive = Layer.mergeAll(
  ProjectionThreadMessageRepositoryLive,
  ProjectionTurnRepositoryLive,
  ProjectionTurnStartRepositoryLive.pipe(Layer.provide(ProjectionTurnRepositoryLive)),
);

export const ThreadTurnOutcomeQueryConfiguredLive = ThreadTurnOutcomeQueryLive.pipe(
  Layer.provide(ThreadTurnOutcomePersistenceLive),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  ThreadTurnOutcomePersistenceLive,
  ThreadTurnOutcomeQueryConfiguredLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);

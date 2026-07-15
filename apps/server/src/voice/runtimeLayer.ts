import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HistoryRuntimeLive } from "../history/runtimeLayer.ts";
import { VoiceCredentialStoreLive } from "./Layers/VoiceCredentialStore.ts";
import { VoiceConversationServiceLive } from "./Layers/VoiceConversationService.ts";
import { VoiceConversationRepositoryLive } from "../persistence/Layers/VoiceConversations.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnStartRepositoryLive } from "../persistence/Layers/ProjectionTurnStarts.ts";
import { VoiceThreadTurnStoreLive } from "../persistence/Layers/VoiceThreadTurns.ts";
import { VoiceToolCallRepositoryLive } from "../persistence/Layers/VoiceToolCalls.ts";
import { VoiceHandoffActionRepositoryLive } from "../persistence/Layers/VoiceHandoffActions.ts";
import { VoiceRuntimeAuthorityRepositoryLive } from "../persistence/Layers/VoiceRuntimeAuthorities.ts";
import { VoiceRuntimeRealtimeStartRepositoryLive } from "../persistence/Layers/VoiceRuntimeRealtimeStarts.ts";
import { VoiceRealtimeTransitionReservationRepositoryLive } from "../persistence/Layers/VoiceRealtimeTransitionReservations.ts";
import { VoiceContextCompilerLive } from "./Layers/VoiceContextCompiler.ts";
import { VoiceSessionServiceLive } from "./Layers/VoiceSessionService.ts";
import { VoiceRealtimeControlServiceLive } from "./Layers/VoiceRealtimeControlService.ts";
import { VoiceSessionLifecycleLive } from "./Layers/VoiceSessionLifecycle.ts";
import { VoiceToolExecutorLive } from "./Layers/VoiceToolExecutor.ts";
import {
  OpenAiVoiceProvider,
  OpenAiVoiceProviderLive,
} from "./Providers/OpenAi/OpenAiVoiceProvider.ts";
import { VoiceThreadTurnServiceLive } from "./Layers/VoiceThreadTurnService.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { VoiceMediaRequestLimiterLive } from "./Services/VoiceMediaPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { VoiceSessionRegistryLive } from "./Services/VoiceSessionRegistry.ts";
import {
  makeVoiceProviderRegistry,
  VoiceProviderRegistry,
} from "./Services/VoiceProviderRegistry.ts";

const OpenAiVoiceProviderConfiguredLive = OpenAiVoiceProviderLive.pipe(
  Layer.provide(VoiceCredentialStoreLive),
);

const OpenAiVoiceInfrastructureLive = Layer.mergeAll(
  VoiceCredentialStoreLive,
  OpenAiVoiceProviderConfiguredLive,
);

const VoiceProviderRegistryLive = Layer.effect(
  VoiceProviderRegistry,
  Effect.gen(function* () {
    const openAi = yield* OpenAiVoiceProvider;
    return makeVoiceProviderRegistry(
      [openAi],
      new Map([
        ["transcription.request", "openai"],
        ["speech.streaming", "openai"],
        ["agent.realtime", "openai"],
      ]),
    );
  }),
).pipe(Layer.provide(OpenAiVoiceInfrastructureLive));

const VoiceProviderInfrastructureLive = Layer.mergeAll(
  OpenAiVoiceInfrastructureLive,
  VoiceProviderRegistryLive,
);

const VoiceConversationServiceConfiguredLive = VoiceConversationServiceLive.pipe(
  Layer.provide(VoiceConversationRepositoryLive),
);

const VoiceConversationInfrastructureLive = Layer.mergeAll(
  VoiceConversationRepositoryLive,
  VoiceConversationServiceConfiguredLive,
);

const VoiceToolExecutorConfiguredLive = VoiceToolExecutorLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      VoiceConversationInfrastructureLive,
      VoiceToolCallRepositoryLive,
      ProjectionThreadMessageRepositoryLive,
      ProjectionTurnRepositoryLive,
      ProjectionTurnStartRepositoryLive.pipe(Layer.provide(ProjectionTurnRepositoryLive)),
      HistoryRuntimeLive,
    ),
  ),
);

const VoiceToolInfrastructureLive = Layer.mergeAll(
  VoiceConversationInfrastructureLive,
  VoiceToolCallRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionTurnRepositoryLive,
  ProjectionTurnStartRepositoryLive.pipe(Layer.provide(ProjectionTurnRepositoryLive)),
  HistoryRuntimeLive,
  VoiceToolExecutorConfiguredLive,
);

const VoiceSessionDependenciesLive = Layer.mergeAll(
  VoiceProviderInfrastructureLive,
  VoiceToolInfrastructureLive,
  VoiceContextCompilerLive,
  VoiceSessionRegistryLive,
);

const VoiceCoreDependenciesLive = Layer.mergeAll(
  VoiceSessionDependenciesLive,
  VoiceHandoffActionRepositoryLive,
  VoiceRuntimeAuthorityRepositoryLive,
  VoiceRuntimeRealtimeStartRepositoryLive,
  VoiceRealtimeTransitionReservationRepositoryLive,
  VoiceThreadTurnStoreLive,
);

const VoiceThreadTurnDependenciesLive = Layer.mergeAll(
  VoiceCoreDependenciesLive,
  VoiceThreadTurnStoreLive,
  VoiceMediaRequestLimiterLive,
  ServerSettings.layer,
  ProjectionThreadMessageRepositoryLive,
  ProjectionTurnRepositoryLive,
  ProjectionTurnStartRepositoryLive.pipe(Layer.provide(ProjectionTurnRepositoryLive)),
).pipe(Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive));

const VoiceThreadTurnServiceConfiguredLive = VoiceThreadTurnServiceLive.pipe(
  Layer.provide(VoiceThreadTurnDependenciesLive),
);

const VoiceSessionServiceConfiguredLive = VoiceSessionServiceLive.pipe(
  Layer.provide(VoiceCoreDependenciesLive),
);

const VoiceRealtimeControlServiceConfiguredLive = VoiceRealtimeControlServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      VoiceSessionServiceConfiguredLive,
      VoiceCoreDependenciesLive,
      VoiceRuntimeRealtimeStartRepositoryLive,
      VoiceRealtimeTransitionReservationRepositoryLive,
    ),
  ),
);

const VoiceLifecycleConfiguredLive = VoiceSessionLifecycleLive.pipe(
  Layer.provide(Layer.merge(VoiceSessionServiceConfiguredLive, VoiceCoreDependenciesLive)),
);

export const VoiceRuntimeLive = Layer.mergeAll(
  VoiceSessionServiceConfiguredLive,
  VoiceCoreDependenciesLive,
  VoiceLifecycleConfiguredLive,
  VoiceThreadTurnServiceConfiguredLive,
  VoiceRealtimeControlServiceConfiguredLive,
);

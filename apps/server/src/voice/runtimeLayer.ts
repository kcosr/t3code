import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HistoryRuntimeLive } from "../history/runtimeLayer.ts";
import { VoiceCredentialStoreLive } from "./Layers/VoiceCredentialStore.ts";
import { VoiceConversationServiceLive } from "./Layers/VoiceConversationService.ts";
import { VoiceConversationRepositoryLive } from "../persistence/Layers/VoiceConversations.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnStartRepositoryLive } from "../persistence/Layers/ProjectionTurnStarts.ts";
import { VoiceToolCallRepositoryLive } from "../persistence/Layers/VoiceToolCalls.ts";
import { VoiceHandoffActionRepositoryLive } from "../persistence/Layers/VoiceHandoffActions.ts";
import { VoiceNativeControlGrantRepositoryLive } from "../persistence/Layers/VoiceNativeControlGrants.ts";
import { VoiceNativeRuntimeGrantRepositoryLive } from "../persistence/Layers/VoiceNativeRuntimeGrants.ts";
import { VoiceContextCompilerLive } from "./Layers/VoiceContextCompiler.ts";
import { VoiceSessionServiceLive } from "./Layers/VoiceSessionService.ts";
import { VoiceSessionLifecycleLive } from "./Layers/VoiceSessionLifecycle.ts";
import { VoiceToolExecutorLive } from "./Layers/VoiceToolExecutor.ts";
import {
  OpenAiVoiceProvider,
  OpenAiVoiceProviderLive,
} from "./Providers/OpenAi/OpenAiVoiceProvider.ts";
import { VoiceMediaTicketRegistryLive } from "./Services/VoiceMediaTicketRegistry.ts";
import { VoiceNativeControlGrantRegistryLive } from "./Services/VoiceNativeControlGrantRegistry.ts";
import { VoiceNativeRuntimeGrantRegistryLive } from "./Layers/VoiceNativeRuntimeGrantRegistry.ts";
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
  VoiceMediaTicketRegistryLive,
  VoiceNativeControlGrantRegistryLive.pipe(Layer.provide(VoiceNativeControlGrantRepositoryLive)),
  VoiceHandoffActionRepositoryLive,
  VoiceNativeControlGrantRepositoryLive,
  VoiceNativeRuntimeGrantRepositoryLive,
  VoiceNativeRuntimeGrantRegistryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        VoiceNativeRuntimeGrantRepositoryLive,
        VoiceNativeControlGrantRegistryLive.pipe(
          Layer.provide(VoiceNativeControlGrantRepositoryLive),
        ),
      ),
    ),
  ),
);

const VoiceSessionServiceConfiguredLive = VoiceSessionServiceLive.pipe(
  Layer.provide(VoiceCoreDependenciesLive),
);

const VoiceLifecycleConfiguredLive = VoiceSessionLifecycleLive.pipe(
  Layer.provide(Layer.merge(VoiceSessionServiceConfiguredLive, VoiceCoreDependenciesLive)),
);

export const VoiceRuntimeLive = Layer.mergeAll(
  VoiceSessionServiceConfiguredLive,
  VoiceCoreDependenciesLive,
  VoiceLifecycleConfiguredLive,
);

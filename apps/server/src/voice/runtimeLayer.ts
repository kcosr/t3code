import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HistoryRuntimeLive } from "../history/runtimeLayer.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VoiceCredentialStoreLive } from "./Layers/VoiceCredentialStore.ts";
import { VoiceConversationServiceLive } from "./Layers/VoiceConversationService.ts";
import { NativeVoiceSessionIssuerLive } from "./Layers/NativeVoiceSessionIssuer.ts";
import { VoiceConversationRepositoryLive } from "../persistence/Layers/VoiceConversations.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { VoiceToolCallRepositoryLive } from "../persistence/Layers/VoiceToolCalls.ts";
import { ThreadTurnOutcomeQueryConfiguredLive } from "../orchestration/Layers/ThreadTurnOutcomeQuery.ts";
import { VoiceContextCompilerLive } from "./Layers/VoiceContextCompiler.ts";
import { VoiceSessionServiceLive } from "./Layers/VoiceSessionService.ts";
import { VoiceSessionLifecycleLive } from "./Layers/VoiceSessionLifecycle.ts";
import { VoiceToolExecutorLive } from "./Layers/VoiceToolExecutor.ts";
import {
  OpenAiVoiceProvider,
  OpenAiVoiceProviderLive,
} from "./Providers/OpenAi/OpenAiVoiceProvider.ts";
import {
  OpenAiSpeechServerVoiceProvider,
  OpenAiSpeechServerVoiceProviderLive,
} from "./Providers/OpenAiSpeechServer/OpenAiSpeechServerVoiceProvider.ts";
import { VoiceMediaTicketRegistryLive } from "./Services/VoiceMediaTicketRegistry.ts";
import { VoiceSessionRegistryLive } from "./Services/VoiceSessionRegistry.ts";
import {
  makeDynamicVoiceProviderRegistry,
  VoiceProviderRegistry,
} from "./Services/VoiceProviderRegistry.ts";
import { VoiceError } from "./Errors.ts";

const OpenAiVoiceProviderConfiguredLive = OpenAiVoiceProviderLive.pipe(
  Layer.provide(VoiceCredentialStoreLive),
);

const OpenAiSpeechServerVoiceProviderConfiguredLive = OpenAiSpeechServerVoiceProviderLive.pipe(
  Layer.provide(VoiceCredentialStoreLive),
);

const VoiceProviderAdaptersLive = Layer.mergeAll(
  VoiceCredentialStoreLive,
  OpenAiVoiceProviderConfiguredLive,
  OpenAiSpeechServerVoiceProviderConfiguredLive,
);

const VoiceProviderRegistryLive = Layer.effect(
  VoiceProviderRegistry,
  Effect.gen(function* () {
    const openAi = yield* OpenAiVoiceProvider;
    const speechServer = yield* OpenAiSpeechServerVoiceProvider;
    const settingsService = yield* ServerSettingsService;
    return makeDynamicVoiceProviderRegistry([openAi, speechServer], (capability) =>
      settingsService.getSettings.pipe(
        Effect.map((settings) => {
          switch (capability) {
            case "transcription.request":
              return settings.voice.providers.transcription;
            case "speech.streaming":
              return settings.voice.providers.speech;
            case "agent.realtime":
            case "transcription.realtime":
              return "openai";
          }
        }),
        Effect.mapError(
          (cause) =>
            new VoiceError({
              reason: "provider-unavailable",
              operation: "provider.resolve",
              detail: "Voice settings are unavailable",
              retryable: true,
              cause,
            }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(VoiceProviderAdaptersLive));

const VoiceProviderInfrastructureLive = Layer.mergeAll(
  VoiceProviderAdaptersLive,
  VoiceProviderRegistryLive,
);

const VoiceConversationServiceConfiguredLive = VoiceConversationServiceLive.pipe(
  Layer.provide(VoiceConversationRepositoryLive),
);

const VoiceConversationInfrastructureLive = Layer.mergeAll(
  VoiceConversationRepositoryLive,
  VoiceConversationServiceConfiguredLive,
);

const VoiceToolExecutorDependenciesLive = Layer.mergeAll(
  VoiceConversationInfrastructureLive,
  VoiceToolCallRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ThreadTurnOutcomeQueryConfiguredLive,
  HistoryRuntimeLive,
);

const VoiceToolExecutorConfiguredLive = VoiceToolExecutorLive.pipe(
  Layer.provide(VoiceToolExecutorDependenciesLive),
);

const VoiceToolInfrastructureLive = Layer.mergeAll(
  VoiceToolExecutorDependenciesLive,
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
);

const VoiceSessionServiceConfiguredLive = VoiceSessionServiceLive.pipe(
  Layer.provide(VoiceCoreDependenciesLive),
);

const VoiceLifecycleConfiguredLive = VoiceSessionLifecycleLive.pipe(
  Layer.provide(VoiceSessionServiceConfiguredLive),
);

export const VoiceRuntimeLive = Layer.mergeAll(
  NativeVoiceSessionIssuerLive,
  VoiceSessionServiceConfiguredLive,
  VoiceCoreDependenciesLive,
  VoiceLifecycleConfiguredLive,
);

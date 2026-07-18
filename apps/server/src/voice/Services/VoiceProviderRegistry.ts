import type { VoiceCapability } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VoiceError } from "../Errors.ts";
import type { VoiceProviderAdapter } from "./VoiceProvider.ts";

export interface VoiceProviderRegistryShape {
  readonly resolve: (
    capability: VoiceCapability,
  ) => Effect.Effect<VoiceProviderAdapter, VoiceError>;
}

export class VoiceProviderRegistry extends Context.Service<
  VoiceProviderRegistry,
  VoiceProviderRegistryShape
>()("t3/voice/Services/VoiceProviderRegistry") {}

export const makeVoiceProviderRegistry = (
  providers: ReadonlyArray<VoiceProviderAdapter>,
  selections: ReadonlyMap<VoiceCapability, string>,
): VoiceProviderRegistryShape =>
  makeDynamicVoiceProviderRegistry(providers, (capability) =>
    Effect.succeed(selections.get(capability)),
  );

/**
 * Resolves the selected provider for each new request via `resolveSelection`.
 * Callers that have already resolved a provider for an in-flight request keep
 * using that adapter; subsequent requests observe updated settings.
 */
export const makeDynamicVoiceProviderRegistry = (
  providers: ReadonlyArray<VoiceProviderAdapter>,
  resolveSelection: (capability: VoiceCapability) => Effect.Effect<string | undefined, VoiceError>,
): VoiceProviderRegistryShape => {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));

  return {
    resolve: (capability) =>
      Effect.gen(function* () {
        const selectedId = yield* resolveSelection(capability);
        const provider = selectedId === undefined ? undefined : providersById.get(selectedId);
        if (provider === undefined || !provider.capabilities.has(capability)) {
          return yield* new VoiceError({
            reason: "not-configured",
            operation: "provider.resolve",
            detail: `No configured provider supports ${capability}`,
            retryable: false,
          });
        }
        return provider;
      }),
  };
};

export const voiceProviderRegistryLayer = (
  providers: ReadonlyArray<VoiceProviderAdapter>,
  selections: ReadonlyMap<VoiceCapability, string>,
) => Layer.succeed(VoiceProviderRegistry, makeVoiceProviderRegistry(providers, selections));

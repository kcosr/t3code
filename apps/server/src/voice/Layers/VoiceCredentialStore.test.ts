import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { VoiceCredentialStore } from "../Services/VoiceCredentialStore.ts";
import { VoiceCredentialStoreLive } from "./VoiceCredentialStore.ts";

const layer = VoiceCredentialStoreLive.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-secret-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("stores provider-keyed credentials without returning secrets", () =>
  Effect.gen(function* () {
    const credentials = yield* VoiceCredentialStore;
    expect((yield* credentials.status("openai")).configured).toBe(false);
    expect((yield* credentials.status("openai-speech-server")).configured).toBe(false);

    const openAiStatus = yield* credentials.set("openai", "sk-test-secret");
    const speechStatus = yield* credentials.set("openai-speech-server", "speech-token");
    const openAiKey = yield* credentials.get("openai");
    const speechKey = yield* credentials.get("openai-speech-server");
    const listed = yield* credentials.listStatus;

    expect(openAiStatus).toEqual({
      providerId: "openai",
      configured: true,
      updatedAt: openAiStatus.updatedAt,
    });
    expect(speechStatus).toEqual({
      providerId: "openai-speech-server",
      configured: true,
      updatedAt: speechStatus.updatedAt,
    });
    expect(openAiStatus).not.toHaveProperty("token");
    expect(speechStatus).not.toHaveProperty("token");
    expect(Option.getOrNull(openAiKey)).toBe("sk-test-secret");
    expect(Option.getOrNull(speechKey)).toBe("speech-token");
    expect(listed.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "openai", configured: true }),
        expect.objectContaining({ providerId: "openai-speech-server", configured: true }),
      ]),
    );

    const cleared = yield* credentials.clear("openai-speech-server");
    expect(cleared).toEqual({
      providerId: "openai-speech-server",
      configured: false,
      updatedAt: null,
    });
    expect((yield* credentials.status("openai")).configured).toBe(true);
    expect((yield* credentials.status("openai-speech-server")).configured).toBe(false);
  }).pipe(Effect.provide(layer)),
);

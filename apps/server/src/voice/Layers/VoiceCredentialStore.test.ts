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

it.effect("stores OpenAI credentials without returning them in status", () =>
  Effect.gen(function* () {
    const credentials = yield* VoiceCredentialStore;
    expect((yield* credentials.status).configured).toBe(false);

    const status = yield* credentials.setOpenAiApiKey("sk-test-secret");
    const key = yield* credentials.getOpenAiApiKey;

    expect(status.configured).toBe(true);
    expect(status).not.toHaveProperty("apiKey");
    expect(Option.getOrNull(key)).toBe("sk-test-secret");

    yield* credentials.clearOpenAiApiKey;
    expect((yield* credentials.status).configured).toBe(false);
  }).pipe(Effect.provide(layer)),
);

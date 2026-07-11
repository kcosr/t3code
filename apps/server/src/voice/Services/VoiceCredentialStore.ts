import type { VoiceCredentialStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { VoiceError } from "../Errors.ts";

export interface VoiceCredentialStoreShape {
  readonly status: Effect.Effect<VoiceCredentialStatus, VoiceError>;
  readonly getOpenAiApiKey: Effect.Effect<Option.Option<string>, VoiceError>;
  readonly setOpenAiApiKey: (apiKey: string) => Effect.Effect<VoiceCredentialStatus, VoiceError>;
  readonly clearOpenAiApiKey: Effect.Effect<void, VoiceError>;
}

export class VoiceCredentialStore extends Context.Service<
  VoiceCredentialStore,
  VoiceCredentialStoreShape
>()("t3/voice/Services/VoiceCredentialStore") {}

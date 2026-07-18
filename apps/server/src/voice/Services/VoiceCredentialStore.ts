import type {
  VoiceCredentialProviderId,
  VoiceCredentialStatus,
  VoiceCredentialsStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { VoiceError } from "../Errors.ts";

export interface VoiceCredentialStoreShape {
  readonly listStatus: Effect.Effect<VoiceCredentialsStatus, VoiceError>;
  readonly status: (
    providerId: VoiceCredentialProviderId,
  ) => Effect.Effect<VoiceCredentialStatus, VoiceError>;
  readonly get: (
    providerId: VoiceCredentialProviderId,
  ) => Effect.Effect<Option.Option<string>, VoiceError>;
  readonly set: (
    providerId: VoiceCredentialProviderId,
    token: string,
  ) => Effect.Effect<VoiceCredentialStatus, VoiceError>;
  readonly clear: (
    providerId: VoiceCredentialProviderId,
  ) => Effect.Effect<VoiceCredentialStatus, VoiceError>;
}

export class VoiceCredentialStore extends Context.Service<
  VoiceCredentialStore,
  VoiceCredentialStoreShape
>()("t3/voice/Services/VoiceCredentialStore") {}

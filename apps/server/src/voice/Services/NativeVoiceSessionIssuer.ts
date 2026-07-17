import {
  AuthEnvironmentScope,
  type EnvironmentSessionPrincipalShape,
  type VoiceNativeSessionCredential,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { SessionCredentialInternalError } from "../../auth/SessionStore.ts";

export class NativeVoiceSessionScopeRequiredError extends Schema.TaggedErrorClass<NativeVoiceSessionScopeRequiredError>()(
  "NativeVoiceSessionScopeRequiredError",
  { requiredScope: AuthEnvironmentScope },
) {}

export class NativeVoiceSessionReissuanceNotAllowedError extends Schema.TaggedErrorClass<NativeVoiceSessionReissuanceNotAllowedError>()(
  "NativeVoiceSessionReissuanceNotAllowedError",
  {},
) {}

export interface NativeVoiceSessionIssuerShape {
  readonly issue: (
    parent: EnvironmentSessionPrincipalShape,
  ) => Effect.Effect<
    VoiceNativeSessionCredential,
    | NativeVoiceSessionReissuanceNotAllowedError
    | NativeVoiceSessionScopeRequiredError
    | SessionCredentialInternalError
  >;
}

export class NativeVoiceSessionIssuer extends Context.Service<
  NativeVoiceSessionIssuer,
  NativeVoiceSessionIssuerShape
>()("t3/voice/Services/NativeVoiceSessionIssuer") {}

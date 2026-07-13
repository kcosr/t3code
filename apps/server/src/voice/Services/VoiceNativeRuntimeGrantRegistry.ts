import type {
  AuthEnvironmentScope,
  AuthSessionId,
  VoiceNativeRuntimeId,
  VoiceNativeRuntimeTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VoiceError } from "../Errors.ts";

export interface VoiceNativeRuntimeGrantScope {
  readonly authSessionId: AuthSessionId;
  readonly runtimeId: VoiceNativeRuntimeId;
  readonly generation: number;
  readonly grantedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly target: VoiceNativeRuntimeTarget;
  readonly expiresAt: number;
}

export interface VoiceNativeRuntimeGrantRegistryShape {
  readonly issue: (
    scope: VoiceNativeRuntimeGrantScope,
  ) => Effect.Effect<{ readonly token: string; readonly refreshed: boolean }, VoiceError>;
  readonly authorize: (token: string) => Effect.Effect<VoiceNativeRuntimeGrantScope | undefined>;
  readonly revokeRuntime: (
    authSessionId: AuthSessionId,
    runtimeId: VoiceNativeRuntimeId,
  ) => Effect.Effect<boolean>;
  readonly revokeAuthSession: (authSessionId: AuthSessionId) => Effect.Effect<void>;
}

export class VoiceNativeRuntimeGrantRegistry extends Context.Service<
  VoiceNativeRuntimeGrantRegistry,
  VoiceNativeRuntimeGrantRegistryShape
>()("t3/voice/Services/VoiceNativeRuntimeGrantRegistry") {}

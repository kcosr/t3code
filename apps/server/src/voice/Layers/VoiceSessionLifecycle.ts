import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SessionStore } from "../../auth/SessionStore.ts";
import { VoiceRuntimeAuthorityRepository } from "../../persistence/Services/VoiceRuntimeAuthorities.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";

export const VoiceSessionLifecycleLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const authSessions = yield* SessionStore;
    const voiceSessions = yield* VoiceSessionService;
    const runtimeAuthorities = yield* VoiceRuntimeAuthorityRepository;

    yield* authSessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type === "clientRemoved"
          ? Effect.all(
              [
                voiceSessions.revokeAuthSession(change.sessionId),
                runtimeAuthorities.clearAuthSession(change.sessionId),
              ],
              { discard: true },
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    );
  }),
);

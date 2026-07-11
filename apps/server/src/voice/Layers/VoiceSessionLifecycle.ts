import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SessionStore } from "../../auth/SessionStore.ts";
import { VoiceSessionService } from "../Services/VoiceSessionService.ts";

export const VoiceSessionLifecycleLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const authSessions = yield* SessionStore;
    const voiceSessions = yield* VoiceSessionService;

    yield* authSessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type === "clientRemoved"
          ? voiceSessions.revokeAuthSession(change.sessionId)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
  }),
);

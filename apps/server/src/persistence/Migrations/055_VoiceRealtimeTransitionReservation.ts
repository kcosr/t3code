import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE voice_runtime_realtime_transition_grants
    ADD COLUMN authority_expires_at INTEGER NOT NULL DEFAULT 0`;
});

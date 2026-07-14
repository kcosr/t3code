import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE voice_native_thread_turn_operations
    ADD COLUMN speech_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (speech_enabled IN (0, 1))`;
});

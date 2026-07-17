import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE voice_conversations ADD COLUMN last_call_at TEXT`;
  yield* sql`UPDATE voice_conversations SET last_call_at = updated_at`;
});

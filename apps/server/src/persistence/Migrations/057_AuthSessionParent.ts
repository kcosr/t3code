import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Migration IDs 41-56 were deployed by the retired native-runtime design.
// This replacement schema must remain later than that persistent history.

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE auth_sessions
    ADD COLUMN parent_session_id TEXT
  `;

  yield* sql`
    UPDATE auth_sessions
    SET parent_session_id = substr(subject, length('native-voice:') + 1)
    WHERE substr(subject, 1, length('native-voice:')) = 'native-voice:'
      AND EXISTS (
        SELECT 1
        FROM auth_sessions AS parent
        WHERE parent.session_id = substr(auth_sessions.subject, length('native-voice:') + 1)
      )
  `;

  yield* sql`
    UPDATE auth_sessions AS child
    SET expires_at = (
      SELECT parent.expires_at
      FROM auth_sessions AS parent
      WHERE parent.session_id = child.parent_session_id
    )
    WHERE child.parent_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auth_sessions AS parent
        WHERE parent.session_id = child.parent_session_id
          AND child.expires_at > parent.expires_at
      )
  `;

  yield* sql`
    UPDATE auth_sessions AS child
    SET revoked_at = (
      SELECT parent.revoked_at
      FROM auth_sessions AS parent
      WHERE parent.session_id = child.parent_session_id
    )
    WHERE child.parent_session_id IS NOT NULL
      AND child.revoked_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM auth_sessions AS parent
        WHERE parent.session_id = child.parent_session_id
          AND parent.revoked_at IS NOT NULL
      )
  `;

  yield* sql`
    CREATE INDEX idx_auth_sessions_parent
    ON auth_sessions(parent_session_id, revoked_at)
  `;
});

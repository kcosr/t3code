package expo.modules.t3voice

/**
 * Owns the platform binding handles associated with service-binding attempt ids.
 *
 * Android can report binding loss before [bind] returns. Keeping the attempt registered across that
 * call lets a concurrent release request defer the matching unbind until Android has accepted the
 * binding. Callers use the same [lock] for this class and [T3VoiceServiceBindingState].
 */
internal class T3VoiceServiceBindingAttempts<Context, Connection>(
  private val lock: Any,
  private val bind: (Context, Connection) -> Boolean,
  private val unbind: (Context, Connection) -> Unit,
) {
  private data class Attempt<Context, Connection>(
    val context: Context,
    val connection: Connection,
    var bindCompleted: Boolean = false,
    var bindSucceeded: Boolean = false,
    var releaseRequested: Boolean = false,
  )

  private val attempts = mutableMapOf<Long, Attempt<Context, Connection>>()

  fun bind(
    attemptId: Long,
    context: Context,
    connection: Connection,
    complete: (succeeded: Boolean) -> T3VoiceServiceBindingState.BindingCompletion,
  ): T3VoiceServiceBindingState.BindingCompletion {
    val attempt = Attempt(context, connection)
    synchronized(lock) {
      check(attemptId !in attempts) {
        "A service-binding attempt with id $attemptId is already registered."
      }
      attempts[attemptId] = attempt
    }

    val succeeded = runCatching { bind(context, connection) }.getOrDefault(false)
    var release: Attempt<Context, Connection>? = null
    val completion =
      synchronized(lock) {
        attempt.bindCompleted = true
        attempt.bindSucceeded = succeeded
        complete(succeeded).also { result ->
          if (result.releaseAttempt) attempt.releaseRequested = true
          if (!succeeded || attempt.releaseRequested) {
            attempts.remove(attemptId)
            if (succeeded && attempt.releaseRequested) release = attempt
          }
        }
      }
    release?.release()
    return completion
  }

  fun release(attemptId: Long) {
    var release: Attempt<Context, Connection>? = null
    synchronized(lock) {
      val attempt = attempts[attemptId] ?: return
      attempt.releaseRequested = true
      if (attempt.bindCompleted) {
        attempts.remove(attemptId)
        if (attempt.bindSucceeded) release = attempt
      }
    }
    release?.release()
  }

  private fun Attempt<Context, Connection>.release() {
    runCatching { unbind(context, connection) }
  }
}

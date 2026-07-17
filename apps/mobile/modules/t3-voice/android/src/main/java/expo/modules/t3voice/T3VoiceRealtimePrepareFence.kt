package expo.modules.t3voice

/** Exact, single-attempt cancellation fence for synchronous WebRTC resource construction. */
internal class T3VoiceRealtimePrepareFence {
  internal class Attempt internal constructor(
    val sessionId: String,
  ) {
    internal var cancelled = false
  }

  private var pending: Attempt? = null
  private var cancelledBeforeBegin: String? = null
  private var retiredSessionId: String? = null

  @Synchronized
  fun begin(sessionId: String): Attempt? {
    check(pending == null) { "A Realtime media preparation is already in progress." }
    val tombstone = cancelledBeforeBegin
    if (tombstone != null) {
      check(tombstone == sessionId) { "Realtime preparation cancellation ownership changed." }
      cancelledBeforeBegin = null
      retiredSessionId = sessionId
      return null
    }
    return Attempt(sessionId).also { pending = it }
  }

  /** Cancels an exact in-flight attempt without admitting a future cancellation. */
  @Synchronized
  fun cancelPending(sessionId: String): Boolean {
    val attempt = pending?.takeIf { it.sessionId == sessionId } ?: return false
    attempt.cancelled = true
    return true
  }

  /** The exact cancelStartup policy used by WebRTC for not-yet-begun and in-flight attempts. */
  @Synchronized
  fun cancelStartup(sessionId: String): Boolean {
    val attempt = pending
    if (attempt != null) {
      check(attempt.sessionId == sessionId) { "Realtime preparation cancellation owner changed." }
      attempt.cancelled = true
      return true
    }
    return cancelBeforeBegin(sessionId)
  }

  /** Persists cancellation when startup has not entered [begin] yet. */
  @Synchronized
  fun cancelBeforeBegin(sessionId: String): Boolean {
    check(pending == null) { "A Realtime preparation is already in progress." }
    if (retiredSessionId == sessionId) return false
    check(cancelledBeforeBegin == null || cancelledBeforeBegin == sessionId) {
      "Realtime preparation cancellation ownership changed."
    }
    cancelledBeforeBegin = sessionId
    return true
  }

  /** Retires an exact pre-begin tombstone after the owning startup runnable has quiesced. */
  @Synchronized
  fun retireCancelledBeforeBegin(sessionId: String): Boolean {
    if (cancelledBeforeBegin != sessionId) return false
    check(pending == null) { "A Realtime preparation is still in progress." }
    cancelledBeforeBegin = null
    retiredSessionId = sessionId
    return true
  }

  @Synchronized
  fun isLive(attempt: Attempt): Boolean {
    check(pending === attempt) { "Realtime media preparation ownership changed." }
    return !attempt.cancelled
  }

  /** Permits installation while retaining the attempt through the rest of synchronous startup. */
  @Synchronized
  fun claimInstall(attempt: Attempt): Boolean {
    check(pending === attempt) { "Realtime media preparation ownership changed." }
    if (!attempt.cancelled) return true
    pending = null
    retiredSessionId = attempt.sessionId
    return false
  }

  /** Ends synchronous startup and reports whether cancellation raced with its final steps. */
  @Synchronized
  fun complete(attempt: Attempt): Boolean {
    check(pending === attempt) { "Realtime media preparation ownership changed." }
    pending = null
    retiredSessionId = attempt.sessionId
    return !attempt.cancelled
  }

  @Synchronized
  fun abandon(attempt: Attempt) {
    if (pending !== attempt) return
    attempt.cancelled = true
    pending = null
    retiredSessionId = attempt.sessionId
  }

  @Synchronized
  fun cancelPending(): Boolean {
    val attempt = pending ?: return false
    attempt.cancelled = true
    return true
  }
}

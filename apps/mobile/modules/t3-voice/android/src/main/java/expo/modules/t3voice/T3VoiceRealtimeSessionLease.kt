package expo.modules.t3voice

/**
 * Pure per-session identity, claim-once terminal publication, and timeout arming.
 *
 * Create before peer resources so audio callbacks can capture the lease, then [install] when the
 * session becomes the active peer. [release] disarms timeouts and deactivates audio without
 * consuming the terminal claim (stop/fail still claim after release).
 */
internal class T3VoiceRealtimeSessionLease(
  val sessionId: String,
) {
  enum class TimeoutKind {
    CONNECTING,
    DISCONNECTED,
  }

  data class TimeoutToken(
    val lease: T3VoiceRealtimeSessionLease,
    val kind: TimeoutKind,
    val ordinal: Long,
  )

  private var installed = false
  private var released = false
  private var terminalClaimed = false
  private var timeoutOrdinal = 0L
  private val armed = mutableMapOf<TimeoutKind, TimeoutToken>()

  @Synchronized
  fun install() {
    check(!released) { "Cannot install a released lease." }
    installed = true
  }

  @Synchronized
  fun isAudioActive(): Boolean = installed && !released

  /** Claim terminal emission exactly once. Valid before or after [release]. */
  @Synchronized
  fun claimTerminal(): Boolean {
    if (terminalClaimed) return false
    terminalClaimed = true
    return true
  }

  @Synchronized
  fun armTimeout(kind: TimeoutKind): TimeoutToken? {
    if (released || !installed) return null
    timeoutOrdinal += 1
    return TimeoutToken(this, kind, timeoutOrdinal).also { armed[kind] = it }
  }

  @Synchronized
  fun consumeTimeout(token: TimeoutToken): Boolean {
    if (token.lease !== this || released) return false
    if (armed[token.kind] != token) return false
    armed.remove(token.kind)
    return true
  }

  @Synchronized
  fun disarmAllTimeouts(): Boolean {
    if (released || !installed) return false
    armed.clear()
    return true
  }

  /** Deactivate audio and disarm timeouts. Does not claim the terminal flag. Idempotent. */
  @Synchronized
  fun release(): Boolean {
    if (released) return false
    released = true
    installed = false
    armed.clear()
    return true
  }
}

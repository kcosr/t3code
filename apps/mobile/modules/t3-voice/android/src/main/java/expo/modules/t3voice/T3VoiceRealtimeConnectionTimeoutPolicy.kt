package expo.modules.t3voice

internal class T3VoiceRealtimeConnectionTimeoutPolicy {
  enum class Kind {
    CONNECTING,
    DISCONNECTED,
  }

  data class Owner(
    val sessionId: String,
    val generation: Long,
  )

  data class Token(
    val owner: Owner,
    val kind: Kind,
    val ordinal: Long,
  )

  private var generation = 0L
  private var ordinal = 0L
  private var owner: Owner? = null
  private val armed = mutableMapOf<Kind, Token>()

  fun activate(sessionId: String): Owner {
    generation += 1
    return Owner(sessionId, generation).also {
      owner = it
      armed.clear()
    }
  }

  fun arm(owner: Owner, kind: Kind): Token? {
    if (this.owner != owner) return null
    ordinal += 1
    return Token(owner, kind, ordinal).also { armed[kind] = it }
  }

  fun disarmAll(owner: Owner): Boolean {
    if (this.owner != owner) return false
    armed.clear()
    return true
  }

  fun deactivate(owner: Owner): Boolean {
    if (this.owner != owner) return false
    this.owner = null
    armed.clear()
    return true
  }

  fun consume(token: Token): Boolean {
    if (owner != token.owner || armed[token.kind] != token) return false
    armed.remove(token.kind)
    return true
  }
}

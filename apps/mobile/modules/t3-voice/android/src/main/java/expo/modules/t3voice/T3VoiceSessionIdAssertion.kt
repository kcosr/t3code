package expo.modules.t3voice

/** Temporary M4 bridge assertion; native session identifiers become kernel-minted in M5. */
internal class T3VoiceSessionIdAssertion(private val capacity: Int) {
  private val ids = LinkedHashSet<String>()

  init {
    require(capacity > 0) { "Realtime session assertion capacity must be positive." }
  }

  fun assertFresh(sessionId: String) {
    check(ids.add(sessionId)) { "Realtime native session IDs cannot be reused." }
    if (ids.size > capacity) {
      val oldest = ids.iterator()
      oldest.next()
      oldest.remove()
    }
  }

  internal val size: Int
    get() = ids.size
}

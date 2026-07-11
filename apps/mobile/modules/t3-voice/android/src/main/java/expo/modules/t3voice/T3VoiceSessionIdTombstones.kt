package expo.modules.t3voice

internal class T3VoiceSessionIdTombstones(private val capacity: Int) {
  private val ids = LinkedHashSet<String>()

  init {
    require(capacity > 0) { "Realtime session tombstone capacity must be positive." }
  }

  fun add(sessionId: String): Boolean {
    if (!ids.add(sessionId)) return false
    if (ids.size > capacity) {
      val oldest = ids.iterator()
      oldest.next()
      oldest.remove()
    }
    return true
  }

  internal val size: Int
    get() = ids.size
}

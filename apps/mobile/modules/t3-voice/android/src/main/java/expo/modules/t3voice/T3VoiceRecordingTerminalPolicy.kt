package expo.modules.t3voice

internal class T3VoiceRecordingTerminalPolicy {
  data class Owner(val recordingId: String, val generation: Long)

  private var generation = 0L
  private var active: Owner? = null

  fun activate(recordingId: String): Owner {
    check(active == null) { "A recording terminal owner is already active." }
    generation += 1
    return Owner(recordingId, generation).also { active = it }
  }

  fun claim(owner: Owner): Boolean {
    if (active != owner) return false
    active = null
    return true
  }

  fun deactivate(owner: Owner): Boolean = claim(owner)
}

internal class T3VoiceRecordingTerminalCoordinator(
  private val lock: Any,
) {
  fun <T> serialized(operation: () -> T): T = synchronized(lock) { operation() }
}

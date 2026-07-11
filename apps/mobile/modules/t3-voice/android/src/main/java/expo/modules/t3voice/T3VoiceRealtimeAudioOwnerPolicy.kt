package expo.modules.t3voice

internal class T3VoiceRealtimeAudioOwnerPolicy {
  data class Owner(
    val sessionId: String,
    val generation: Long,
  )

  private var generation = 0L
  private var active: Owner? = null

  fun issue(sessionId: String): Owner {
    generation += 1
    return Owner(sessionId, generation)
  }

  fun activate(owner: Owner) {
    active = owner
  }

  fun isActive(owner: Owner): Boolean = active == owner

  fun deactivate(owner: Owner): Boolean {
    if (active != owner) return false
    active = null
    return true
  }
}

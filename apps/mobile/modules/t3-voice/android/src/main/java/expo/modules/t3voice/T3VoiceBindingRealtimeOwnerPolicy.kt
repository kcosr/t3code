package expo.modules.t3voice

internal class T3VoiceBindingRealtimeOwnerPolicy {
  data class Owner(val sessionId: String, val binderGeneration: Long)

  private var binderGeneration = 0L
  private var connected = false
  private var owner: Owner? = null

  fun connected(): Long {
    binderGeneration += 1
    connected = true
    owner = null
    return binderGeneration
  }

  fun observe(generation: Long, sessionId: String?) {
    if (!connected || generation != binderGeneration) return
    owner = sessionId?.let { Owner(it, generation) }
  }

  fun disconnected(): Owner? {
    if (!connected) return null
    connected = false
    return owner.also { owner = null }
  }
}

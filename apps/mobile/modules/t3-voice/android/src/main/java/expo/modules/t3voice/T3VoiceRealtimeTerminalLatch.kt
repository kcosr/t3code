package expo.modules.t3voice

internal class T3VoiceRealtimeTerminalLatch {
  private var ownerSessionId: String? = null

  @Synchronized
  fun activate(sessionId: String) {
    check(ownerSessionId == null) { "A Realtime terminal owner is already active." }
    ownerSessionId = sessionId
  }

  @Synchronized
  fun claim(sessionId: String): Boolean {
    if (ownerSessionId != sessionId) return false
    ownerSessionId = null
    return true
  }
}

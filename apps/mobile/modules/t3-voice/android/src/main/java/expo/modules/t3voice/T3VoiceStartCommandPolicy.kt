package expo.modules.t3voice

internal enum class T3VoiceStartCommandDecision {
  PROMOTE_ACTIVE_OWNER,
  STOP_STALE_START,
}

internal object T3VoiceStartCommandPolicy {
  fun decide(
    expectedOwnerId: String?,
    activeOwnerId: String?,
  ): T3VoiceStartCommandDecision =
    if (expectedOwnerId != null && expectedOwnerId == activeOwnerId) {
      T3VoiceStartCommandDecision.PROMOTE_ACTIVE_OWNER
    } else {
      T3VoiceStartCommandDecision.STOP_STALE_START
    }
}

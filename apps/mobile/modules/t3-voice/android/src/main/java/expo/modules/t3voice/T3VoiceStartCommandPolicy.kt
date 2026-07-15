package expo.modules.t3voice

import android.app.Service

internal enum class T3VoiceStartCommandDecision {
  PROMOTE_ACTIVE_OWNER,
  STOP_STALE_START,
}

internal object T3VoiceStartCommandPolicy {
  fun shouldPromoteForegroundImmediately(isForeground: Boolean): Boolean = !isForeground

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

internal class T3VoiceStartCommandStickinessCache(
  initialConfig: T3VoiceReadinessConfig = T3VoiceReadinessConfig(),
) {
  @Volatile
  var value: Int = stickiness(initialConfig)
    private set

  fun publish(config: T3VoiceReadinessConfig) {
    value = stickiness(config)
  }

  private fun stickiness(config: T3VoiceReadinessConfig): Int =
    if (T3VoiceForegroundLifecyclePolicy.shouldRemainStarted(config)) {
      Service.START_STICKY
    } else {
      Service.START_NOT_STICKY
    }
}

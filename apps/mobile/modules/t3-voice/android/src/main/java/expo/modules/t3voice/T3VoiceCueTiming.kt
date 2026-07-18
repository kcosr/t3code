package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Shared route/capture timing for the native Realtime and Thread cue boundaries. */
internal object T3VoiceCueTiming {
  const val READY_TO_CAPTURE_SETTLE_MS = 120L
  const val CAPTURE_TO_ENDED_SETTLE_MS = 320L
  const val ENDED_COMPLETION_WAIT_MS = 3_000L

  /**
   * Play Ended only when cues were enabled at the terminal boundary. The caller must keep the
   * selected communication route alive for this entire call. Completion is bounded independently
   * of the player so shutdown cannot be stranded by a lost callback.
   */
  fun awaitEnded(
    cueArming: T3VoiceCueArming,
    generation: Long,
    settleMs: Long = CAPTURE_TO_ENDED_SETTLE_MS,
    completionWaitMs: Long = ENDED_COMPLETION_WAIT_MS,
  ): Boolean {
    require(settleMs >= 0)
    require(completionWaitMs > 0)
    if (!cueArming.isEnabled()) return false
    if (!sleep(settleMs)) return true

    val completed = CountDownLatch(1)
    val accepted =
      runCatching {
        cueArming.requestEnded(generation) { completed.countDown() }
      }.getOrDefault(false)
    if (!accepted) completed.countDown()
    try {
      completed.await(completionWaitMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    return true
  }

  private fun sleep(delayMs: Long): Boolean {
    if (delayMs == 0L) return true
    return try {
      Thread.sleep(delayMs)
      true
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      false
    }
  }
}

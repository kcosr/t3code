package expo.modules.t3voice

import java.util.concurrent.TimeUnit

/** Retries only Thread outcome reads; message dispatch remains outside this retry boundary. */
internal fun <T> readThreadOutcomeWithRetry(
  deadlineNanos: Long,
  isActive: () -> Boolean,
  nowNanos: () -> Long,
  sleep: (Long) -> Unit,
  read: () -> T,
): T {
  var transientDelayMs = INITIAL_TRANSIENT_OUTCOME_RETRY_MS
  while (isActive() && nowNanos() < deadlineNanos) {
    try {
      return read()
    } catch (cause: T3VoiceNativeApiException) {
      val now = nowNanos()
      if (now >= deadlineNanos) break
      if (cause.code in THREAD_OUTCOME_PROJECTION_LAG_CODES) {
        // Projection lag is an expected not-yet-visible outcome and keeps its fixed poll cadence.
        sleep(THREAD_OUTCOME_POLL_DELAY_MS)
        continue
      }
      if (!cause.retryable) throw cause

      val remainingMs =
        TimeUnit.NANOSECONDS.toMillis(deadlineNanos - now).coerceAtLeast(1L)
      sleep(minOf(transientDelayMs, remainingMs))
      transientDelayMs =
        (transientDelayMs * 2).coerceAtMost(MAXIMUM_TRANSIENT_OUTCOME_RETRY_MS)
    }
  }
  throw T3VoiceNativeApiException("response-timeout", retryable = true)
}

internal const val THREAD_OUTCOME_POLL_DELAY_MS = 500L
private const val INITIAL_TRANSIENT_OUTCOME_RETRY_MS = 250L
private const val MAXIMUM_TRANSIENT_OUTCOME_RETRY_MS = 2_000L
private val THREAD_OUTCOME_PROJECTION_LAG_CODES = setOf("thread_message_not_found")

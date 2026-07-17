package expo.modules.t3voice

import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

internal class T3VoiceThreadOutcomeRetryTest {
  @Test
  fun `retryable outcome failures back off until a read succeeds`() {
    var now = 0L
    var reads = 0
    val sleeps = mutableListOf<Long>()

    val result =
      readThreadOutcomeWithRetry(
        deadlineNanos = TimeUnit.SECONDS.toNanos(10),
        isActive = { true },
        nowNanos = { now },
        sleep = { delayMs ->
          sleeps += delayMs
          now += TimeUnit.MILLISECONDS.toNanos(delayMs)
        },
      ) {
        reads += 1
        if (reads <= 4) {
          throw T3VoiceNativeApiException("network-retryable", retryable = true)
        }
        "completed"
      }

    assertEquals("completed", result)
    assertEquals(5, reads)
    assertEquals(listOf(250L, 500L, 1_000L, 2_000L), sleeps)
  }

  @Test
  fun `retry delay is clipped to the response deadline`() {
    var now = 0L
    var reads = 0
    val sleeps = mutableListOf<Long>()

    val failure =
      assertThrows(T3VoiceNativeApiException::class.java) {
        readThreadOutcomeWithRetry(
          deadlineNanos = TimeUnit.MILLISECONDS.toNanos(600),
          isActive = { true },
          nowNanos = { now },
          sleep = { delayMs ->
            sleeps += delayMs
            now += TimeUnit.MILLISECONDS.toNanos(delayMs)
          },
        ) {
          reads += 1
          throw T3VoiceNativeApiException("server-busy", retryable = true)
        }
      }

    assertEquals("response-timeout", failure.code)
    assertEquals(2, reads)
    assertEquals(listOf(250L, 350L), sleeps)
  }

  @Test
  fun `projection lag retains the exact fixed polling cadence`() {
    var now = 0L
    var reads = 0
    val sleeps = mutableListOf<Long>()

    val result =
      readThreadOutcomeWithRetry(
        deadlineNanos = TimeUnit.SECONDS.toNanos(3),
        isActive = { true },
        nowNanos = { now },
        sleep = { delayMs ->
          sleeps += delayMs
          now += TimeUnit.MILLISECONDS.toNanos(delayMs)
        },
      ) {
        reads += 1
        if (reads <= 2) {
          throw T3VoiceNativeApiException("thread_message_not_found", retryable = false)
        }
        "visible"
      }

    assertEquals("visible", result)
    assertEquals(listOf(THREAD_OUTCOME_POLL_DELAY_MS, THREAD_OUTCOME_POLL_DELAY_MS), sleeps)
  }

  @Test
  fun `non-retryable outcome failure is not replayed`() {
    var reads = 0

    val failure =
      assertThrows(T3VoiceNativeApiException::class.java) {
        readThreadOutcomeWithRetry(
          deadlineNanos = TimeUnit.SECONDS.toNanos(3),
          isActive = { true },
          nowNanos = { 0L },
          sleep = {},
        ) {
          reads += 1
          throw T3VoiceNativeApiException("request-rejected", retryable = false)
        }
      }

    assertEquals("request-rejected", failure.code)
    assertEquals(1, reads)
  }
}

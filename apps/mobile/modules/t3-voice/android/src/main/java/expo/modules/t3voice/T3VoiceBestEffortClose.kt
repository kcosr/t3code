package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** Keeps terminal server cleanup independent from the runtime owner's in-memory session slot. */
internal fun scheduleBestEffortClose(
  executor: ExecutorService,
  close: () -> Unit,
) {
  try {
    executor.execute {
      try {
        close()
      } finally {
        executor.shutdown()
      }
    }
  } catch (_: RejectedExecutionException) {
    executor.shutdownNow()
  }
}

/** Waits for startup publication so a concurrently-created server session is not orphaned. */
internal fun <T : Any> scheduleBestEffortCloseAfterReady(
  executor: ExecutorService,
  ready: CountDownLatch,
  readyTimeoutMs: Long,
  current: () -> T?,
  close: (T) -> Unit,
) {
  scheduleBestEffortClose(executor) {
    runCatching { ready.await(readyTimeoutMs, TimeUnit.MILLISECONDS) }
    current()?.let(close)
  }
}

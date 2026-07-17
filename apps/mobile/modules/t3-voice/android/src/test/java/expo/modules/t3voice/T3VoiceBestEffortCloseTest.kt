package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceBestEffortCloseTest {
  @Test
  fun `scheduled close survives caller ownership release and shuts down its lane`() {
    val executor = Executors.newSingleThreadExecutor()
    val closed = CountDownLatch(1)
    val values = mutableListOf<String>()

    scheduleBestEffortClose(executor) {
      synchronized(values) { values += "server-session" }
      closed.countDown()
    }

    assertTrue(closed.await(1, TimeUnit.SECONDS))
    assertEquals(listOf("server-session"), synchronized(values) { values.toList() })
    assertTrue(executor.awaitTermination(1, TimeUnit.SECONDS))
  }

  @Test
  fun `empty cleanup still closes the lane`() {
    val executor = Executors.newSingleThreadExecutor()
    val completed = CountDownLatch(1)
    var closeCount = 0

    scheduleBestEffortClose(executor) {
      closeCount += 1
      completed.countDown()
    }

    assertTrue(completed.await(1, TimeUnit.SECONDS))
    assertTrue(executor.awaitTermination(1, TimeUnit.SECONDS))
    assertEquals(1, closeCount)
  }

  @Test
  fun `terminal close waits for concurrently published server ownership`() {
    val executor = Executors.newSingleThreadExecutor()
    val startupFinished = CountDownLatch(1)
    val server = AtomicReference<String?>()
    val closed = CountDownLatch(1)

    scheduleBestEffortCloseAfterReady(
      executor = executor,
      ready = startupFinished,
      readyTimeoutMs = 1_000,
      current = server::get,
      close = { if (it == "late-server-session") closed.countDown() },
    )
    server.set("late-server-session")
    startupFinished.countDown()

    assertTrue(closed.await(1, TimeUnit.SECONDS))
    assertTrue(executor.awaitTermination(1, TimeUnit.SECONDS))
  }
}

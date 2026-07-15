package expo.modules.t3voice

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceNetDriverTest {
  @Test
  fun `thread turn lane preserves submission order`() {
    val completed = CountDownLatch(3)
    val order = Collections.synchronizedList(mutableListOf<Int>())
    val driver = VoiceNetDriver(resultSink = executingSink(completed))

    repeat(3) { index ->
      driver.executeDetached("turn-$index", VoiceNetLane.THREAD_TURN, epoch()) {
        order += index
      }
    }

    assertTrue(completed.await(5, TimeUnit.SECONDS))
    assertEquals(listOf(0, 1, 2), order)
    driver.release()
  }

  @Test
  fun `realtime lane is bounded to four concurrent calls`() {
    val entered = CountDownLatch(4)
    val release = CountDownLatch(1)
    val completed = CountDownLatch(8)
    val active = AtomicInteger()
    val maximum = AtomicInteger()
    val driver = VoiceNetDriver(resultSink = executingSink(completed))

    repeat(8) { index ->
      driver.executeDetached("realtime-$index", VoiceNetLane.REALTIME, epoch()) {
        val current = active.incrementAndGet()
        maximum.updateAndGet { maxOf(it, current) }
        entered.countDown()
        release.await(5, TimeUnit.SECONDS)
        active.decrementAndGet()
      }
    }

    assertTrue(entered.await(5, TimeUnit.SECONDS))
    assertEquals(4, maximum.get())
    release.countDown()
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    driver.release()
  }

  @Test
  fun `control lane preserves fifo ordering`() {
    val completed = CountDownLatch(3)
    val order = Collections.synchronizedList(mutableListOf<Int>())
    val driver = VoiceNetDriver(resultSink = executingSink(completed))

    repeat(3) { index ->
      driver.executeDetached("control-$index", VoiceNetLane.CONTROL, epoch()) {
        order += index
      }
    }

    assertTrue(completed.await(5, TimeUnit.SECONDS))
    assertEquals(listOf(0, 1, 2), order)
    driver.release()
  }

  private fun executingSink(completed: CountDownLatch) = VoiceKernelDriverResultSink { result ->
    (result.payload as VoiceKernelDriverResultPayload.NetCompleted).continuation()
    completed.countDown()
  }

  private fun epoch() = VoiceKernelEpoch("test", 1, "operation", 1)
}

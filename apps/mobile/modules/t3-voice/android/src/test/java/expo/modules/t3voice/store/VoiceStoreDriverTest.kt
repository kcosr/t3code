package expo.modules.t3voice.store

import expo.modules.t3voice.kernel.VoiceKernelDriverResultPayload
import expo.modules.t3voice.kernel.VoiceKernelEpoch
import expo.modules.t3voice.net.VoiceKernelDriverResultSink

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceStoreDriverTest {
  @Test
  fun `persisted results follow store writes in fifo order`() {
    val events = Collections.synchronizedList(mutableListOf<String>())
    val completed = CountDownLatch(2)
    val driver = VoiceStoreDriver(
      resultSink = VoiceKernelDriverResultSink { result ->
        val payload = result.payload as VoiceKernelDriverResultPayload.StorePersisted
        events += "result-${payload.label}"
        payload.continuation(payload.result)
      },
    )

    listOf("first", "second").forEach { label ->
      driver.persist(
        label,
        VoiceKernelEpoch("test", 1, "operation", 1),
        body = { events += "persist-$label" },
        continuation = {
          assertTrue(it.isSuccess)
          completed.countDown()
        },
      )
    }

    assertTrue(completed.await(5, TimeUnit.SECONDS))
    assertEquals(
      listOf("persist-first", "result-first", "persist-second", "result-second"),
      events,
    )
    driver.release()
  }
}

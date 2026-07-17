package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoicePcmStreamSinkTest {
  @Test
  fun `odd HTTP boundaries are carried without losing or reordering PCM bytes`() {
    val accepted = mutableListOf<ByteArray>()
    val sink =
      T3VoicePcmStreamSink(
        playbackId = "playback",
        enqueue = { _, _, pcm -> accepted += pcm },
      )

    sink.accept(byteArrayOf(1))
    sink.accept(byteArrayOf(2, 3, 4))
    sink.accept(byteArrayOf(5, 6))

    assertEquals(1, sink.finish())
    assertArrayEquals(
      byteArrayOf(1, 2, 3, 4, 5, 6),
      accepted.flatMap(ByteArray::asIterable).toByteArray(),
    )
  }

  @Test
  fun `partial terminal frame is rejected`() {
    val sink =
      T3VoicePcmStreamSink(
        playbackId = "playback",
        enqueue = { _, _, _ -> },
      )
    sink.accept(byteArrayOf(1))

    assertThrows(IllegalStateException::class.java, sink::finish)
  }

  @Test
  fun `cancelling after partial delivery never replays accepted PCM`() {
    val acceptedIndexes = mutableListOf<Int>()
    val sink =
      T3VoicePcmStreamSink(
        playbackId = "playback",
        enqueue = { _, index, _ -> acceptedIndexes += index },
      )
    sink.accept(byteArrayOf(1, 2))

    sink.cancel()

    assertThrows(IllegalStateException::class.java) {
      sink.accept(byteArrayOf(3, 4))
    }
    assertEquals(listOf(0), acceptedIndexes)
  }

  @Test
  fun `queue saturation applies credit backpressure and cancellation unblocks promptly`() {
    val fifthEnqueueStarted = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()
    val sink =
      T3VoicePcmStreamSink(
        playbackId = "playback",
        enqueue = { _, _, _ -> },
        maximumPendingChunks = 1,
        maximumPendingBytes = 4,
      )
    sink.accept(byteArrayOf(1, 2))

    val worker =
      thread(name = "pcm-credit-test") {
        fifthEnqueueStarted.countDown()
        runCatching { sink.accept(byteArrayOf(3, 4)) }
          .exceptionOrNull()
          .let(failure::set)
      }
    assertTrue(fifthEnqueueStarted.await(1, TimeUnit.SECONDS))
    Thread.sleep(25)
    assertTrue(worker.isAlive)

    sink.cancel()
    worker.join(1_000)

    assertFalse(worker.isAlive)
    assertTrue(failure.get() is IllegalStateException)
  }
}

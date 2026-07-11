package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoicePcmPlayerTest {
  @Test
  fun cancellationDuringFinalDrainDoesNotFinishOrFenceReplacement() {
    val firstOutput = FakeOutput(playbackHeadPosition = 0)
    val secondOutput = FakeOutput(playbackHeadPosition = 1)
    val outputs = ArrayDeque(listOf(firstOutput, secondOutput))
    val clock = BlockingDrainClock()
    val finished = mutableListOf<String>()
    val errors = mutableListOf<String>()
    val replacementFinished = CountDownLatch(1)
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {
          synchronized(finished) { finished += it }
          if (it == "replacement") replacementFinished.countDown()
        },
        onError = { id, _ -> synchronized(errors) { errors += id } },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> outputs.removeFirst() },
        clock = clock,
        decodePcm = { byteArrayOf(0, 0) },
      )

    player.start("cancelled", 24_000, 1)
    player.enqueue("cancelled", 0, "ignored")
    player.finish("cancelled", 0)
    assertTrue("first playback did not enter final drain", clock.drainEntered.await(2, TimeUnit.SECONDS))

    player.cancel("cancelled")
    player.start("replacement", 24_000, 1)
    player.enqueue("replacement", 0, "ignored")
    player.finish("replacement", 0)
    clock.allowDrainToContinue.countDown()

    assertTrue("replacement did not finish", replacementFinished.await(2, TimeUnit.SECONDS))
    assertEquals(1, firstOutput.releaseCount)
    assertEquals(listOf(true), firstOutput.releaseFlushes)
    assertEquals(1, secondOutput.releaseCount)
    assertEquals(listOf(false), secondOutput.releaseFlushes)
    assertEquals(listOf("replacement"), synchronized(finished) { finished.toList() })
    assertTrue(synchronized(errors) { errors.isEmpty() })
    player.release()
  }

  @Test
  fun releaseAndLateDrainFailureCleanUpCancelledOutputExactlyOnce() {
    val output = FakeOutput(playbackHeadPosition = 0)
    val clock = BlockingDrainClock(throwAfterRelease = true)
    val errors = mutableListOf<String>()
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = { throw AssertionError("cancelled playback must not finish") },
        onError = { id, _ -> synchronized(errors) { errors += id } },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        clock = clock,
        decodePcm = { byteArrayOf(0, 0) },
      )

    player.start("cancelled", 24_000, 1)
    player.enqueue("cancelled", 0, "ignored")
    player.finish("cancelled", 0)
    assertTrue(clock.drainEntered.await(2, TimeUnit.SECONDS))

    player.cancel("cancelled")
    player.release()
    clock.allowDrainToContinue.countDown()
    assertTrue(clock.drainExited.await(2, TimeUnit.SECONDS))

    assertEquals(1, output.releaseCount)
    assertFalse(synchronized(errors) { errors.isNotEmpty() })
  }

  @Test
  fun cancelledWriteDoesNotEmitConsumedEventForSameIdReplacement() {
    val firstOutput = BlockingWriteOutput()
    val secondOutput = FakeOutput(playbackHeadPosition = 1)
    val outputs = ArrayDeque<T3VoicePcmOutput>(listOf(firstOutput, secondOutput))
    val consumed = mutableListOf<Pair<String, Int>>()
    val replacementFinished = CountDownLatch(1)
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { id, index -> synchronized(consumed) { consumed += id to index } },
        onFinished = { replacementFinished.countDown() },
        onError = { _, cause -> throw AssertionError("playback must not fail", cause) },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> outputs.removeFirst() },
        clock = ImmediatePlaybackClock,
        decodePcm = { byteArrayOf(0, 0) },
      )

    player.start("shared-id", 24_000, 1)
    player.enqueue("shared-id", 0, "ignored")
    assertTrue("first playback did not enter its write", firstOutput.writeEntered.await(2, TimeUnit.SECONDS))

    player.cancel("shared-id")
    player.start("shared-id", 24_000, 1)
    firstOutput.allowWriteToComplete.countDown()
    assertTrue("cancelled write did not exit", firstOutput.writeExited.await(2, TimeUnit.SECONDS))
    assertTrue(synchronized(consumed) { consumed.isEmpty() })

    player.enqueue("shared-id", 0, "ignored")
    player.finish("shared-id", 0)

    assertTrue("replacement did not finish", replacementFinished.await(2, TimeUnit.SECONDS))
    assertEquals(listOf("shared-id" to 0), synchronized(consumed) { consumed.toList() })
    assertEquals(1, firstOutput.releaseCount)
    assertEquals(listOf(true), firstOutput.releaseFlushes)
    assertEquals(1, secondOutput.releaseCount)
    assertEquals(listOf(false), secondOutput.releaseFlushes)
    player.release()
  }

  private class FakeOutput(
    override val playbackHeadPosition: Long,
  ) : T3VoicePcmOutput {
    var releaseCount = 0
    val releaseFlushes = mutableListOf<Boolean>()

    override fun write(pcm: ByteArray, offset: Int, length: Int): Int = length

    override fun release(flush: Boolean) {
      releaseCount += 1
      releaseFlushes += flush
    }
  }

  private class BlockingWriteOutput : T3VoicePcmOutput {
    override val playbackHeadPosition: Long = 0
    val writeEntered = CountDownLatch(1)
    val allowWriteToComplete = CountDownLatch(1)
    val writeExited = CountDownLatch(1)
    var releaseCount = 0
    val releaseFlushes = mutableListOf<Boolean>()

    override fun write(pcm: ByteArray, offset: Int, length: Int): Int {
      writeEntered.countDown()
      check(allowWriteToComplete.await(2, TimeUnit.SECONDS)) { "write was not released" }
      writeExited.countDown()
      return length
    }

    override fun release(flush: Boolean) {
      releaseCount += 1
      releaseFlushes += flush
    }
  }

  private class BlockingDrainClock(
    private val throwAfterRelease: Boolean = false,
  ) : T3VoicePlaybackClock {
    val drainEntered = CountDownLatch(1)
    val allowDrainToContinue = CountDownLatch(1)
    val drainExited = CountDownLatch(1)

    override fun elapsedRealtime(): Long = 0

    override fun sleep(delayMs: Long) {
      drainEntered.countDown()
      try {
        allowDrainToContinue.await(2, TimeUnit.SECONDS)
        if (throwAfterRelease) throw IllegalStateException("late drain failure")
      } finally {
        drainExited.countDown()
      }
    }
  }

  private object ImmediatePlaybackClock : T3VoicePlaybackClock {
    override fun elapsedRealtime(): Long = 0

    override fun sleep(delayMs: Long) = Unit
  }
}

package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Semaphore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class T3VoicePcmPlayerTest {
  @Test
  fun defaultLifetimeCoversFifteenMinutesOfStandardPcm() {
    val limits = T3VoicePcmLimits()
    val standardPcmBytes = 24_000L * 2L * 15L * 60L

    assertTrue(limits.maximumDurationSeconds >= 15 * 60)
    assertTrue(limits.maximumTotalBytes >= standardPcmBytes)
  }

  @Test
  fun prebuffersStoppedOutputBeforeStartingPlayback() {
    val output = FakeOutput(playbackHeadPosition = 24_000)
    val consumed = Semaphore(0)
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> consumed.release() },
        onFinished = {},
        onError = { _, cause -> throw AssertionError("playback must not fail", cause) },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        clock = ImmediatePlaybackClock,
        decodePcm = { ByteArray(12_000) },
      )

    player.start("buffered", 24_000, 1)
    player.enqueue("buffered", 0, "ignored")
    assertTrue(consumed.tryAcquire(2, TimeUnit.SECONDS))
    assertEquals(0, output.startCount)
    player.enqueue("buffered", 1, "ignored")
    assertTrue(consumed.tryAcquire(2, TimeUnit.SECONDS))
    assertEquals(1, output.startCount)
    player.cancel("buffered")
    player.release()
  }

  @Test
  fun finalizedShortPlaybackStartsWithoutFullPrebuffer() {
    val output = FakeOutput(playbackHeadPosition = 1)
    val finished = CountDownLatch(1)
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = { finished.countDown() },
        onError = { _, cause -> throw AssertionError("playback must not fail", cause) },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        clock = ImmediatePlaybackClock,
        decodePcm = { byteArrayOf(0, 0) },
      )

    player.start("short", 24_000, 1)
    player.enqueue("short", 0, "ignored")
    player.finish("short", 0)

    assertTrue(finished.await(2, TimeUnit.SECONDS))
    assertEquals(1, output.startCount)
    player.release()
  }

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
  fun finalDrainTimeoutFailsInsteadOfReportingPlaybackComplete() {
    val output = FakeOutput(playbackHeadPosition = 0)
    val clock = AdvancingPlaybackClock()
    val finished = mutableListOf<String>()
    val errors = mutableListOf<String>()
    val terminal = CountDownLatch(1)
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {
          finished += it
          terminal.countDown()
        },
        onError = { id, _ ->
          errors += id
          terminal.countDown()
        },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        clock = clock,
        decodePcm = { byteArrayOf(0, 0) },
      )

    player.start("stalled-drain", 24_000, 1)
    player.enqueue("stalled-drain", 0, "ignored")
    player.finish("stalled-drain", 0)

    assertTrue("playback did not terminate", terminal.await(2, TimeUnit.SECONDS))
    assertTrue(finished.isEmpty())
    assertEquals(listOf("stalled-drain"), errors)
    assertEquals(listOf(true), output.releaseFlushes)
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

  @Test
  fun validatesOwnerBeforeDecodingAndRejectsPartialFrames() {
    var decodeCount = 0
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {},
        onError = { _, _ -> },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> FakeOutput(0) },
        decodePcm = {
          decodeCount += 1
          byteArrayOf(0, 0, 0)
        },
      )
    player.start("owner", 24_000, 2)

    assertThrows(IllegalStateException::class.java) {
      player.enqueue("stale", 0, "ignored")
    }
    assertEquals(0, decodeCount)
    assertThrows(IllegalArgumentException::class.java) {
      player.enqueue("owner", 0, "ignored")
    }
    assertEquals(1, decodeCount)
    player.cancel("owner")
    player.release()
  }

  @Test
  fun rejectsMalformedBase64BeforeAndroidDecode() {
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {},
        onError = { _, _ -> },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> FakeOutput(0) },
      )
    player.start("owner", 24_000, 1)

    assertThrows(IllegalArgumentException::class.java) {
      player.enqueue("owner", 0, "%%%=")
    }
    player.cancel("owner")
    player.release()
  }

  @Test
  fun enforcesQueuedAndLifetimeBudgets() {
    val output = BlockingWriteOutput()
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {},
        onError = { _, _ -> },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        decodePcm = { byteArrayOf(0, 0) },
        limits =
          T3VoicePcmLimits(
            maximumQueuedChunks = 1,
            maximumQueuedBytes = 2,
            maximumTotalBytes = 20,
          ),
      )
    player.start("bounded", 24_000, 1)
    player.enqueue("bounded", 0, "ignored")
    assertTrue(output.writeEntered.await(2, TimeUnit.SECONDS))
    player.enqueue("bounded", 1, "ignored")

    assertThrows(IllegalStateException::class.java) {
      player.enqueue("bounded", 2, "ignored")
    }
    output.allowWriteToComplete.countDown()
    player.cancel("bounded")
    player.release()
  }

  @Test
  fun enforcesChunkIndexAndTotalByteLimits() {
    val output = BlockingWriteOutput()
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {},
        onError = { _, _ -> },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        decodePcm = { byteArrayOf(0, 0) },
        limits =
          T3VoicePcmLimits(
            maximumIndexGap = 1,
            maximumTotalBytes = 2,
          ),
      )
    player.start("bounded", 24_000, 1)
    assertThrows(IllegalStateException::class.java) {
      player.enqueue("bounded", 2, "ignored")
    }
    player.enqueue("bounded", 0, "ignored")
    assertTrue(output.writeEntered.await(2, TimeUnit.SECONDS))
    assertThrows(IllegalStateException::class.java) {
      player.enqueue("bounded", 1, "ignored")
    }
    output.allowWriteToComplete.countDown()
    player.cancel("bounded")
    player.release()
  }

  @Test
  fun incompleteStreamTimeoutReleasesAndReportsExactlyOnce() {
    val output = FakeOutput(0)
    val scheduler = FakeTimeoutScheduler()
    val errors = mutableListOf<String>()
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = { throw AssertionError("incomplete playback must not finish") },
        onError = { id, _ -> errors += id },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        decodePcm = { byteArrayOf(0, 0) },
        timeoutScheduler = scheduler,
      )
    player.start("incomplete", 24_000, 1)
    player.finish("incomplete", 1)

    scheduler.run()
    scheduler.run()

    assertEquals(listOf("incomplete"), errors)
    assertEquals(1, output.releaseCount)
    assertEquals(listOf(true), output.releaseFlushes)
    assertThrows(IllegalStateException::class.java) { player.cancel("incomplete") }
    player.release()
  }

  @Test
  fun inactivityBeforeFinishReleasesAndAllowsReplacement() {
    val firstOutput = FakeOutput(0)
    val secondOutput = FakeOutput(0)
    val outputs = ArrayDeque<T3VoicePcmOutput>(listOf(firstOutput, secondOutput))
    val scheduler = FakeTimeoutScheduler()
    val errors = mutableListOf<String>()
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {},
        onError = { id, _ -> errors += id },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> outputs.removeFirst() },
        decodePcm = { byteArrayOf(0, 0) },
        timeoutScheduler = scheduler,
      )
    player.start("stalled", 24_000, 1)

    scheduler.run()

    assertEquals(listOf("stalled"), errors)
    assertEquals(1, firstOutput.releaseCount)
    player.start("replacement", 24_000, 1)
    player.cancel("replacement")
    assertEquals(1, secondOutput.releaseCount)
    player.release()
  }

  @Test
  fun lifetimeAcceptanceDoesNotDependOnTransportChunkCount() {
    val consumed = Semaphore(0)
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> consumed.release() },
        onFinished = {},
        onError = { _, cause -> throw AssertionError("bounded playback must not fail", cause) },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> FakeOutput(10_000) },
        decodePcm = { byteArrayOf(0, 0) },
      )
    player.start("fragmented", 24_000, 1)

    repeat(4_100) { index ->
      player.enqueue("fragmented", index, "ignored")
      assertTrue(consumed.tryAcquire(2, TimeUnit.SECONDS))
    }

    player.cancel("fragmented")
    player.release()
  }

  @Test
  fun staleInactivityTimerCannotTerminateRefreshedPlayback() {
    val scheduler = QueuedTimeoutScheduler()
    val errors = mutableListOf<String>()
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = {},
        onError = { id, _ -> errors += id },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> FakeOutput(1) },
        decodePcm = { byteArrayOf(0, 0) },
        timeoutScheduler = scheduler,
      )
    player.start("refreshed", 24_000, 1)
    player.enqueue("refreshed", 0, "ignored")

    scheduler.runEvenIfCancelled(0)

    assertTrue(errors.isEmpty())
    player.cancel("refreshed")
    player.release()
  }

  @Test
  fun transientSuspensionPausesOutputAndResumesWithoutTerminatingPlayback() {
    val output = FakeOutput(1)
    val finished = CountDownLatch(1)
    val scheduler = FakeTimeoutScheduler()
    val errors = mutableListOf<String>()
    val player =
      T3VoicePcmPlayer(
        onChunkConsumed = { _, _ -> },
        onFinished = { finished.countDown() },
        onError = { id, _ -> errors += id },
        outputFactory = T3VoicePcmOutputFactory { _, _ -> output },
        clock = ImmediatePlaybackClock,
        decodePcm = { byteArrayOf(0, 0) },
        timeoutScheduler = scheduler,
      )
    player.start("suspended", 24_000, 1)

    player.pause("suspended")
    player.enqueue("suspended", 0, "ignored")
    player.finish("suspended", 0)
    scheduler.run()
    assertFalse(finished.await(50, TimeUnit.MILLISECONDS))
    assertTrue(errors.isEmpty())
    assertEquals(0, output.pauseCount)

    player.resume("suspended")
    assertTrue(finished.await(2, TimeUnit.SECONDS))
    assertEquals(0, output.resumeCount)
    assertEquals(1, output.startCount)
    player.release()
  }

  private class FakeOutput(
    override val playbackHeadPosition: Long,
  ) : T3VoicePcmOutput {
    var releaseCount = 0
    val releaseFlushes = mutableListOf<Boolean>()
    var pauseCount = 0
    var resumeCount = 0
    var startCount = 0

    override fun setPreferredDevice(device: android.media.AudioDeviceInfo): Boolean = true

    override fun start() {
      startCount += 1
    }

    override fun write(pcm: ByteArray, offset: Int, length: Int): Int = length

    override fun pause() {
      pauseCount += 1
    }

    override fun resume() {
      resumeCount += 1
    }

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

    override fun setPreferredDevice(device: android.media.AudioDeviceInfo): Boolean = true

    override fun start() = Unit

    override fun write(pcm: ByteArray, offset: Int, length: Int): Int {
      writeEntered.countDown()
      check(allowWriteToComplete.await(2, TimeUnit.SECONDS)) { "write was not released" }
      writeExited.countDown()
      return length
    }

    override fun pause() = Unit

    override fun resume() = Unit

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

  private class AdvancingPlaybackClock : T3VoicePlaybackClock {
    private var now = 0L

    override fun elapsedRealtime(): Long = now

    override fun sleep(delayMs: Long) {
      now += delayMs
    }
  }

  private class FakeTimeoutScheduler : T3VoicePlaybackTimeoutScheduler {
    private var action: (() -> Unit)? = null

    override fun schedule(delayMs: Long, action: () -> Unit): T3VoicePlaybackTimeoutTask {
      this.action = action
      return T3VoicePlaybackTimeoutTask { this.action = null }
    }

    fun run() {
      action?.invoke()
    }
  }

  private class QueuedTimeoutScheduler : T3VoicePlaybackTimeoutScheduler {
    private data class Scheduled(val action: () -> Unit, var cancelled: Boolean = false)

    private val scheduled = mutableListOf<Scheduled>()

    override fun schedule(delayMs: Long, action: () -> Unit): T3VoicePlaybackTimeoutTask {
      val task = Scheduled(action)
      scheduled += task
      return T3VoicePlaybackTimeoutTask { task.cancelled = true }
    }

    fun runEvenIfCancelled(index: Int) {
      scheduled[index].action()
    }
  }
}

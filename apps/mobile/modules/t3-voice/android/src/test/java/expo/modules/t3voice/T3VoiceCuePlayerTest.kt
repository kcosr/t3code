package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceCuePlayerTest {
  @Test
  fun `synthesizes assistant ready and ended shapes without preroll`() {
    val ready = T3VoiceCuePcm.synthesize(48_000, T3VoiceCue.READY)
    val ended = T3VoiceCuePcm.synthesize(48_000, T3VoiceCue.ENDED)

    assertEquals(48_000 * (95 + 55 + 140) / 1_000 * 2, ready.size)
    assertEquals(48_000 * 140 / 1_000 * 2, ended.size)
    assertEquals(0, sample(ready, 0))
    assertEquals(0, sample(ready, 48_000 * 95 / 1_000))
    assertEquals(0, sample(ready, 48_000 * 120 / 1_000))
    assertTrue(sample(ready, 48_000 * 30 / 1_000) != 0)
    assertTrue(sample(ended, 48_000 * 30 / 1_000) != 0)
  }

  @Test
  fun `prepends startup silence without changing cue samples`() {
    val cue = T3VoiceCuePcm.synthesize(48_000, T3VoiceCue.ENDED)
    val withPreRoll = T3VoiceCuePcm.withStartupPreRoll(48_000, cue, 512)
    val silenceSamples = 48_000 * 512 / 1_000

    assertEquals((silenceSamples * 2) + cue.size, withPreRoll.size)
    assertEquals(0, sample(withPreRoll, silenceSamples - 1))
    assertEquals(
      sample(cue, 48_000 * 30 / 1_000),
      sample(withPreRoll, silenceSamples + 48_000 * 30 / 1_000),
    )
  }

  @Test
  fun `claims drained exactly once after the playback head reaches written frames`() {
    val output = FakeOutput()
    val fixture = Fixture(outputs = ArrayDeque(listOf(output)))
    val completions = mutableListOf<T3VoiceCueCompletion>()
    val releasedBeforeCompletion = mutableListOf<Boolean>()

    assertTrue(fixture.player.play(T3VoiceCue.ENDED, 1) {
      releasedBeforeCompletion += output.releaseFlushes.isNotEmpty()
      completions += it
    })
    fixture.worker.runAll()
    assertEquals(1, output.playCount)
    assertEquals(listOf("output:play", "output:write"), output.events.take(2))
    output.head = output.written / 2L
    fixture.scheduler.runNext(DRAIN_DELAY)
    fixture.scheduler.runAllIncludingCancelled()
    fixture.worker.runAll()

    assertEquals(listOf(T3VoiceCueOutcome.DRAINED), completions.map { it.outcome })
    assertEquals(listOf(false), output.releaseFlushes)
    assertEquals(listOf(true), releasedBeforeCompletion)
  }

  @Test
  fun `replays a zero-head cold start once and then drains`() {
    val first = FakeOutput()
    val replay = FakeOutput()
    val fixture = Fixture(outputs = ArrayDeque(listOf(first, replay)))
    val completions = mutableListOf<T3VoiceCueCompletion>()

    fixture.player.play(T3VoiceCue.READY, 2, completions::add)
    fixture.worker.runAll()
    fixture.scheduler.runNext(COLD_START_DELAY)
    fixture.worker.runAll()
    replay.head = replay.written / 2L
    fixture.scheduler.runNext(DRAIN_DELAY)
    fixture.worker.runAll()

    assertEquals(2, fixture.createdOutputs)
    assertEquals(listOf(true), first.releaseFlushes)
    assertEquals(listOf(T3VoiceCueOutcome.DRAINED), completions.map { it.outcome })
  }

  @Test
  fun `second zero-head attempt fails open at its bounded timeout`() {
    val clock = FakeClock()
    val fixture = Fixture(clock, ArrayDeque(listOf(FakeOutput(), FakeOutput())))
    val completions = mutableListOf<T3VoiceCueCompletion>()

    fixture.player.play(T3VoiceCue.READY, 3, completions::add)
    fixture.worker.runAll()
    fixture.scheduler.runNext(COLD_START_DELAY)
    fixture.worker.runAll()
    clock.now = READY_TIMEOUT
    fixture.scheduler.runNext(READY_TIMEOUT)
    fixture.worker.runAll()

    assertEquals(listOf(T3VoiceCueOutcome.TIMED_OUT), completions.map { it.outcome })
    assertEquals(2, fixture.createdOutputs)
  }

  @Test
  fun `newer transition cancels old and stale transition cannot replace it`() {
    val fixture = Fixture(outputs = ArrayDeque(listOf(FakeOutput(), FakeOutput())))
    val completions = mutableListOf<T3VoiceCueCompletion>()

    assertTrue(fixture.player.play(T3VoiceCue.READY, 7, completions::add))
    assertTrue(fixture.player.play(T3VoiceCue.ENDED, 8, completions::add))
    assertFalse(fixture.player.play(T3VoiceCue.READY, 7, completions::add))
    fixture.worker.runAll()

    assertEquals(1, completions.size)
    assertEquals(7L, completions.single().generation)
    assertEquals(T3VoiceCueOutcome.CANCELLED, completions.single().outcome)
  }

  @Test
  fun `replacement releases the prior stream before starting the next one`() {
    val events = mutableListOf<String>()
    val first = FakeOutput(label = "first", events = events)
    val second = FakeOutput(label = "second", events = events)
    val fixture = Fixture(outputs = ArrayDeque(listOf(first, second)))

    fixture.player.play(T3VoiceCue.READY, 20) {}
    fixture.worker.runAll()
    fixture.player.play(T3VoiceCue.ENDED, 21) {}
    fixture.worker.runAll()

    assertTrue(events.indexOf("first:release") < events.indexOf("second:play"))
  }

  @Test
  fun `stop settles cancellation immediately without running queued output work`() {
    val fixture = Fixture(outputs = ArrayDeque(listOf(FakeOutput())))
    val completions = mutableListOf<T3VoiceCueCompletion>()

    fixture.player.play(T3VoiceCue.READY, 9, completions::add)
    assertTrue(fixture.player.cancel(9))
    assertFalse(fixture.player.cancel(9))

    assertEquals(listOf(T3VoiceCueOutcome.CANCELLED), completions.map { it.outcome })
    assertEquals(0, fixture.createdOutputs)
  }

  @Test
  fun `write failure claims failed once despite late timers`() {
    val output = FakeOutput(writeResult = 0)
    val fixture = Fixture(outputs = ArrayDeque(listOf(output)))
    val completions = mutableListOf<T3VoiceCueCompletion>()

    fixture.player.play(T3VoiceCue.ENDED, 10, completions::add)
    fixture.worker.runAll()
    fixture.scheduler.runAllIncludingCancelled()
    fixture.worker.runAll()

    assertEquals(listOf(T3VoiceCueOutcome.FAILED), completions.map { it.outcome })
    assertEquals(listOf(true), output.releaseFlushes)
  }

  @Test
  fun `coordinator requests both cue transitions and fences targeted stop`() {
    val readyOutput = FakeOutput()
    val endedOutput = FakeOutput()
    val fixture = Fixture(outputs = ArrayDeque(listOf(readyOutput, endedOutput)))
    val coordinator = T3VoiceCueCoordinator(fixture.player)
    val completions = mutableListOf<T3VoiceCueCompletion>()

    assertTrue(coordinator.requestReady(11, completions::add))
    fixture.worker.runAll()
    readyOutput.head = readyOutput.written / 2L
    fixture.scheduler.runNext(DRAIN_DELAY)
    fixture.worker.runAll()

    assertTrue(coordinator.requestEnded(12, completions::add))
    assertFalse(coordinator.stop(11))
    assertTrue(coordinator.stop(12))

    assertEquals(listOf(T3VoiceCue.READY, T3VoiceCue.ENDED), completions.map { it.cue })
    assertEquals(
      listOf(T3VoiceCueOutcome.DRAINED, T3VoiceCueOutcome.CANCELLED),
      completions.map { it.outcome },
    )
  }

  private class Fixture(
    clock: FakeClock = FakeClock(),
    private val outputs: ArrayDeque<FakeOutput>,
  ) {
    val scheduler = FakeScheduler()
    val worker = FakeWorker()
    var createdOutputs = 0
    val player =
      T3VoiceCuePlayer(
        outputFactory = T3VoiceCueOutputFactory { _, _ ->
          createdOutputs += 1
          outputs.removeFirst()
        },
        clock = clock,
        scheduler = scheduler,
        worker = worker,
        coldStartCheckMs = COLD_START_DELAY,
        drainPollMs = DRAIN_DELAY,
        timeoutMs = TIMEOUT,
        recordDiagnostic = { _, _, _ -> },
      )
  }

  private class FakeOutput(
    private val writeResult: Int? = null,
    private val label: String = "output",
    val events: MutableList<String> = mutableListOf(),
  ) : T3VoiceCueOutput {
    var head = 0L
    var written = 0
    var playCount = 0
    val releaseFlushes = mutableListOf<Boolean>()

    override val playbackHeadPosition: Long
      get() = head

    override fun write(pcm: ByteArray, offset: Int, length: Int): Int {
      events += "$label:write"
      val result = writeResult ?: length
      if (result > 0) written += result
      return result
    }

    override fun play() {
      events += "$label:play"
      playCount += 1
    }

    override fun release(flush: Boolean) {
      events += "$label:release"
      releaseFlushes += flush
    }
  }

  private class FakeClock(var now: Long = 0) : T3VoiceCueClock {
    override fun elapsedRealtime(): Long = now
  }

  private class FakeWorker : T3VoiceCueWorker {
    private val actions = ArrayDeque<() -> Unit>()

    override fun execute(action: () -> Unit) {
      actions += action
    }

    fun runAll() {
      while (actions.isNotEmpty()) actions.removeFirst().invoke()
    }
  }

  private class FakeScheduler : T3VoiceCueScheduler {
    private data class Scheduled(val delay: Long, val action: () -> Unit, var cancelled: Boolean = false)

    private val actions = mutableListOf<Scheduled>()

    override fun schedule(delayMs: Long, action: () -> Unit): T3VoiceCueTask {
      val scheduled = Scheduled(delayMs, action)
      actions += scheduled
      return T3VoiceCueTask { scheduled.cancelled = true }
    }

    fun runNext(delay: Long) {
      val index = actions.indexOfFirst { !it.cancelled && it.delay == delay }
      check(index >= 0) { "No scheduled action at $delay ms." }
      actions.removeAt(index).action()
    }

    fun runAllIncludingCancelled() {
      val queued = actions.toList()
      actions.clear()
      queued.forEach { it.action() }
    }
  }

  private fun sample(pcm: ByteArray, index: Int): Int {
    val offset = index * 2
    return ((pcm[offset + 1].toInt() shl 8) or (pcm[offset].toInt() and 0xff)).toShort().toInt()
  }

  private companion object {
    const val COLD_START_DELAY = 220L
    const val DRAIN_DELAY = 10L
    const val TIMEOUT = 1_500L
    const val READY_TIMEOUT = 2_354L
  }
}

package expo.modules.t3voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.PI
import kotlin.math.sin

internal enum class T3VoiceCue {
  READY,
  ENDED,
}

internal enum class T3VoiceCueOutcome {
  DRAINED,
  CANCELLED,
  FAILED,
  TIMED_OUT,
}

internal data class T3VoiceCueCompletion(
  val generation: Long,
  val cue: T3VoiceCue,
  val outcome: T3VoiceCueOutcome,
)

internal interface T3VoiceCueOutput {
  val playbackHeadPosition: Long

  fun write(pcm: ByteArray, offset: Int, length: Int): Int

  fun play()

  fun release(flush: Boolean)
}

internal fun interface T3VoiceCueOutputFactory {
  fun create(sampleRate: Int, byteCount: Int): T3VoiceCueOutput
}

internal fun interface T3VoiceCueTask {
  fun cancel()
}

internal interface T3VoiceCueScheduler {
  fun schedule(delayMs: Long, action: () -> Unit): T3VoiceCueTask
}

internal fun interface T3VoiceCueWorker {
  fun execute(action: () -> Unit)
}

internal fun interface T3VoiceCueClock {
  fun elapsedRealtime(): Long
}

internal class T3VoiceCuePlayer(
  private val outputFactory: T3VoiceCueOutputFactory = AndroidCueOutputFactory,
  private val clock: T3VoiceCueClock = AndroidCueClock,
  private val scheduler: T3VoiceCueScheduler = AndroidCueScheduler,
  private val worker: T3VoiceCueWorker = AndroidCueWorker,
  private val sampleRate: Int = SAMPLE_RATE,
  private val coldStartCheckMs: Long = COLD_START_CHECK_MS,
  private val drainPollMs: Long = DRAIN_POLL_MS,
  private val timeoutMs: Long = TIMEOUT_MS,
  private val recordDiagnostic: (Long, T3VoiceDiagnosticCategory, T3VoiceDiagnosticCode) -> Unit =
    { generation, category, code -> T3VoiceDiagnostics.record(generation, category, code) },
) {
  private data class ActiveCue(
    val generation: Long,
    val cue: T3VoiceCue,
    val pcm: ByteArray,
    val deadlineAtMs: Long,
    val completion: (T3VoiceCueCompletion) -> Unit,
    val terminalClaimed: AtomicBoolean = AtomicBoolean(false),
    val attemptTasks: MutableList<T3VoiceCueTask> = mutableListOf(),
    var attempt: Int = 0,
    var output: T3VoiceCueOutput? = null,
    var timeoutTask: T3VoiceCueTask? = null,
  )

  private val lock = Any()
  private var active: ActiveCue? = null
  private var highestGeneration = 0L
  private var released = false

  init {
    require(sampleRate in 16_000..48_000)
    require(coldStartCheckMs > 0 && drainPollMs > 0 && timeoutMs > coldStartCheckMs)
  }

  fun play(
    cue: T3VoiceCue,
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean {
    require(generation > 0)
    val replaced: ActiveCue?
    val next: ActiveCue
    synchronized(lock) {
      if (released || generation <= highestGeneration) return false
      highestGeneration = generation
      replaced = active
      next =
        ActiveCue(
          generation,
          cue,
          T3VoiceCuePcm.withStartupPreRoll(
            sampleRate,
            T3VoiceCuePcm.synthesize(sampleRate, cue),
            STARTUP_PRE_ROLL_MS,
          ),
          clock.elapsedRealtime() + timeoutMs,
          completion,
        )
      active = next
      next.timeoutTask = scheduler.schedule(timeoutMs) { checkTimeout(next) }
    }
    recordDiagnostic(
      generation,
      T3VoiceDiagnosticCategory.LIFECYCLE,
      if (cue == T3VoiceCue.READY) {
        T3VoiceDiagnosticCode.CUE_READY_STARTED
      } else {
        T3VoiceDiagnosticCode.CUE_ENDED_STARTED
      },
    )
    replaced?.let { settle(it, T3VoiceCueOutcome.CANCELLED, flush = true) }
    worker.execute { startAttempt(next) }
    return true
  }

  fun cancel(generation: Long): Boolean {
    val current = synchronized(lock) { active?.takeIf { it.generation == generation } } ?: return false
    settle(current, T3VoiceCueOutcome.CANCELLED, flush = true)
    return true
  }

  fun cancelActive(): Boolean {
    val current = synchronized(lock) { active } ?: return false
    settle(current, T3VoiceCueOutcome.CANCELLED, flush = true)
    return true
  }

  fun release() {
    val current = synchronized(lock) {
      if (released) return
      released = true
      active
    }
    current?.let { settle(it, T3VoiceCueOutcome.CANCELLED, flush = true) }
  }

  private fun startAttempt(cue: ActiveCue) {
    if (!isCurrent(cue)) return
    val output = try {
      outputFactory.create(sampleRate, cue.pcm.size)
    } catch (_: Throwable) {
      settle(cue, T3VoiceCueOutcome.FAILED, flush = true)
      return
    }
    synchronized(lock) {
      if (active !== cue || cue.terminalClaimed.get()) {
        worker.execute { runCatching { output.release(true) } }
        return
      }
      cue.output = output
    }
    try {
      output.play()
      var offset = 0
      while (offset < cue.pcm.size && isCurrent(cue)) {
        val written = output.write(cue.pcm, offset, cue.pcm.size - offset)
        check(written > 0) { "Cue output stopped accepting PCM." }
        offset += written
      }
      if (!isCurrent(cue)) return
      synchronized(lock) {
        if (active !== cue || cue.output !== output || cue.terminalClaimed.get()) return
        cue.attemptTasks += scheduler.schedule(coldStartCheckMs) { checkColdStart(cue, output) }
        cue.attemptTasks += scheduler.schedule(drainPollMs) { checkDrain(cue, output) }
      }
    } catch (_: Throwable) {
      settle(cue, T3VoiceCueOutcome.FAILED, flush = true)
    }
  }

  private fun checkColdStart(cue: ActiveCue, output: T3VoiceCueOutput) {
    if (!owns(cue, output) || output.playbackHeadPosition > 0) return
    val replay = synchronized(lock) {
      if (!ownsLocked(cue, output) || cue.attempt >= MAX_REPLAY_ATTEMPTS) return@synchronized false
      cue.attempt += 1
      cue.output = null
      cue.attemptTasks.forEach(T3VoiceCueTask::cancel)
      cue.attemptTasks.clear()
      true
    }
    if (!replay) return
    worker.execute {
      runCatching { output.release(true) }
      startAttempt(cue)
    }
  }

  private fun checkDrain(cue: ActiveCue, output: T3VoiceCueOutput) {
    if (!owns(cue, output)) return
    val targetFrames = cue.pcm.size / Short.SIZE_BYTES
    if (output.playbackHeadPosition >= targetFrames) {
      settle(cue, T3VoiceCueOutcome.DRAINED, flush = false)
      return
    }
    synchronized(lock) {
      if (ownsLocked(cue, output)) {
        cue.attemptTasks += scheduler.schedule(drainPollMs) { checkDrain(cue, output) }
      }
    }
  }

  private fun checkTimeout(cue: ActiveCue) {
    if (!isCurrent(cue)) return
    val remainingMs = cue.deadlineAtMs - clock.elapsedRealtime()
    if (remainingMs <= 0) {
      settle(cue, T3VoiceCueOutcome.TIMED_OUT, flush = true)
    } else {
      synchronized(lock) {
        if (active === cue && !cue.terminalClaimed.get()) {
          cue.timeoutTask = scheduler.schedule(remainingMs) { checkTimeout(cue) }
        }
      }
    }
  }

  private fun settle(cue: ActiveCue, outcome: T3VoiceCueOutcome, flush: Boolean) {
    if (!cue.terminalClaimed.compareAndSet(false, true)) return
    recordDiagnostic(
      cue.generation,
      T3VoiceDiagnosticCategory.TERMINAL,
      when (outcome) {
        T3VoiceCueOutcome.DRAINED -> T3VoiceDiagnosticCode.CUE_DRAINED
        T3VoiceCueOutcome.CANCELLED -> T3VoiceDiagnosticCode.CUE_CANCELLED
        T3VoiceCueOutcome.FAILED -> T3VoiceDiagnosticCode.CUE_FAILED
        T3VoiceCueOutcome.TIMED_OUT -> T3VoiceDiagnosticCode.CUE_TIMED_OUT
      },
    )
    val output = synchronized(lock) {
      if (active === cue) active = null
      cue.attemptTasks.forEach(T3VoiceCueTask::cancel)
      cue.attemptTasks.clear()
      cue.timeoutTask?.cancel()
      cue.timeoutTask = null
      cue.output.also { cue.output = null }
    }
    val complete = {
      if (output != null) runCatching { output.release(flush) }
      cue.completion(T3VoiceCueCompletion(cue.generation, cue.cue, outcome))
    }
    if (output != null) worker.execute(complete) else complete()
  }

  private fun isCurrent(cue: ActiveCue): Boolean =
    synchronized(lock) { active === cue && !cue.terminalClaimed.get() }

  private fun owns(cue: ActiveCue, output: T3VoiceCueOutput): Boolean =
    synchronized(lock) { ownsLocked(cue, output) }

  private fun ownsLocked(cue: ActiveCue, output: T3VoiceCueOutput): Boolean =
    active === cue && cue.output === output && !cue.terminalClaimed.get()

  private companion object {
    const val SAMPLE_RATE = 48_000
    const val STARTUP_PRE_ROLL_MS = 512
    const val COLD_START_CHECK_MS = 220L
    const val DRAIN_POLL_MS = 10L
    const val TIMEOUT_MS = 1_500L
    const val MAX_REPLAY_ATTEMPTS = 1
  }
}

internal object T3VoiceCuePcm {
  private data class Segment(val frequencyHz: Double, val durationMs: Int, val amplitude: Float)

  fun synthesize(sampleRate: Int, cue: T3VoiceCue): ByteArray {
    require(sampleRate > 0)
    val segments = when (cue) {
      T3VoiceCue.READY ->
        listOf(Segment(523.25, 95, 0.14f), Segment(0.0, 55, 0f), Segment(659.25, 140, 0.16f))
      T3VoiceCue.ENDED -> listOf(Segment(659.25, 140, 0.16f))
    }
    val sampleCount = segments.sumOf { sampleRate * it.durationMs / 1_000 }
    val pcm = ByteArray(sampleCount * Short.SIZE_BYTES)
    var sampleOffset = 0
    segments.forEach { segment ->
      val segmentSamples = sampleRate * segment.durationMs / 1_000
      val fadeWindow = maxOf(sampleRate / 80, 12)
      repeat(segmentSamples) { index ->
        val fadeIn = (index.toFloat() / fadeWindow).coerceIn(0f, 1f)
        val fadeOut = ((segmentSamples - index).toFloat() / fadeWindow).coerceIn(0f, 1f)
        val envelope = minOf(fadeIn, fadeOut)
        val value =
          if (segment.frequencyHz > 0 && segment.amplitude > 0f) {
            sin(2.0 * PI * segment.frequencyHz * index / sampleRate) *
              Short.MAX_VALUE * segment.amplitude * envelope
          } else {
            0.0
          }
        val sample = value.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
        val byteOffset = (sampleOffset + index) * Short.SIZE_BYTES
        pcm[byteOffset] = (sample and 0xff).toByte()
        pcm[byteOffset + 1] = (sample shr 8).toByte()
      }
      sampleOffset += segmentSamples
    }
    return pcm
  }

  fun withStartupPreRoll(sampleRate: Int, pcm: ByteArray, durationMs: Int): ByteArray {
    require(sampleRate > 0)
    require(durationMs >= 0)
    if (durationMs == 0) return pcm
    val silenceBytes = sampleRate * durationMs / 1_000 * Short.SIZE_BYTES
    return ByteArray(silenceBytes + pcm.size).also { output ->
      pcm.copyInto(output, destinationOffset = silenceBytes)
    }
  }
}

private object AndroidCueOutputFactory : T3VoiceCueOutputFactory {
  override fun create(sampleRate: Int, byteCount: Int): T3VoiceCueOutput {
    val minimumBufferSize =
      AudioTrack.getMinBufferSize(
        sampleRate,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    check(minimumBufferSize > 0) { "Cue AudioTrack buffer sizing failed." }
    val track =
      AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        )
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(maxOf(minimumBufferSize, byteCount))
        .build()
    check(track.state == AudioTrack.STATE_INITIALIZED) { "Cue AudioTrack initialization failed." }
    return object : T3VoiceCueOutput {
      override val playbackHeadPosition: Long
        get() = track.playbackHeadPosition.toLong() and 0xffff_ffffL

      override fun write(pcm: ByteArray, offset: Int, length: Int): Int =
        track.write(pcm, offset, length, AudioTrack.WRITE_BLOCKING)

      override fun play() = track.play()

      override fun release(flush: Boolean) {
        runCatching { track.stop() }
        if (flush) runCatching { track.flush() }
        track.release()
      }
    }
  }
}

private object AndroidCueClock : T3VoiceCueClock {
  override fun elapsedRealtime(): Long = SystemClock.elapsedRealtime()
}

private object AndroidCueWorker : T3VoiceCueWorker {
  private val executor: ExecutorService = Executors.newCachedThreadPool()

  override fun execute(action: () -> Unit) {
    executor.execute(action)
  }
}

private object AndroidCueScheduler : T3VoiceCueScheduler {
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()

  override fun schedule(delayMs: Long, action: () -> Unit): T3VoiceCueTask {
    val future: ScheduledFuture<*> = executor.schedule(action, delayMs, TimeUnit.MILLISECONDS)
    return T3VoiceCueTask { future.cancel(false) }
  }
}

package expo.modules.t3voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import android.os.SystemClock
import java.util.TreeMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal interface T3VoicePcmOutput {
  val playbackHeadPosition: Long

  fun write(pcm: ByteArray, offset: Int, length: Int): Int

  fun pause()

  fun resume()

  fun release(flush: Boolean)
}

internal fun interface T3VoicePcmOutputFactory {
  fun create(sampleRate: Int, channelCount: Int): T3VoicePcmOutput
}

internal interface T3VoicePlaybackClock {
  fun elapsedRealtime(): Long

  fun sleep(delayMs: Long)
}

internal data class T3VoicePcmLimits(
  val maximumEncodedChunkBytes: Int = 350_000,
  val maximumDecodedChunkBytes: Int = 256 * 1_024,
  val maximumQueuedBytes: Int = 1_024 * 1_024,
  val maximumQueuedChunks: Int = 8,
  val maximumIndexGap: Int = 8,
  val maximumTotalBytes: Long = 48L * 1_024L * 1_024L,
  val maximumDurationSeconds: Int = 15 * 60,
  val inactivityTimeoutMs: Long = 30_000,
)

internal fun interface T3VoicePlaybackTimeoutScheduler {
  fun schedule(delayMs: Long, action: () -> Unit): T3VoicePlaybackTimeoutTask
}

internal fun interface T3VoicePlaybackTimeoutTask {
  fun cancel()
}

internal class T3VoicePcmPlayer(
  private val onChunkConsumed: (String, Int) -> Unit,
  private val onFinished: (String) -> Unit,
  private val onError: (String, Throwable) -> Unit,
  private val outputFactory: T3VoicePcmOutputFactory = AndroidPcmOutputFactory,
  private val clock: T3VoicePlaybackClock = AndroidPlaybackClock,
  private val decodePcm: (String) -> ByteArray = ::decodeStrictPcm,
  private val limits: T3VoicePcmLimits = T3VoicePcmLimits(),
  private val timeoutScheduler: T3VoicePlaybackTimeoutScheduler = AndroidTimeoutScheduler,
) {
  private data class ActivePlayback(
    val playbackId: String,
    val output: T3VoicePcmOutput,
    val bytesPerFrame: Int,
    val sampleRate: Int,
    val pending: TreeMap<Int, ByteArray> = TreeMap(),
    var nextChunkIndex: Int = 0,
    var finalChunkIndex: Int? = null,
    @Volatile var cancelled: Boolean = false,
    @Volatile var paused: Boolean = false,
    var framesWritten: Long = 0,
    var queuedBytes: Int = 0,
    var acceptedBytes: Long = 0,
    var acceptedFrames: Long = 0,
    var drainScheduled: Boolean = false,
    var incompleteTimeout: T3VoicePlaybackTimeoutTask? = null,
    var timeoutGeneration: Long = 0,
    val released: AtomicBoolean = AtomicBoolean(false),
  )

  private val executor = Executors.newSingleThreadExecutor()
  private val lock = Any()
  private var active: ActivePlayback? = null

  fun start(playbackId: String, sampleRate: Int, channelCount: Int) {
    require(sampleRate in MIN_SAMPLE_RATE..MAX_SAMPLE_RATE) { "Unsupported PCM sample rate." }
    require(channelCount == 1 || channelCount == 2) { "PCM playback supports one or two channels." }
    synchronized(lock) {
      check(active == null) { "A voice playback is already active." }
      val playback =
        ActivePlayback(
          playbackId = playbackId,
          output = outputFactory.create(sampleRate, channelCount),
          bytesPerFrame = channelCount * Short.SIZE_BYTES,
          sampleRate = sampleRate,
        )
      active = playback
      armInactivityTimeoutLocked(playback)
    }
  }

  fun enqueue(playbackId: String, chunkIndex: Int, pcmBase64: String) {
    require(chunkIndex >= 0) { "PCM chunk indexes must be non-negative." }
    require(pcmBase64.length <= limits.maximumEncodedChunkBytes) { "PCM chunk is too large." }
    synchronized(lock) {
      val playback = requireActive(playbackId)
      val pcm = decodePcm(pcmBase64)
      require(pcm.isNotEmpty()) { "PCM chunks must not be empty." }
      require(pcm.size <= limits.maximumDecodedChunkBytes) { "PCM chunk is too large." }
      require(pcm.size % playback.bytesPerFrame == 0) { "PCM chunk ended on a partial frame." }
      check(chunkIndex >= playback.nextChunkIndex) { "PCM chunk $chunkIndex was already consumed." }
      check(chunkIndex.toLong() - playback.nextChunkIndex <= limits.maximumIndexGap) {
        "PCM chunk $chunkIndex is too far ahead of the playback cursor."
      }
      check(!playback.pending.containsKey(chunkIndex)) { "PCM chunk $chunkIndex was already queued." }
      val finalIndex = playback.finalChunkIndex
      check(finalIndex == null || chunkIndex <= finalIndex) {
        "PCM chunk $chunkIndex is after the declared final chunk $finalIndex."
      }
      check(playback.pending.size < limits.maximumQueuedChunks) { "PCM playback queue is full." }
      check(playback.queuedBytes.toLong() + pcm.size <= limits.maximumQueuedBytes) {
        "PCM playback queue byte limit was exceeded."
      }
      check(playback.acceptedBytes + pcm.size <= limits.maximumTotalBytes) {
        "PCM playback byte limit was exceeded."
      }
      val frames = pcm.size / playback.bytesPerFrame
      val maximumFrames = playback.sampleRate.toLong() * limits.maximumDurationSeconds
      check(playback.acceptedFrames + frames <= maximumFrames) {
        "PCM playback duration limit was exceeded."
      }
      playback.pending[chunkIndex] = pcm
      playback.queuedBytes += pcm.size
      playback.acceptedBytes += pcm.size
      playback.acceptedFrames += frames
      armInactivityTimeoutLocked(playback)
      scheduleDrainLocked(playback)
    }
  }

  fun finish(playbackId: String, finalChunkIndex: Int) {
    require(finalChunkIndex >= 0) { "The final PCM chunk index must be non-negative." }
    synchronized(lock) {
      val playback = requireActive(playbackId)
      check(playback.finalChunkIndex == null) { "PCM playback was already finished." }
      check(finalChunkIndex >= playback.nextChunkIndex - 1) {
        "The final PCM chunk index precedes consumed audio."
      }
      check(finalChunkIndex.toLong() - playback.nextChunkIndex <= limits.maximumIndexGap) {
        "The final PCM chunk index is too far ahead of the playback cursor."
      }
      playback.finalChunkIndex = finalChunkIndex
      if (finalChunkIndex != playback.nextChunkIndex - 1) armInactivityTimeoutLocked(playback)
      scheduleDrainLocked(playback)
    }
  }

  fun cancel(playbackId: String) {
    val playback =
      synchronized(lock) {
        val current = requireActive(playbackId)
        current.cancelled = true
        current.pending.clear()
        current.queuedBytes = 0
        active = null
        current
      }
    releaseOutputOnce(playback, flush = true)
  }

  fun pause(playbackId: String) {
    synchronized(lock) {
      val playback = requireActive(playbackId)
      if (playback.paused) return
      playback.paused = true
      cancelIncompleteTimeoutLocked(playback)
      playback.output.pause()
    }
  }

  fun resume(playbackId: String) {
    synchronized(lock) {
      val playback = requireActive(playbackId)
      if (!playback.paused) return
      playback.output.resume()
      playback.paused = false
      armInactivityTimeoutLocked(playback)
      scheduleDrainLocked(playback)
    }
  }

  fun release() {
    val playback =
      synchronized(lock) {
        val current = active
        current?.cancelled = true
        active = null
        current
      }
    if (playback != null) {
      releaseOutputOnce(playback, flush = true)
    }
    executor.shutdownNow()
  }

  private fun scheduleDrainLocked(playback: ActivePlayback) {
    if (playback.drainScheduled) return
    playback.drainScheduled = true
    executor.execute { drain(playback) }
  }

  private fun drain(playback: ActivePlayback) {
    try {
      while (true) {
        val next =
          synchronized(lock) {
            if (active !== playback || playback.cancelled) {
              playback.drainScheduled = false
              return
            }
            if (playback.paused) {
              playback.drainScheduled = false
              return
            }
            val pcm = playback.pending.remove(playback.nextChunkIndex)
            if (pcm == null) {
              val isComplete = playback.finalChunkIndex == playback.nextChunkIndex - 1
              if (!isComplete) playback.drainScheduled = false
              Triple(playback, null, isComplete)
            } else {
              playback.queuedBytes -= pcm.size
              val chunkIndex = playback.nextChunkIndex
              playback.nextChunkIndex += 1
              Triple(playback, chunkIndex to pcm, false)
            }
          }

        if (next.third) {
          synchronized(lock) {
            if (active === playback) cancelIncompleteTimeoutLocked(playback)
          }
          check(awaitPlaybackDrain(next.first)) {
            "PCM playback did not drain before the deadline."
          }
          val completed =
            synchronized(lock) {
              if (active !== playback || playback.cancelled) {
                false
              } else {
                active = null
                playback.drainScheduled = false
                true
              }
            }
          releaseOutputOnce(playback, flush = !completed)
          if (completed) onFinished(playback.playbackId)
          return
        }
        val chunk = next.second ?: return
        writeFully(next.first, chunk.second)
        val stillOwned =
          synchronized(lock) {
            val ownsPlayback = active === next.first && !next.first.cancelled
            if (ownsPlayback) armInactivityTimeoutLocked(next.first)
            ownsPlayback
          }
        if (stillOwned) onChunkConsumed(next.first.playbackId, chunk.first)
      }
    } catch (cause: Throwable) {
      val reportError =
        synchronized(lock) {
          val ownsActivePlayback = active === playback
          if (ownsActivePlayback) active = null
          playback.drainScheduled = false
          ownsActivePlayback && !playback.cancelled
        }
      releaseOutputOnce(playback, flush = true)
      if (reportError) onError(playback.playbackId, cause)
    }
  }

  private fun writeFully(playback: ActivePlayback, pcm: ByteArray) {
    require(pcm.size % playback.bytesPerFrame == 0) { "PCM chunk ended on a partial frame." }
    var offset = 0
    while (offset < pcm.size) {
      if (playback.cancelled) {
        return
      }
      val written = playback.output.write(pcm, offset, pcm.size - offset)
      check(written > 0) { "AudioTrack write failed with code $written." }
      offset += written
      playback.framesWritten += written / playback.bytesPerFrame
    }
  }

  private fun awaitPlaybackDrain(playback: ActivePlayback): Boolean {
    val maximumWaitMs =
      ((playback.framesWritten * 1_000L) / playback.sampleRate + DRAIN_GRACE_MS)
        .coerceAtMost(MAXIMUM_DRAIN_WAIT_MS)
    var deadline = clock.elapsedRealtime() + maximumWaitMs
    while (!playback.cancelled && clock.elapsedRealtime() < deadline) {
      if (playback.paused) {
        clock.sleep(DRAIN_POLL_INTERVAL_MS)
        deadline += DRAIN_POLL_INTERVAL_MS
        continue
      }
      val playedFrames = playback.output.playbackHeadPosition and 0xffffffffL
      if (playedFrames >= playback.framesWritten) {
        return true
      }
      clock.sleep(DRAIN_POLL_INTERVAL_MS)
    }
    return playback.cancelled ||
      (playback.output.playbackHeadPosition and 0xffffffffL) >= playback.framesWritten
  }

  private fun requireActive(playbackId: String): ActivePlayback {
    val playback = active ?: error("No PCM playback is active.")
    check(playback.playbackId == playbackId) {
      "Playback $playbackId does not own the active player."
    }
    return playback
  }

  private fun releaseOutputOnce(playback: ActivePlayback, flush: Boolean) {
    synchronized(lock) { cancelIncompleteTimeoutLocked(playback) }
    if (playback.released.compareAndSet(false, true)) playback.output.release(flush)
  }

  private fun armInactivityTimeoutLocked(playback: ActivePlayback) {
    if (playback.paused) return
    cancelIncompleteTimeoutLocked(playback)
    val timeoutGeneration = playback.timeoutGeneration
    playback.incompleteTimeout =
      timeoutScheduler.schedule(limits.inactivityTimeoutMs) {
        val timedOut =
          synchronized(lock) {
            if (
              active !== playback ||
                playback.cancelled ||
                playback.timeoutGeneration != timeoutGeneration
            ) return@schedule
            active = null
            playback.cancelled = true
            playback.pending.clear()
            playback.queuedBytes = 0
            playback
          }
        releaseOutputOnce(timedOut, flush = true)
        onError(timedOut.playbackId, IllegalStateException("PCM playback stream became inactive."))
      }
  }

  private fun cancelIncompleteTimeoutLocked(playback: ActivePlayback) {
    playback.timeoutGeneration += 1
    playback.incompleteTimeout?.cancel()
    playback.incompleteTimeout = null
  }

  companion object {
    private const val MIN_SAMPLE_RATE = 8_000
    private const val MAX_SAMPLE_RATE = 48_000
    private const val TARGET_BUFFER_BYTES = 48_000
    private const val DRAIN_GRACE_MS = 500L
    private const val MAXIMUM_DRAIN_WAIT_MS = 30_000L
    private const val DRAIN_POLL_INTERVAL_MS = 10L
    private val BASE64_PATTERN =
      Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")

    private fun decodeStrictPcm(value: String): ByteArray {
      require(value.isNotEmpty() && value.length % 4 == 0 && BASE64_PATTERN.matches(value)) {
        "PCM chunk is not valid Base64."
      }
      return Base64.decode(value, Base64.NO_WRAP)
    }
  }

  private object AndroidPlaybackClock : T3VoicePlaybackClock {
    override fun elapsedRealtime(): Long = SystemClock.elapsedRealtime()

    override fun sleep(delayMs: Long) = Thread.sleep(delayMs)
  }

  private object AndroidTimeoutScheduler : T3VoicePlaybackTimeoutScheduler {
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()

    override fun schedule(delayMs: Long, action: () -> Unit): T3VoicePlaybackTimeoutTask {
      val future: ScheduledFuture<*> = executor.schedule(action, delayMs, TimeUnit.MILLISECONDS)
      return T3VoicePlaybackTimeoutTask { future.cancel(false) }
    }
  }

  private object AndroidPcmOutputFactory : T3VoicePcmOutputFactory {
    override fun create(sampleRate: Int, channelCount: Int): T3VoicePcmOutput {
      val channelMask =
        if (channelCount == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
      val minimumBuffer =
        AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
      check(minimumBuffer > 0) { "Android could not allocate a PCM playback buffer." }
      val format =
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(sampleRate)
          .setChannelMask(channelMask)
          .build()
      val attributes =
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      val track =
        AudioTrack.Builder()
          .setAudioAttributes(attributes)
          .setAudioFormat(format)
          .setBufferSizeInBytes(maxOf(minimumBuffer * 2, TARGET_BUFFER_BYTES))
          .setTransferMode(AudioTrack.MODE_STREAM)
          .build()
      check(track.state == AudioTrack.STATE_INITIALIZED) { "Android could not initialize PCM playback." }
      track.play()
      return object : T3VoicePcmOutput {
        override val playbackHeadPosition: Long
          get() = track.playbackHeadPosition.toLong()

        override fun write(pcm: ByteArray, offset: Int, length: Int): Int =
          track.write(pcm, offset, length, AudioTrack.WRITE_BLOCKING)

        override fun pause() = track.pause()

        override fun resume() = track.play()

        override fun release(flush: Boolean) {
          try {
            track.pause()
            if (flush) track.flush()
            track.stop()
          } catch (_: IllegalStateException) {
            // The track may already be stopped after an audio-device failure.
          } finally {
            track.release()
          }
        }
      }
    }
  }
}

package expo.modules.t3voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import android.os.SystemClock
import java.util.TreeMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal interface T3VoicePcmOutput {
  val playbackHeadPosition: Long

  fun write(pcm: ByteArray, offset: Int, length: Int): Int

  fun release(flush: Boolean)
}

internal fun interface T3VoicePcmOutputFactory {
  fun create(sampleRate: Int, channelCount: Int): T3VoicePcmOutput
}

internal interface T3VoicePlaybackClock {
  fun elapsedRealtime(): Long

  fun sleep(delayMs: Long)
}

internal class T3VoicePcmPlayer(
  private val onChunkConsumed: (String, Int) -> Unit,
  private val onFinished: (String) -> Unit,
  private val onError: (String, Throwable) -> Unit,
  private val outputFactory: T3VoicePcmOutputFactory = AndroidPcmOutputFactory,
  private val clock: T3VoicePlaybackClock = AndroidPlaybackClock,
  private val decodePcm: (String) -> ByteArray = { Base64.decode(it, Base64.DEFAULT) },
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
    var framesWritten: Long = 0,
    var drainScheduled: Boolean = false,
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
      active =
        ActivePlayback(
          playbackId = playbackId,
          output = outputFactory.create(sampleRate, channelCount),
          bytesPerFrame = channelCount * Short.SIZE_BYTES,
          sampleRate = sampleRate,
        )
    }
  }

  fun enqueue(playbackId: String, chunkIndex: Int, pcmBase64: String) {
    require(chunkIndex >= 0) { "PCM chunk indexes must be non-negative." }
    val pcm = decodePcm(pcmBase64)
    require(pcm.isNotEmpty()) { "PCM chunks must not be empty." }
    synchronized(lock) {
      val playback = requireActive(playbackId)
      check(chunkIndex >= playback.nextChunkIndex) { "PCM chunk $chunkIndex was already consumed." }
      check(playback.pending.putIfAbsent(chunkIndex, pcm) == null) {
        "PCM chunk $chunkIndex was already queued."
      }
      val finalIndex = playback.finalChunkIndex
      check(finalIndex == null || chunkIndex <= finalIndex) {
        "PCM chunk $chunkIndex is after the declared final chunk $finalIndex."
      }
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
      playback.finalChunkIndex = finalChunkIndex
      scheduleDrainLocked(playback)
    }
  }

  fun cancel(playbackId: String) {
    val playback =
      synchronized(lock) {
        val current = requireActive(playbackId)
        current.cancelled = true
        current.pending.clear()
        active = null
        current
      }
    releaseOutputOnce(playback, flush = true)
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
            val pcm = playback.pending.remove(playback.nextChunkIndex)
            if (pcm == null) {
              val isComplete = playback.finalChunkIndex == playback.nextChunkIndex - 1
              if (!isComplete) playback.drainScheduled = false
              Triple(playback, null, isComplete)
            } else {
              val chunkIndex = playback.nextChunkIndex
              playback.nextChunkIndex += 1
              Triple(playback, chunkIndex to pcm, false)
            }
          }

        if (next.third) {
          awaitPlaybackDrain(next.first)
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
            active === next.first && !next.first.cancelled
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

  private fun awaitPlaybackDrain(playback: ActivePlayback) {
    val maximumWaitMs =
      ((playback.framesWritten * 1_000L) / playback.sampleRate + DRAIN_GRACE_MS)
        .coerceAtMost(MAXIMUM_DRAIN_WAIT_MS)
    val deadline = clock.elapsedRealtime() + maximumWaitMs
    while (!playback.cancelled && clock.elapsedRealtime() < deadline) {
      val playedFrames = playback.output.playbackHeadPosition and 0xffffffffL
      if (playedFrames >= playback.framesWritten) {
        return
      }
      clock.sleep(DRAIN_POLL_INTERVAL_MS)
    }
  }

  private fun requireActive(playbackId: String): ActivePlayback {
    val playback = active ?: error("No PCM playback is active.")
    check(playback.playbackId == playbackId) {
      "Playback $playbackId does not own the active player."
    }
    return playback
  }

  private fun releaseOutputOnce(playback: ActivePlayback, flush: Boolean) {
    if (playback.released.compareAndSet(false, true)) playback.output.release(flush)
  }

  companion object {
    private const val MIN_SAMPLE_RATE = 8_000
    private const val MAX_SAMPLE_RATE = 48_000
    private const val TARGET_BUFFER_BYTES = 48_000
    private const val DRAIN_GRACE_MS = 500L
    private const val MAXIMUM_DRAIN_WAIT_MS = 30_000L
    private const val DRAIN_POLL_INTERVAL_MS = 10L
  }

  private object AndroidPlaybackClock : T3VoicePlaybackClock {
    override fun elapsedRealtime(): Long = SystemClock.elapsedRealtime()

    override fun sleep(delayMs: Long) = Thread.sleep(delayMs)
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

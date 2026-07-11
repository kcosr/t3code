package expo.modules.t3voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Base64
import android.os.SystemClock
import java.util.TreeMap
import java.util.concurrent.Executors

internal class T3VoicePcmPlayer(
  private val onChunkConsumed: (String, Int) -> Unit,
  private val onFinished: (String) -> Unit,
  private val onError: (String, Throwable) -> Unit,
) {
  private data class ActivePlayback(
    val playbackId: String,
    val track: AudioTrack,
    val bytesPerFrame: Int,
    val sampleRate: Int,
    val pending: TreeMap<Int, ByteArray> = TreeMap(),
    var nextChunkIndex: Int = 0,
    var finalChunkIndex: Int? = null,
    var cancelled: Boolean = false,
    var framesWritten: Long = 0,
  )

  private val executor = Executors.newSingleThreadExecutor()
  private val lock = Any()
  private var active: ActivePlayback? = null
  private var drainScheduled = false

  fun start(playbackId: String, sampleRate: Int, channelCount: Int) {
    require(sampleRate in MIN_SAMPLE_RATE..MAX_SAMPLE_RATE) { "Unsupported PCM sample rate." }
    require(channelCount == 1 || channelCount == 2) { "PCM playback supports one or two channels." }
    synchronized(lock) {
      check(active == null) { "A voice playback is already active." }
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
      active =
        ActivePlayback(
          playbackId = playbackId,
          track = track,
          bytesPerFrame = channelCount * Short.SIZE_BYTES,
          sampleRate = sampleRate,
        )
    }
  }

  fun enqueue(playbackId: String, chunkIndex: Int, pcmBase64: String) {
    require(chunkIndex >= 0) { "PCM chunk indexes must be non-negative." }
    val pcm = Base64.decode(pcmBase64, Base64.DEFAULT)
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
      scheduleDrainLocked()
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
      scheduleDrainLocked()
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
    releaseTrack(playback.track, flush = true)
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
      releaseTrack(playback.track, flush = true)
    }
    executor.shutdownNow()
  }

  private fun scheduleDrainLocked() {
    if (drainScheduled) {
      return
    }
    drainScheduled = true
    executor.execute(::drain)
  }

  private fun drain() {
    try {
      while (true) {
        val next =
          synchronized(lock) {
            val playback = active
            if (playback == null || playback.cancelled) {
              drainScheduled = false
              return
            }
            val pcm = playback.pending.remove(playback.nextChunkIndex)
            if (pcm == null) {
              val isComplete = playback.finalChunkIndex == playback.nextChunkIndex - 1
              if (isComplete) {
                active = null
                drainScheduled = false
              } else {
                drainScheduled = false
              }
              Triple(playback, null, isComplete)
            } else {
              val chunkIndex = playback.nextChunkIndex
              playback.nextChunkIndex += 1
              Triple(playback, chunkIndex to pcm, false)
            }
          }

        if (next.third) {
          awaitPlaybackDrain(next.first)
          releaseTrack(next.first.track, flush = false)
          onFinished(next.first.playbackId)
          return
        }
        val chunk = next.second ?: return
        writeFully(next.first, chunk.second)
        onChunkConsumed(next.first.playbackId, chunk.first)
      }
    } catch (cause: Throwable) {
      val playbackId =
        synchronized(lock) {
          val playback = active
          active = null
          drainScheduled = false
          playback?.track?.let { releaseTrack(it, flush = true) }
          playback?.playbackId
        }
      onError(playbackId ?: "unknown", cause)
    }
  }

  private fun writeFully(playback: ActivePlayback, pcm: ByteArray) {
    require(pcm.size % playback.bytesPerFrame == 0) { "PCM chunk ended on a partial frame." }
    var offset = 0
    while (offset < pcm.size) {
      if (playback.cancelled) {
        return
      }
      val written = playback.track.write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_BLOCKING)
      check(written > 0) { "AudioTrack write failed with code $written." }
      offset += written
      playback.framesWritten += written / playback.bytesPerFrame
    }
  }

  private fun awaitPlaybackDrain(playback: ActivePlayback) {
    val maximumWaitMs =
      ((playback.framesWritten * 1_000L) / playback.sampleRate + DRAIN_GRACE_MS)
        .coerceAtMost(MAXIMUM_DRAIN_WAIT_MS)
    val deadline = SystemClock.elapsedRealtime() + maximumWaitMs
    while (!playback.cancelled && SystemClock.elapsedRealtime() < deadline) {
      val playedFrames = playback.track.playbackHeadPosition.toLong() and 0xffffffffL
      if (playedFrames >= playback.framesWritten) {
        return
      }
      Thread.sleep(DRAIN_POLL_INTERVAL_MS)
    }
  }

  private fun requireActive(playbackId: String): ActivePlayback {
    val playback = active ?: error("No PCM playback is active.")
    check(playback.playbackId == playbackId) {
      "Playback $playbackId does not own the active player."
    }
    return playback
  }

  private fun releaseTrack(track: AudioTrack, flush: Boolean) {
    try {
      track.pause()
      if (flush) {
        track.flush()
      }
      track.stop()
    } catch (_: IllegalStateException) {
      // The track may already be stopped after an audio-device failure.
    } finally {
      track.release()
    }
  }

  companion object {
    private const val MIN_SAMPLE_RATE = 8_000
    private const val MAX_SAMPLE_RATE = 48_000
    private const val TARGET_BUFFER_BYTES = 48_000
    private const val DRAIN_GRACE_MS = 500L
    private const val MAXIMUM_DRAIN_WAIT_MS = 30_000L
    private const val DRAIN_POLL_INTERVAL_MS = 10L
  }
}

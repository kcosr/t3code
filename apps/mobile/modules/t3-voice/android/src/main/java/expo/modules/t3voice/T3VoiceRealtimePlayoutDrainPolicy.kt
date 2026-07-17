package expo.modules.t3voice

import kotlin.math.abs

internal enum class T3VoiceRealtimePlayoutDrainDecision {
  WAIT,
  DRAINED,
  TIMED_OUT,
}

internal class T3VoiceRealtimePlayoutDrainPolicy(
  private val startedAtMillis: Long,
  private val silenceMillis: Long = SILENCE_MILLIS,
  private val maximumMillis: Long = MAXIMUM_MILLIS,
) {
  fun observe(
    nowMillis: Long,
    lastAudiblePlayoutAtMillis: Long?,
  ): T3VoiceRealtimePlayoutDrainDecision {
    require(nowMillis >= startedAtMillis) { "Playout drain time cannot move backwards." }
    if (nowMillis - startedAtMillis >= maximumMillis) {
      return T3VoiceRealtimePlayoutDrainDecision.TIMED_OUT
    }
    val latestActivity = maxOf(startedAtMillis, lastAudiblePlayoutAtMillis ?: startedAtMillis)
    return if (nowMillis - latestActivity >= silenceMillis) {
      T3VoiceRealtimePlayoutDrainDecision.DRAINED
    } else {
      T3VoiceRealtimePlayoutDrainDecision.WAIT
    }
  }

  internal companion object {
    const val SAMPLE_MILLIS = 100L
    const val SILENCE_MILLIS = 400L
    const val MAXIMUM_MILLIS = 5_000L
  }
}

internal class T3VoiceRealtimePlayoutMonitor {
  @Volatile private var lastAudibleAtMillis: Long? = null
  @Volatile private var armed = false

  fun arm() {
    lastAudibleAtMillis = null
    armed = true
  }

  fun disarm() {
    armed = false
    lastAudibleAtMillis = null
  }

  fun observePcm16LittleEndian(data: ByteArray, nowMillis: Long) {
    if (!armed) return
    var index = 0
    while (index + 1 < data.size) {
      val sample = (data[index].toInt() and 0xff) or (data[index + 1].toInt() shl 8)
      if (abs(sample.toShort().toInt()) > AUDIBLE_SAMPLE_FLOOR) {
        lastAudibleAtMillis = nowMillis
        return
      }
      index += 2
    }
  }

  fun lastAudibleAtMillis(): Long? = lastAudibleAtMillis

  private companion object {
    const val AUDIBLE_SAMPLE_FLOOR = 32
  }
}

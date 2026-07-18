package expo.modules.t3voice

import android.os.SystemClock
import java.util.concurrent.TimeUnit

internal enum class T3VoiceDiagnosticCategory {
  LIFECYCLE,
  STATE,
  ROUTE,
  FOCUS,
  TERMINAL,
  ENDPOINT,
}

internal enum class T3VoiceDiagnosticCode {
  STARTED,
  STOPPED,
  ACTIVE,
  IDLE,
  REQUEST_GRANTED,
  REQUEST_DENIED,
  GAINED,
  LOST_TRANSIENTLY,
  DUCK_REQUESTED,
  LOST_PERMANENTLY,
  ROUTE_SELECTED,
  ROUTE_FALLBACK,
  ROUTE_SCAN_UNAVAILABLE,
  DEVICE_CALLBACK_REGISTERED,
  DEVICE_CALLBACK_UNAVAILABLE,
  DEVICE_CALLBACK_UNREGISTERED,
  ENDED,
  FAILED,
  REALTIME_DRAIN_TIMED_OUT,
  ENDPOINT_SAMPLE,
  ENDPOINT_TERMINATED,
  CUE_READY_STARTED,
  CUE_ENDED_STARTED,
  CUE_DRAINED,
  CUE_CANCELLED,
  CUE_FAILED,
  CUE_TIMED_OUT,
  MEDIA_BUTTON_RECEIVED,
  MEDIA_ACTION_DISPATCHED,
  PLAYBACK_INTERRUPT_REQUESTED,
  PLAYBACK_INTERRUPT_COMPLETED,
  PLAYBACK_COMPLETION_STALE,
  THREAD_REARM_SCHEDULED,
  THREAD_REARM_ADMITTED,
  THREAD_REARM_REJECTED,
  AUDIO_CLAIM_ACQUIRED,
  AUDIO_CLAIM_REJECTED,
}

internal data class T3VoiceDiagnosticEntry(
  val elapsedRealtimeMillis: Long,
  val generation: Long,
  val category: T3VoiceDiagnosticCategory,
  val code: T3VoiceDiagnosticCode,
  val primaryCount: Int,
  val secondaryCount: Int,
  val endpoint: T3VoiceEndpointDiagnostic? = null,
) {
  fun toResultBody(): Map<String, Any> =
    buildMap {
      putAll(
        mapOf(
          "elapsedRealtimeMillis" to elapsedRealtimeMillis,
          "generation" to generation,
          "category" to category.name.lowercase(),
          "code" to code.name.lowercase().replace('_', '-'),
          "primaryCount" to primaryCount,
          "secondaryCount" to secondaryCount,
        ),
      )
      endpoint?.let {
        put("endpointElapsedMs", it.elapsedMs)
        put("levelDbfsBucket", it.levelDbfsBucket)
        put("noiseFloorDbfsBucket", it.noiseFloorDbfsBucket)
        put("releaseThresholdDbfsBucket", it.releaseThresholdDbfsBucket)
        put("speechConfirmed", it.speechConfirmed)
        put("silenceElapsedMs", it.silenceElapsedMs)
        put("silenceResetCount", it.silenceResetCount)
      }
    }
}

internal class T3VoiceDiagnosticRing(
  private val capacity: Int = DEFAULT_CAPACITY,
  private val clock: () -> Long = defaultDiagnosticClock,
  initialGeneration: Long = 0,
) {
  private val entries = ArrayDeque<T3VoiceDiagnosticEntry>(capacity)
  private var lastTimestamp = 0L
  private var generation = initialGeneration.coerceAtLeast(0)

  init {
    require(capacity in 1..MAX_CAPACITY) { "Diagnostic capacity is out of range." }
  }

  @Synchronized
  fun nextGeneration(): Long {
    if (generation == Long.MAX_VALUE) {
      entries.clear()
      generation = 1
    } else {
      generation += 1
    }
    return generation
  }

  @Synchronized
  fun record(
    generation: Long,
    category: T3VoiceDiagnosticCategory,
    code: T3VoiceDiagnosticCode,
    primaryCount: Int = 0,
    secondaryCount: Int = 0,
  ) {
    val timestamp = maxOf(lastTimestamp, clock().coerceAtLeast(0))
    lastTimestamp = timestamp
    if (entries.size == capacity) entries.removeFirst()
    entries.addLast(
      T3VoiceDiagnosticEntry(
        elapsedRealtimeMillis = timestamp,
        generation = generation.coerceAtLeast(0),
        category = category,
        code = code,
        primaryCount = primaryCount.coerceIn(0, MAX_COUNTER),
        secondaryCount = secondaryCount.coerceIn(0, MAX_COUNTER),
      ),
    )
  }

  @Synchronized
  fun recordEndpoint(generation: Long, diagnostic: T3VoiceEndpointDiagnostic) {
    val timestamp = maxOf(lastTimestamp, clock().coerceAtLeast(0))
    lastTimestamp = timestamp
    if (entries.size == capacity) entries.removeFirst()
    entries.addLast(
      T3VoiceDiagnosticEntry(
        elapsedRealtimeMillis = timestamp,
        generation = generation.coerceAtLeast(0),
        category = T3VoiceDiagnosticCategory.ENDPOINT,
        code =
          if (diagnostic.terminal) {
            T3VoiceDiagnosticCode.ENDPOINT_TERMINATED
          } else {
            T3VoiceDiagnosticCode.ENDPOINT_SAMPLE
          },
        primaryCount = 0,
        secondaryCount = 0,
        endpoint = diagnostic,
      ),
    )
  }

  @Synchronized
  fun snapshot(): List<T3VoiceDiagnosticEntry> = entries.toList()

  companion object {
    internal const val DEFAULT_CAPACITY = 128
    internal const val MAX_CAPACITY = 256
    internal const val MAX_COUNTER = 1_000_000
  }
}

/**
 * Android's local-JVM stub throws when [SystemClock.elapsedRealtime] is called outside a device.
 * Diagnostics are best-effort and must never stop the voice state machine. Probe once so local-JVM
 * tests do not pay for and swallow the Android stub exception on every diagnostic event.
 */
private val defaultDiagnosticClock: () -> Long by lazy {
  try {
    SystemClock.elapsedRealtime()
    SystemClock::elapsedRealtime
  } catch (_: RuntimeException) {
    { TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) }
  }
}

internal object T3VoiceDiagnostics {
  private val ring = T3VoiceDiagnosticRing()

  fun nextGeneration(): Long = ring.nextGeneration()

  fun record(
    generation: Long,
    category: T3VoiceDiagnosticCategory,
    code: T3VoiceDiagnosticCode,
    primaryCount: Int = 0,
    secondaryCount: Int = 0,
  ) = ring.record(generation, category, code, primaryCount, secondaryCount)

  fun snapshot(): List<Map<String, Any>> = ring.snapshot().map(T3VoiceDiagnosticEntry::toResultBody)

  fun recordEndpoint(generation: Long, diagnostic: T3VoiceEndpointDiagnostic) =
    ring.recordEndpoint(generation, diagnostic)
}

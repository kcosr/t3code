package expo.modules.t3voice

import android.os.SystemClock

internal enum class T3VoiceDiagnosticCategory {
  LIFECYCLE,
  STATE,
  ROUTE,
  FOCUS,
  TERMINAL,
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
}

internal data class T3VoiceDiagnosticEntry(
  val elapsedRealtimeMillis: Long,
  val generation: Long,
  val category: T3VoiceDiagnosticCategory,
  val code: T3VoiceDiagnosticCode,
  val primaryCount: Int,
  val secondaryCount: Int,
)

internal class T3VoiceDiagnosticRing(
  private val capacity: Int = DEFAULT_CAPACITY,
  private val clock: () -> Long = SystemClock::elapsedRealtime,
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
  fun snapshot(): List<T3VoiceDiagnosticEntry> = entries.toList()

  companion object {
    internal const val DEFAULT_CAPACITY = 128
    internal const val MAX_CAPACITY = 256
    internal const val MAX_COUNTER = 1_000_000
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
}

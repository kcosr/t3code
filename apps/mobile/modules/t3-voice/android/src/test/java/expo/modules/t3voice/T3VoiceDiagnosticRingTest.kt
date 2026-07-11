package expo.modules.t3voice

import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceDiagnosticRingTest {
  @Test
  fun rotatesAtCapacityAndRetainsNewestEntries() {
    var now = 100L
    val ring = T3VoiceDiagnosticRing(capacity = 3, clock = { now++ })
    val generation = ring.nextGeneration()
    repeat(5) { count ->
      ring.record(generation, T3VoiceDiagnosticCategory.STATE, T3VoiceDiagnosticCode.ACTIVE, count)
    }

    assertEquals(listOf(2, 3, 4), ring.snapshot().map { it.primaryCount })
  }

  @Test
  fun timestampsNeverRegressWhenTheClockMovesBackward() {
    val timestamps = ArrayDeque(listOf(20L, 10L, -1L, 30L))
    val ring = T3VoiceDiagnosticRing(clock = { timestamps.removeFirst() })
    repeat(4) {
      ring.record(1, T3VoiceDiagnosticCategory.LIFECYCLE, T3VoiceDiagnosticCode.ACTIVE)
    }

    assertEquals(listOf(20L, 20L, 20L, 30L), ring.snapshot().map { it.elapsedRealtimeMillis })
  }

  @Test
  fun generationRolloverClearsEntriesBeforeReusingNumbers() {
    val ring =
      T3VoiceDiagnosticRing(
        clock = { 1L },
        initialGeneration = Long.MAX_VALUE - 1,
      )
    val last = ring.nextGeneration()
    ring.record(last, T3VoiceDiagnosticCategory.TERMINAL, T3VoiceDiagnosticCode.ENDED)

    assertEquals(1L, ring.nextGeneration())
    assertTrue(ring.snapshot().isEmpty())
  }

  @Test
  fun clampsAllCallerSuppliedNumbersToFixedBounds() {
    val ring = T3VoiceDiagnosticRing(clock = { 1L })
    ring.record(
      generation = -1,
      category = T3VoiceDiagnosticCategory.ROUTE,
      code = T3VoiceDiagnosticCode.ROUTE_FALLBACK,
      primaryCount = -10,
      secondaryCount = Int.MAX_VALUE,
    )

    assertEquals(
      T3VoiceDiagnosticEntry(
        elapsedRealtimeMillis = 1,
        generation = 0,
        category = T3VoiceDiagnosticCategory.ROUTE,
        code = T3VoiceDiagnosticCode.ROUTE_FALLBACK,
        primaryCount = 0,
        secondaryCount = T3VoiceDiagnosticRing.MAX_COUNTER,
      ),
      ring.snapshot().single(),
    )
  }

  @Test
  fun entryPayloadCannotCarryFreeFormOrBinaryData() {
    val fields =
      T3VoiceDiagnosticEntry::class.java.declaredFields.filterNot {
        Modifier.isStatic(it.modifiers)
      }
    assertEquals(6, fields.size)
    assertFalse(fields.any { it.type == String::class.java })
    assertFalse(fields.any { it.type == ByteArray::class.java })
    assertTrue(
      fields.all {
        it.type == java.lang.Long.TYPE ||
          it.type == Integer.TYPE ||
          it.type.isEnum
      },
    )
  }

  @Test
  fun capacityItselfHasAHardUpperBound() {
    val failure = runCatching { T3VoiceDiagnosticRing(capacity = 257) }
    assertTrue(failure.isFailure)
  }
}

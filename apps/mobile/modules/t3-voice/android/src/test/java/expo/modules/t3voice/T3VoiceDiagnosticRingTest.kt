package expo.modules.t3voice

import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceDiagnosticRingTest {
  @Test
  fun processDiagnosticsRemainUsableWithoutAnAndroidRuntime() {
    T3VoiceDiagnostics.record(
      generation = 1,
      category = T3VoiceDiagnosticCategory.STATE,
      code = T3VoiceDiagnosticCode.AUDIO_CLAIM_ACQUIRED,
    )

    assertTrue(
      T3VoiceDiagnostics.snapshot().any {
        it["generation"] == 1L && it["code"] == "audio-claim-acquired"
      },
    )
  }

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
    assertEquals(7, fields.size)
    assertFalse(fields.any { it.type == String::class.java })
    assertFalse(fields.any { it.type == ByteArray::class.java })
    assertTrue(
      fields.all {
        it.type == java.lang.Long.TYPE ||
          it.type == Integer.TYPE ||
          it.type.isEnum ||
          it.type == T3VoiceEndpointDiagnostic::class.java
      },
    )
    val endpointFields =
      T3VoiceEndpointDiagnostic::class.java.declaredFields.filterNot {
        Modifier.isStatic(it.modifiers)
      }
    assertFalse(endpointFields.any { it.type == String::class.java || it.type == ByteArray::class.java })
    assertTrue(
      endpointFields.all {
        it.type == java.lang.Long.TYPE ||
          it.type == Integer.TYPE ||
          it.type == java.lang.Boolean.TYPE
      },
    )
  }

  @Test
  fun supportSnapshotContainsOnlyDocumentedRedactedFields() {
    val ring = T3VoiceDiagnosticRing(capacity = 1, clock = { 42L })
    ring.record(
      generation = 7,
      category = T3VoiceDiagnosticCategory.ROUTE,
      code = T3VoiceDiagnosticCode.ROUTE_SCAN_UNAVAILABLE,
      primaryCount = 2,
      secondaryCount = 3,
    )

    assertEquals(
      mapOf(
        "elapsedRealtimeMillis" to 42L,
        "generation" to 7L,
        "category" to "route",
        "code" to "route-scan-unavailable",
        "primaryCount" to 2,
        "secondaryCount" to 3,
      ),
      ring.snapshot().single().toResultBody(),
    )
  }

  @Test
  fun realtimeDrainTimeoutUsesThePublicDiagnosticCode() {
    val ring = T3VoiceDiagnosticRing(capacity = 1, clock = { 42L })
    ring.record(
      generation = 8,
      category = T3VoiceDiagnosticCategory.TERMINAL,
      code = T3VoiceDiagnosticCode.REALTIME_DRAIN_TIMED_OUT,
    )

    assertEquals("realtime-drain-timed-out", ring.snapshot().single().toResultBody()["code"])
  }

  @Test
  fun capacityItselfHasAHardUpperBound() {
    val failure = runCatching { T3VoiceDiagnosticRing(capacity = 257) }
    assertTrue(failure.isFailure)
  }

  @Test
  fun endpointSnapshotContainsOnlyBucketedDetectorMeasurements() {
    val ring = T3VoiceDiagnosticRing(capacity = 1, clock = { 42L })
    ring.recordEndpoint(
      generation = 9,
      diagnostic =
        T3VoiceEndpointDiagnostic(
          elapsedMs = 500,
          levelDbfsBucket = -39,
          noiseFloorDbfsBucket = -54,
          releaseThresholdDbfsBucket = -45,
          speechConfirmed = true,
          silenceElapsedMs = 250,
          silenceResetCount = 2,
          terminal = true,
        ),
    )

    assertEquals(
      mapOf(
        "elapsedRealtimeMillis" to 42L,
        "generation" to 9L,
        "category" to "endpoint",
        "code" to "endpoint-terminated",
        "primaryCount" to 0,
        "secondaryCount" to 0,
        "endpointElapsedMs" to 500L,
        "levelDbfsBucket" to -39,
        "noiseFloorDbfsBucket" to -54,
        "releaseThresholdDbfsBucket" to -45,
        "speechConfirmed" to true,
        "silenceElapsedMs" to 250L,
        "silenceResetCount" to 2,
      ),
      ring.snapshot().single().toResultBody(),
    )
  }
}

package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class T3VoiceEndpointDetectorTest {
  @Test
  fun defaultsMatchBoundedEndpointPolicy() {
    val config = T3VoiceEndpointDetectionConfig()

    assertEquals(150L, config.speechOnsetMs)
    assertEquals(250L, config.minimumSpeechMs)
    assertEquals(1_200L, config.endSilenceMs)
    assertEquals(500L, config.minimumRecordingMs)
    assertNull(config.noSpeechTimeoutMs)
    assertEquals(30L * 60L * 1_000L, config.maximumUtteranceMs)
  }

  @Test
  fun sustainedSpeechThenSilenceEndsTheUtterance() {
    val detector = T3VoiceEndpointDetector()

    feed(detector, 0L..250L step 50L, amplitude = 100)
    feed(detector, 300L..800L step 50L, amplitude = 8_000)
    feed(detector, 850L..1_950L step 50L, amplitude = 100)
    assertEquals(T3VoiceEndpointDetector.Outcome.SPEECH_ENDED, detector.observe(2_000L, 100))
    assertNull(detector.observe(2_050L, 100))
  }

  @Test
  fun speechBeginningImmediatelyIsNotAbsorbedIntoTheNoiseFloor() {
    val detector = T3VoiceEndpointDetector()

    feed(detector, 0L..500L step 50L, amplitude = 1_000)
    feed(detector, 550L..1_650L step 50L, amplitude = 100)
    assertEquals(T3VoiceEndpointDetector.Outcome.SPEECH_ENDED, detector.observe(1_700L, 100))
  }

  @Test
  fun endpointWaitsUntilMinimumRecordingDuration() {
    val detector =
      T3VoiceEndpointDetector(
        T3VoiceEndpointDetectionConfig(
          speechOnsetMs = 50L,
          minimumSpeechMs = 50L,
          endSilenceMs = 250L,
          minimumRecordingMs = 1_000L,
        ),
      )

    feed(detector, 0L..250L step 50L, amplitude = 0)
    feed(detector, 300L..400L step 50L, amplitude = 8_000)
    feed(detector, 450L..950L step 50L, amplitude = 0)
    assertEquals(T3VoiceEndpointDetector.Outcome.SPEECH_ENDED, detector.observe(1_000L, 0))
  }

  @Test
  fun onsetImpulseDoesNotCountAsSpeech() {
    val detector =
      T3VoiceEndpointDetector(T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = 30_000L))

    feed(detector, 0L..250L step 50L, amplitude = 100)
    assertNull(detector.observe(300L, 12_000))
    assertNull(detector.observe(350L, 100))
    feed(detector, 400L..29_950L step 50L, amplitude = 100)
    assertEquals(T3VoiceEndpointDetector.Outcome.NO_SPEECH, detector.observe(30_000L, 100))
  }

  @Test
  fun internalPauseShorterThanEndSilenceDoesNotTerminate() {
    val detector =
      T3VoiceEndpointDetector(T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = 30_000L))

    feed(detector, 0L..500L step 50L, amplitude = 8_000)
    feed(detector, 550L..1_500L step 50L, amplitude = 100)
    assertNull(detector.observe(1_550L, 8_000))
    feed(detector, 1_600L..1_900L step 50L, amplitude = 8_000)
    feed(detector, 1_950L..3_050L step 50L, amplitude = 100)
    assertEquals(T3VoiceEndpointDetector.Outcome.SPEECH_ENDED, detector.observe(3_100L, 100))
  }

  @Test
  fun allZeroInputTimesOutWithoutTriggeringSpeech() {
    val detector =
      T3VoiceEndpointDetector(T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = 30_000L))

    feed(detector, 0L..29_950L step 50L, amplitude = 0)
    assertEquals(T3VoiceEndpointDetector.Outcome.NO_SPEECH, detector.observe(30_000L, 0))
  }

  @Test
  fun nullableNoSpeechTimeoutAllowsManualRecordingToContinue() {
    val detector =
      T3VoiceEndpointDetector(T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = null))

    feed(detector, 0L..60_000L step 1_000L, amplitude = 0)
  }

  @Test
  fun maximumUtteranceWithoutSpeechCancelsAtItsDeadline() {
    val detector =
      T3VoiceEndpointDetector(
        T3VoiceEndpointDetectionConfig(
          noSpeechTimeoutMs = null,
          maximumUtteranceMs = 1_000L,
        ),
      )

    assertNull(detector.observe(0L, 0))
    assertEquals(T3VoiceEndpointDetector.Outcome.NO_SPEECH, detector.observe(1_000L, 0))
  }

  @Test
  fun maximumUtteranceWithSpeechCompletesAtItsDeadline() {
    val detector =
      T3VoiceEndpointDetector(
        T3VoiceEndpointDetectionConfig(
          speechOnsetMs = 50L,
          minimumSpeechMs = 50L,
          noSpeechTimeoutMs = null,
          maximumUtteranceMs = 1_000L,
        ),
      )

    feed(detector, 0L..250L step 50L, amplitude = 0)
    feed(detector, 300L..950L step 50L, amplitude = 8_000)
    assertEquals(
      T3VoiceEndpointDetector.Outcome.MAXIMUM_UTTERANCE,
      detector.observe(1_000L, 8_000),
    )
  }

  @Test
  fun adaptiveNoiseFloorDoesNotTreatSteadyAmbientNoiseAsSpeech() {
    val detector =
      T3VoiceEndpointDetector(T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = 30_000L))

    feed(detector, 0L..29_950L step 50L, amplitude = 100)
    assertEquals(T3VoiceEndpointDetector.Outcome.NO_SPEECH, detector.observe(30_000L, 100))
  }

  @Test
  fun rejectsInvalidConfigAndNonMonotonicSamples() {
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceEndpointDetectionConfig(endSilenceMs = 100L)
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = 31_000L, maximumUtteranceMs = 30_000L)
    }

    val detector = T3VoiceEndpointDetector()
    detector.observe(100L, 0)
    assertThrows(IllegalArgumentException::class.java) { detector.observe(99L, 0) }
    assertThrows(IllegalArgumentException::class.java) { detector.observe(101L, 32_768) }
  }

  private fun feed(
    detector: T3VoiceEndpointDetector,
    times: LongProgression,
    amplitude: Int,
  ) {
    times.forEach { assertNull(detector.observe(it, amplitude)) }
  }
}

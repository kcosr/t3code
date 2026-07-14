package expo.modules.t3voice

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.roundToInt

internal data class T3VoiceEndpointDiagnostic(
  val elapsedMs: Long,
  val levelDbfsBucket: Int,
  val noiseFloorDbfsBucket: Int,
  val releaseThresholdDbfsBucket: Int,
  val speechConfirmed: Boolean,
  val silenceElapsedMs: Long,
  val silenceResetCount: Int,
  val terminal: Boolean,
)

internal data class T3VoiceEndpointDetectionConfig(
  val onsetMarginDb: Double = 12.0,
  val onsetFloorDbfs: Double = -42.0,
  val releaseHysteresisDb: Double = 4.0,
  val speechOnsetMs: Long = 150L,
  val minimumSpeechMs: Long = 250L,
  val endSilenceMs: Long = 2_200L,
  val minimumRecordingMs: Long = 500L,
  val noSpeechTimeoutMs: Long? = null,
  val maximumUtteranceMs: Long = 30L * 60L * 1_000L - 1_000L,
) {
  init {
    require(onsetMarginDb in 3.0..30.0) { "onsetMarginDb must be between 3 and 30" }
    require(onsetFloorDbfs in -80.0..-6.0) { "onsetFloorDbfs must be between -80 and -6" }
    require(releaseHysteresisDb in 1.0..15.0) {
      "releaseHysteresisDb must be between 1 and 15"
    }
    require(speechOnsetMs in 50L..2_000L) { "speechOnsetMs must be between 50 and 2000" }
    require(minimumSpeechMs in speechOnsetMs..10_000L) {
      "minimumSpeechMs must be at least speechOnsetMs and at most 10000"
    }
    require(endSilenceMs in 250L..10_000L) { "endSilenceMs must be between 250 and 10000" }
    require(minimumRecordingMs in 0L..10_000L) {
      "minimumRecordingMs must be between 0 and 10000"
    }
    require(noSpeechTimeoutMs == null || noSpeechTimeoutMs in 1_000L..maximumUtteranceMs) {
      "noSpeechTimeoutMs must be null or between 1000 and maximumUtteranceMs"
    }
    require(maximumUtteranceMs in 1_000L..60L * 60L * 1_000L) {
      "maximumUtteranceMs must be between 1000 and 3600000"
    }
  }
}

internal class T3VoiceEndpointDetector(
  private val config: T3VoiceEndpointDetectionConfig = T3VoiceEndpointDetectionConfig(),
  private val onDiagnostic: (T3VoiceEndpointDiagnostic) -> Unit = {},
) {
  enum class Outcome {
    SPEECH_ENDED,
    NO_SPEECH,
    MAXIMUM_UTTERANCE,
  }

  private var terminal = false
  private var lastElapsedMs: Long? = null
  private var noiseFloorDbfs = INITIAL_NOISE_FLOOR_DBFS
  private var onsetCandidateAtMs: Long? = null
  private var speechConfirmed = false
  private var accumulatedSpeechMs = 0L
  private var lastSpeechAtMs: Long? = null
  private var silenceTracking = false
  private var silenceResetCount = 0
  private var lastDiagnosticAtMs: Long? = null

  fun observe(elapsedMs: Long, peakAmplitude: Int): Outcome? {
    require(elapsedMs >= 0L) { "elapsedMs must be non-negative" }
    require(lastElapsedMs == null || elapsedMs >= lastElapsedMs!!) {
      "elapsedMs must be monotonic"
    }
    require(peakAmplitude in 0..MAX_AMPLITUDE) {
      "peakAmplitude must be between 0 and $MAX_AMPLITUDE"
    }
    if (terminal) return null

    val previousElapsedMs = lastElapsedMs
    lastElapsedMs = elapsedMs

    val levelDbfs = amplitudeToDbfs(peakAmplitude)
    val onsetThresholdDbfs = max(noiseFloorDbfs + config.onsetMarginDb, config.onsetFloorDbfs)
    val releaseThresholdDbfs = onsetThresholdDbfs - config.releaseHysteresisDb
    val forcedOutcome =
      when {
        elapsedMs >= config.maximumUtteranceMs ->
          if (speechConfirmed) Outcome.MAXIMUM_UTTERANCE else Outcome.NO_SPEECH
        !speechConfirmed && config.noSpeechTimeoutMs?.let { elapsedMs >= it } == true ->
          Outcome.NO_SPEECH
        else -> null
      }
    if (forcedOutcome != null) {
      emitDiagnostic(elapsedMs, levelDbfs, releaseThresholdDbfs, terminal = true)
      return finish(forcedOutcome)
    }

    if (!speechConfirmed) {
      observeBeforeSpeech(elapsedMs, levelDbfs, onsetThresholdDbfs)
    } else {
      observeAfterSpeech(elapsedMs, previousElapsedMs, levelDbfs, releaseThresholdDbfs)
    }

    val diagnosticReleaseThresholdDbfs =
      max(noiseFloorDbfs + config.onsetMarginDb, config.onsetFloorDbfs) -
        config.releaseHysteresisDb

    val lastSpeech = lastSpeechAtMs
    if (
      speechConfirmed &&
        accumulatedSpeechMs >= config.minimumSpeechMs &&
        lastSpeech != null &&
        elapsedMs - lastSpeech >= config.endSilenceMs &&
        elapsedMs >= config.minimumRecordingMs
    ) {
      emitDiagnostic(elapsedMs, levelDbfs, diagnosticReleaseThresholdDbfs, terminal = true)
      return finish(Outcome.SPEECH_ENDED)
    }
    emitDiagnostic(elapsedMs, levelDbfs, diagnosticReleaseThresholdDbfs, terminal = false)
    return null
  }

  fun recordTerminalDiagnostic(elapsedMs: Long, peakAmplitude: Int) {
    if (terminal) return
    require(elapsedMs >= 0L) { "elapsedMs must be non-negative" }
    require(peakAmplitude in 0..MAX_AMPLITUDE) {
      "peakAmplitude must be between 0 and $MAX_AMPLITUDE"
    }
    val levelDbfs = amplitudeToDbfs(peakAmplitude)
    val onsetThresholdDbfs = max(noiseFloorDbfs + config.onsetMarginDb, config.onsetFloorDbfs)
    emitDiagnostic(
      elapsedMs,
      levelDbfs,
      onsetThresholdDbfs - config.releaseHysteresisDb,
      terminal = true,
    )
    terminal = true
  }

  private fun observeBeforeSpeech(
    elapsedMs: Long,
    levelDbfs: Double,
    onsetThresholdDbfs: Double,
  ) {
    if (
      elapsedMs < CALIBRATION_MS &&
        levelDbfs < max(onsetThresholdDbfs, CALIBRATION_DIRECT_ONSET_DBFS)
    ) {
      onsetCandidateAtMs = null
      noiseFloorDbfs += NOISE_FLOOR_ALPHA * (levelDbfs - noiseFloorDbfs)
      return
    }

    if (levelDbfs >= onsetThresholdDbfs) {
      val candidateAt = onsetCandidateAtMs ?: elapsedMs.also { onsetCandidateAtMs = it }
      if (elapsedMs - candidateAt >= config.speechOnsetMs) {
        speechConfirmed = true
        accumulatedSpeechMs = elapsedMs - candidateAt
        lastSpeechAtMs = elapsedMs
      }
      return
    }

    onsetCandidateAtMs = null
    // Only sub-threshold samples affect the ambient estimate, so speech cannot train it upward.
    noiseFloorDbfs += NOISE_FLOOR_ALPHA * (levelDbfs - noiseFloorDbfs)
  }

  private fun observeAfterSpeech(
    elapsedMs: Long,
    previousElapsedMs: Long?,
    levelDbfs: Double,
    releaseThresholdDbfs: Double,
  ) {
    if (levelDbfs < releaseThresholdDbfs) {
      silenceTracking = true
      return
    }

    if (silenceTracking) {
      silenceResetCount += 1
      silenceTracking = false
    }

    accumulatedSpeechMs += (elapsedMs - (previousElapsedMs ?: elapsedMs)).coerceAtLeast(0L)
    lastSpeechAtMs = elapsedMs
  }

  private fun emitDiagnostic(
    elapsedMs: Long,
    levelDbfs: Double,
    releaseThresholdDbfs: Double,
    terminal: Boolean,
  ) {
    val lastDiagnostic = lastDiagnosticAtMs
    if (!terminal && lastDiagnostic != null && elapsedMs - lastDiagnostic < DIAGNOSTIC_INTERVAL_MS) {
      return
    }
    lastDiagnosticAtMs = elapsedMs
    val diagnostic =
      T3VoiceEndpointDiagnostic(
        elapsedMs = elapsedMs,
        levelDbfsBucket = dbfsBucket(levelDbfs),
        noiseFloorDbfsBucket = dbfsBucket(noiseFloorDbfs),
        releaseThresholdDbfsBucket = dbfsBucket(releaseThresholdDbfs),
        speechConfirmed = speechConfirmed,
        silenceElapsedMs =
          if (speechConfirmed) {
            lastSpeechAtMs?.let { (elapsedMs - it).coerceAtLeast(0L) } ?: 0L
          } else {
            0L
          },
        silenceResetCount = silenceResetCount,
        terminal = terminal,
      )
    runCatching { onDiagnostic(diagnostic) }
  }

  private fun finish(outcome: Outcome): Outcome {
    terminal = true
    return outcome
  }

  companion object {
    private const val MAX_AMPLITUDE = 32_767
    private const val SILENCE_DBFS = -90.0
    private const val INITIAL_NOISE_FLOOR_DBFS = -60.0
    private const val NOISE_FLOOR_ALPHA = 0.25
    private const val CALIBRATION_MS = 300L
    private const val DIAGNOSTIC_INTERVAL_MS = 500L
    private const val DBFS_BUCKET_SIZE = 3.0
    // Startup has no prior ambient sample. This gate separates moderate steady room noise from
    // speech strong enough to begin immediately while the adaptive floor is still calibrating.
    private const val CALIBRATION_DIRECT_ONSET_DBFS = -32.0
    private fun dbfsBucket(value: Double): Int =
      (value / DBFS_BUCKET_SIZE).roundToInt() * DBFS_BUCKET_SIZE.toInt()
    internal fun amplitudeToDbfs(peakAmplitude: Int): Double {
      require(peakAmplitude in 0..MAX_AMPLITUDE)
      if (peakAmplitude == 0) return SILENCE_DBFS
      return 20.0 * log10(peakAmplitude.toDouble() / MAX_AMPLITUDE)
    }
  }
}

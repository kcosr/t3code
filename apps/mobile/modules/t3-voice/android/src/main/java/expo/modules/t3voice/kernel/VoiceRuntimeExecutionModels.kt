package expo.modules.t3voice.kernel

import expo.modules.t3voice.net.VoiceRuntimeSpeechDisposition

internal enum class VoiceRuntimeExecutionMode {
  REALTIME,
  THREAD,
}

internal enum class VoiceRuntimePhase {
  LOCKED,
  IDLE,
  REALTIME_STARTING,
  REALTIME_ACTIVE,
  RECORDING,
  FINALIZED,
  UPLOADING,
  TRANSCRIBING,
  WAITING,
  PLAYING,
  PLAYBACK_DRAINED,
  REARMING,
  ATTENTION_REQUIRED,
  FAILED,
}

internal enum class VoiceRuntimeTerminalSummary {
  COMPLETED,
  ATTENTION_REQUIRED,
  CANCELLED,
  FAILED_RETRYABLE,
  FAILED_PERMANENT,
}

internal data class VoiceRuntimeExecutionSnapshot(
  val runtimeId: String? = null,
  val readinessGeneration: Long = -1,
  val mode: VoiceRuntimeExecutionMode? = null,
  val phase: VoiceRuntimePhase = VoiceRuntimePhase.LOCKED,
  val operationId: String? = null,
  val operationGeneration: Long? = null,
  val recordingId: String? = null,
  val dispatchAcknowledged: Boolean = false,
  val eventCursor: Long = 0,
  val playbackCursor: Int = -1,
  val highestAdvertisedSpeechSegment: Int = -1,
  val finalSpeechSegment: Int? = null,
  val speechTerminal: Boolean = false,
  val noSpeech: Boolean = false,
  val responseTerminal: Boolean = false,
  val autoRearm: Boolean = false,
  val messageId: String? = null,
  val turnId: String? = null,
  val terminalSummary: VoiceRuntimeTerminalSummary? = null,
  val highestStartedSpeechSegment: Int = -1,
  val highestDrainedSpeechSegment: Int = -1,
  val speechSegmentDispositions: List<VoiceRuntimeSpeechDisposition> = emptyList(),
) {
  init {
    require(readinessGeneration >= -1 && eventCursor >= 0) { "Invalid runtime voice cursor." }
    require(
      playbackCursor >= -1 && highestAdvertisedSpeechSegment >= -1 &&
        highestStartedSpeechSegment >= -1 && highestDrainedSpeechSegment >= -1,
    ) {
      "Invalid runtime speech cursor."
    }
    require(
      highestDrainedSpeechSegment <= highestStartedSpeechSegment &&
        playbackCursor <= highestStartedSpeechSegment &&
        highestStartedSpeechSegment <= highestAdvertisedSpeechSegment,
    ) {
      "Playback cannot advance beyond advertised speech."
    }
    val dispositions = speechSegmentDispositions.associateBy { it.segmentIndex }
    require(dispositions.size == speechSegmentDispositions.size) {
      "Speech segments cannot have duplicate dispositions."
    }
    require(speechSegmentDispositions.all {
      it.segmentIndex in 0..highestStartedSpeechSegment &&
        it.disposition in setOf("drained", "interrupted", "skipped", "failed")
    }) { "Invalid speech segment disposition." }
    require(
      playbackCursor == -1 || (0..playbackCursor).all(dispositions::containsKey),
    ) { "Resolved playback must have a disposition for every preceding segment." }
    val maximumDrained = speechSegmentDispositions
      .filter { it.disposition == "drained" }
      .maxOfOrNull(VoiceRuntimeSpeechDisposition::segmentIndex) ?: -1
    require(highestDrainedSpeechSegment == maximumDrained) {
      "Highest drained playback must match the durable segment dispositions."
    }
    require(finalSpeechSegment === null || finalSpeechSegment in 0..highestAdvertisedSpeechSegment) {
      "Invalid final speech segment."
    }
    listOf(runtimeId, operationId, recordingId, messageId, turnId).forEach { value ->
      require(value === null || (value.isNotBlank() && value.length <= 128)) {
        "Invalid runtime voice identifier."
      }
    }
    if (phase == VoiceRuntimePhase.LOCKED) {
      require(
        runtimeId === null &&
          readinessGeneration == -1L &&
          mode === null &&
          operationId === null &&
          operationGeneration === null &&
          recordingId === null &&
          !dispatchAcknowledged &&
          eventCursor == 0L &&
          playbackCursor == -1 &&
          highestAdvertisedSpeechSegment == -1 &&
          highestStartedSpeechSegment == -1 &&
          highestDrainedSpeechSegment == -1 &&
          speechSegmentDispositions.isEmpty() &&
          finalSpeechSegment === null &&
          !speechTerminal &&
          !noSpeech &&
          !responseTerminal &&
          !autoRearm &&
          messageId === null &&
          turnId === null &&
          terminalSummary === null,
      ) { "Locked runtime voice state must not retain authority or operation state." }
    } else {
      require(runtimeId !== null && mode !== null && readinessGeneration > 0)
    }
    require((operationId === null) == (operationGeneration === null)) {
      "Runtime operation identity and generation must be present together."
    }
    operationGeneration?.let {
      require(it > 0 && it <= readinessGeneration) { "Invalid runtime operation generation." }
    }
    if (operationId === null) {
      require(
        recordingId === null &&
          !dispatchAcknowledged &&
          eventCursor == 0L &&
          playbackCursor == -1 &&
          highestAdvertisedSpeechSegment == -1 &&
          highestStartedSpeechSegment == -1 &&
          highestDrainedSpeechSegment == -1 &&
          speechSegmentDispositions.isEmpty() &&
          finalSpeechSegment === null &&
          !speechTerminal &&
          !noSpeech &&
          !responseTerminal &&
          messageId === null &&
          turnId === null,
      ) { "Operation-free state cannot retain operation progress." }
    }
    require(!noSpeech || speechTerminal) { "No-speech state must be terminal." }
    require(!noSpeech || highestAdvertisedSpeechSegment == -1) {
      "No-speech state cannot advertise speech segments."
    }
    require(!speechTerminal || noSpeech || finalSpeechSegment !== null) {
      "Terminal speech requires a final segment or explicit no-speech state."
    }
    when (mode) {
      VoiceRuntimeExecutionMode.REALTIME -> {
        require(
          phase == VoiceRuntimePhase.IDLE ||
            phase == VoiceRuntimePhase.REALTIME_STARTING ||
            phase == VoiceRuntimePhase.REALTIME_ACTIVE,
        ) { "Realtime mode cannot restore a thread-operation phase." }
        require(
          recordingId === null &&
            !dispatchAcknowledged &&
            eventCursor == 0L &&
            playbackCursor == -1 &&
            highestAdvertisedSpeechSegment == -1 &&
            highestStartedSpeechSegment == -1 &&
            highestDrainedSpeechSegment == -1 &&
            speechSegmentDispositions.isEmpty() &&
            !speechTerminal &&
            !responseTerminal &&
            messageId === null &&
            turnId === null,
        ) { "Realtime mode cannot retain thread-operation progress." }
      }
      VoiceRuntimeExecutionMode.THREAD -> {
        require(
          phase != VoiceRuntimePhase.REALTIME_STARTING &&
            phase != VoiceRuntimePhase.REALTIME_ACTIVE,
        ) { "Thread mode cannot restore a Realtime phase." }
      }
      null -> Unit
    }
    if (phase == VoiceRuntimePhase.IDLE || phase == VoiceRuntimePhase.REARMING) {
      require(operationId === null) { "Idle runtime voice state cannot retain an operation." }
    } else if (phase != VoiceRuntimePhase.LOCKED) {
      require(operationId !== null) { "Active runtime voice state requires an operation." }
    }
    if (phase == VoiceRuntimePhase.RECORDING || phase == VoiceRuntimePhase.FINALIZED) {
      require(recordingId !== null) { "Capture and upload phases require a recording." }
    }
    if (phase == VoiceRuntimePhase.UPLOADING) {
      require(recordingId !== null || dispatchAcknowledged) {
        "Uploading state requires a recording or dispatch acknowledgement."
      }
    }
    if (dispatchAcknowledged) {
      require(recordingId === null) { "Accepted operations cannot retain a recording." }
    }
    if (phase == VoiceRuntimePhase.PLAYING) {
      require(playbackCursor < highestAdvertisedSpeechSegment) {
        "Playing state requires an undrained speech segment."
      }
    }
    if (phase == VoiceRuntimePhase.PLAYBACK_DRAINED) {
      require(speechFullyDrained()) { "Playback-drained state requires terminal drained speech." }
    }
    if (phase == VoiceRuntimePhase.ATTENTION_REQUIRED) {
      require(
        responseTerminal && terminalSummary == VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED,
      ) { "Attention-required state requires its terminal summary." }
    }
    if (phase == VoiceRuntimePhase.FAILED) {
      require(
        responseTerminal && terminalSummary in setOf(
          VoiceRuntimeTerminalSummary.CANCELLED,
          VoiceRuntimeTerminalSummary.FAILED_RETRYABLE,
          VoiceRuntimeTerminalSummary.FAILED_PERMANENT,
        ),
      ) {
        "Failed state requires a failure terminal summary."
      }
    }
  }

  fun speechFullyDrained(): Boolean =
    responseTerminal &&
      speechTerminal &&
      (noSpeech || finalSpeechSegment?.let { playbackCursor >= it } == true)
}

internal enum class VoiceRuntimeServerPhase {
  CREATED,
  TRANSCRIBING,
  DISPATCHING,
  WAITING,
  SPEAKING,
  COMPLETED,
  ATTENTION_REQUIRED,
  CANCELLED,
  FAILED_RETRYABLE,
  FAILED_PERMANENT,
}

internal sealed interface VoiceRuntimeExecutionEvent {
  data class AuthorityValidated(
    val runtimeId: String,
    val readinessGeneration: Long,
    val mode: VoiceRuntimeExecutionMode,
    val autoRearm: Boolean,
  ) : VoiceRuntimeExecutionEvent

  data class AuthorityLost(val readinessGeneration: Long) : VoiceRuntimeExecutionEvent

  data class TargetReplaced(val readinessGeneration: Long) : VoiceRuntimeExecutionEvent

  data class StartRealtime(val operationId: String) : VoiceRuntimeExecutionEvent

  data class RealtimeConnected(val operationId: String) : VoiceRuntimeExecutionEvent

  data class StartRecording(val operationId: String, val recordingId: String) :
    VoiceRuntimeExecutionEvent

  data class RecordingFinalized(val operationId: String, val recordingId: String) :
    VoiceRuntimeExecutionEvent

  data class UploadStarted(val operationId: String) : VoiceRuntimeExecutionEvent

  data class ServerEvent(
    val operationId: String,
    val operationGeneration: Long,
    val sequence: Long,
    val phase: VoiceRuntimeServerPhase,
    val dispatchAcknowledged: Boolean = false,
    val speechSegmentIndex: Int? = null,
    val finalSpeechSegment: Boolean = false,
    val speechTerminal: Boolean = false,
    val noSpeech: Boolean = false,
    val messageId: String? = null,
    val turnId: String? = null,
  ) : VoiceRuntimeExecutionEvent

  data class PlaybackStarted(val operationId: String, val segmentIndex: Int) :
    VoiceRuntimeExecutionEvent

  data class PlaybackDrained(val operationId: String, val segmentIndex: Int) :
    VoiceRuntimeExecutionEvent

  data class PlaybackFailed(val operationId: String, val segmentIndex: Int) :
    VoiceRuntimeExecutionEvent

  data object NetworkRetry : VoiceRuntimeExecutionEvent

  data object ProcessRestored : VoiceRuntimeExecutionEvent

  data object RearmGuardElapsed : VoiceRuntimeExecutionEvent

  data object Stop : VoiceRuntimeExecutionEvent
}

internal enum class VoiceRuntimeCommand {
  START_REALTIME,
  RESTART_REALTIME,
  CLOSE_REALTIME,
  START_RECORDING,
  CANCEL_RECORDING,
  UPLOAD_RECORDING,
  DELETE_RECORDING,
  CANCEL_UNDISPATCHED_OPERATION,
  DETACH_DISPATCHED_OPERATION,
  FETCH_EVENT_GAP,
  FETCH_SPEECH_SEGMENT,
  CANCEL_PLAYBACK,
  SCHEDULE_REARM_GUARD,
}

internal data class VoiceRuntimeExecutionTransition(
  val snapshot: VoiceRuntimeExecutionSnapshot,
  val commands: List<VoiceRuntimeCommand> = emptyList(),
)

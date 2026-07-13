package expo.modules.t3voice

internal enum class T3VoiceBackgroundMode {
  REALTIME,
  THREAD,
}

internal enum class T3VoiceBackgroundPhase {
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

internal enum class T3VoiceBackgroundTerminalSummary {
  COMPLETED,
  ATTENTION_REQUIRED,
  CANCELLED,
  FAILED_RETRYABLE,
  FAILED_PERMANENT,
}

internal data class T3VoiceBackgroundSnapshot(
  val runtimeId: String? = null,
  val readinessGeneration: Long = -1,
  val mode: T3VoiceBackgroundMode? = null,
  val phase: T3VoiceBackgroundPhase = T3VoiceBackgroundPhase.LOCKED,
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
  val terminalSummary: T3VoiceBackgroundTerminalSummary? = null,
) {
  init {
    require(readinessGeneration >= -1 && eventCursor >= 0) { "Invalid background voice cursor." }
    require(playbackCursor >= -1 && highestAdvertisedSpeechSegment >= -1) {
      "Invalid background speech cursor."
    }
    require(playbackCursor <= highestAdvertisedSpeechSegment) {
      "Playback cannot advance beyond advertised speech."
    }
    require(finalSpeechSegment === null || finalSpeechSegment in 0..highestAdvertisedSpeechSegment) {
      "Invalid final speech segment."
    }
    listOf(runtimeId, operationId, recordingId, messageId, turnId).forEach { value ->
      require(value === null || (value.isNotBlank() && value.length <= 128)) {
        "Invalid background voice identifier."
      }
    }
    if (phase == T3VoiceBackgroundPhase.LOCKED) {
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
          finalSpeechSegment === null &&
          !speechTerminal &&
          !noSpeech &&
          !responseTerminal &&
          !autoRearm &&
          messageId === null &&
          turnId === null &&
          terminalSummary === null,
      ) { "Locked background voice state must not retain authority or operation state." }
    } else {
      require(runtimeId !== null && mode !== null && readinessGeneration > 0)
    }
    require((operationId === null) == (operationGeneration === null)) {
      "Background operation identity and generation must be present together."
    }
    operationGeneration?.let {
      require(it > 0 && it <= readinessGeneration) { "Invalid background operation generation." }
    }
    if (operationId === null) {
      require(
        recordingId === null &&
          !dispatchAcknowledged &&
          eventCursor == 0L &&
          playbackCursor == -1 &&
          highestAdvertisedSpeechSegment == -1 &&
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
      T3VoiceBackgroundMode.REALTIME -> {
        require(
          phase == T3VoiceBackgroundPhase.IDLE ||
            phase == T3VoiceBackgroundPhase.REALTIME_STARTING ||
            phase == T3VoiceBackgroundPhase.REALTIME_ACTIVE,
        ) { "Realtime mode cannot restore a thread-operation phase." }
        require(
          recordingId === null &&
            !dispatchAcknowledged &&
            eventCursor == 0L &&
            playbackCursor == -1 &&
            highestAdvertisedSpeechSegment == -1 &&
            !speechTerminal &&
            !responseTerminal &&
            messageId === null &&
            turnId === null,
        ) { "Realtime mode cannot retain thread-operation progress." }
      }
      T3VoiceBackgroundMode.THREAD -> {
        require(
          phase != T3VoiceBackgroundPhase.REALTIME_STARTING &&
            phase != T3VoiceBackgroundPhase.REALTIME_ACTIVE,
        ) { "Thread mode cannot restore a Realtime phase." }
      }
      null -> Unit
    }
    if (phase == T3VoiceBackgroundPhase.IDLE || phase == T3VoiceBackgroundPhase.REARMING) {
      require(operationId === null) { "Idle background voice state cannot retain an operation." }
    } else if (phase != T3VoiceBackgroundPhase.LOCKED) {
      require(operationId !== null) { "Active background voice state requires an operation." }
    }
    if (phase == T3VoiceBackgroundPhase.RECORDING || phase == T3VoiceBackgroundPhase.FINALIZED) {
      require(recordingId !== null) { "Capture and upload phases require a recording." }
    }
    if (phase == T3VoiceBackgroundPhase.UPLOADING) {
      require(recordingId !== null || dispatchAcknowledged) {
        "Uploading state requires a recording or dispatch acknowledgement."
      }
    }
    if (dispatchAcknowledged) {
      require(recordingId === null) { "Accepted operations cannot retain a recording." }
    }
    if (phase == T3VoiceBackgroundPhase.PLAYING) {
      require(playbackCursor < highestAdvertisedSpeechSegment) {
        "Playing state requires an undrained speech segment."
      }
    }
    if (phase == T3VoiceBackgroundPhase.PLAYBACK_DRAINED) {
      require(speechFullyDrained()) { "Playback-drained state requires terminal drained speech." }
    }
    if (phase == T3VoiceBackgroundPhase.ATTENTION_REQUIRED) {
      require(
        responseTerminal && terminalSummary == T3VoiceBackgroundTerminalSummary.ATTENTION_REQUIRED,
      ) { "Attention-required state requires its terminal summary." }
    }
    if (phase == T3VoiceBackgroundPhase.FAILED) {
      require(
        responseTerminal && terminalSummary in setOf(
          T3VoiceBackgroundTerminalSummary.CANCELLED,
          T3VoiceBackgroundTerminalSummary.FAILED_RETRYABLE,
          T3VoiceBackgroundTerminalSummary.FAILED_PERMANENT,
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

internal enum class T3VoiceBackgroundServerPhase {
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

internal sealed interface T3VoiceBackgroundEvent {
  data class AuthorityValidated(
    val runtimeId: String,
    val readinessGeneration: Long,
    val mode: T3VoiceBackgroundMode,
    val autoRearm: Boolean,
  ) : T3VoiceBackgroundEvent

  data class AuthorityLost(val readinessGeneration: Long) : T3VoiceBackgroundEvent

  data class TargetReplaced(val readinessGeneration: Long) : T3VoiceBackgroundEvent

  data class StartRealtime(val operationId: String) : T3VoiceBackgroundEvent

  data class RealtimeConnected(val operationId: String) : T3VoiceBackgroundEvent

  data class StartRecording(val operationId: String, val recordingId: String) :
    T3VoiceBackgroundEvent

  data class RecordingFinalized(val operationId: String, val recordingId: String) :
    T3VoiceBackgroundEvent

  data class UploadStarted(val operationId: String) : T3VoiceBackgroundEvent

  data class ServerEvent(
    val operationId: String,
    val operationGeneration: Long,
    val sequence: Long,
    val phase: T3VoiceBackgroundServerPhase,
    val dispatchAcknowledged: Boolean = false,
    val speechSegmentIndex: Int? = null,
    val finalSpeechSegment: Boolean = false,
    val speechTerminal: Boolean = false,
    val noSpeech: Boolean = false,
    val messageId: String? = null,
    val turnId: String? = null,
  ) : T3VoiceBackgroundEvent

  data class PlaybackStarted(val operationId: String, val segmentIndex: Int) :
    T3VoiceBackgroundEvent

  data class PlaybackDrained(val operationId: String, val segmentIndex: Int) :
    T3VoiceBackgroundEvent

  data object NetworkRetry : T3VoiceBackgroundEvent

  data object ProcessRestored : T3VoiceBackgroundEvent

  data object RearmGuardElapsed : T3VoiceBackgroundEvent

  data object Stop : T3VoiceBackgroundEvent
}

internal enum class T3VoiceBackgroundCommand {
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

internal data class T3VoiceBackgroundTransition(
  val snapshot: T3VoiceBackgroundSnapshot,
  val commands: List<T3VoiceBackgroundCommand> = emptyList(),
)

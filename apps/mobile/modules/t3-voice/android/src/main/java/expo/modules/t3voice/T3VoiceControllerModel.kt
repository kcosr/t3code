package expo.modules.t3voice

internal object T3VoiceRuntimeBounds {
  const val MAXIMUM_THREAD_TRANSCRIPT_CHARS = 65_536
  const val MAXIMUM_PENDING_REALTIME_CLIENT_ACTIONS = 32
  const val MAXIMUM_PENDING_REALTIME_CONFIRMATIONS = 32
  const val MINIMUM_END_SILENCE_MS = 250L
  const val MAXIMUM_END_SILENCE_MS = 10_000L
  const val MINIMUM_NO_SPEECH_TIMEOUT_MS = 1_000L
  const val MINIMUM_UTTERANCE_MS = 1_000L
  const val MAXIMUM_UTTERANCE_MS = 30L * 60L * 1_000L
  const val MAXIMUM_LONG_OPERATION_TIMEOUT_MS = 30L * 60L * 1_000L
  const val MAXIMUM_SUBMISSION_TIMEOUT_MS = 120_000L
}

internal class T3VoiceNativeSessionConfig(
  val baseUrl: String,
  val accessToken: String,
  val expiresAt: String,
) {
  init {
    require(baseUrl.isNotBlank()) { "baseUrl must be non-empty." }
    require(accessToken.isNotBlank()) { "accessToken must be non-empty." }
    require(expiresAt.isNotBlank()) { "expiresAt must be non-empty." }
  }

  override fun toString(): String = "T3VoiceNativeSessionConfig(<redacted>)"
}

internal enum class T3VoiceThreadRuntimeMode {
  APPROVAL_REQUIRED,
  AUTO_ACCEPT_EDITS,
  FULL_ACCESS,
}

internal enum class T3VoiceThreadInteractionMode {
  DEFAULT,
  PLAN,
}

internal sealed interface T3VoiceModelOptionValue {
  data class StringValue(val value: String) : T3VoiceModelOptionValue {
    init {
      require(value.isNotBlank() && value == value.trim()) {
        "Model option string values must be trimmed and non-empty."
      }
    }
  }

  data class BooleanValue(val value: Boolean) : T3VoiceModelOptionValue
}

internal data class T3VoiceModelOption(
  val id: String,
  val value: T3VoiceModelOptionValue,
) {
  init {
    require(id.isNotBlank() && id == id.trim()) {
      "Model option ids must be trimmed and non-empty."
    }
  }
}

internal data class T3VoiceModelSelection(
  val instanceId: String,
  val model: String,
  val options: List<T3VoiceModelOption>?,
) {
  init {
    require(PROVIDER_INSTANCE_ID.matches(instanceId)) { "Model instanceId is invalid." }
    require(model.isNotBlank() && model == model.trim()) {
      "Model id must be trimmed and non-empty."
    }
  }

  private companion object {
    val PROVIDER_INSTANCE_ID = Regex("^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")
  }
}

internal fun T3VoiceModelSelection.toCanonicalWireBody(): Map<String, Any> =
  buildMap {
    put("instanceId", instanceId)
    put("model", model)
    if (options != null) {
      put(
        "options",
        options.map { option ->
          mapOf(
            "id" to option.id,
            "value" to option.value.canonicalWireValue(),
          )
        },
      )
    }
  }

private fun T3VoiceModelOptionValue.canonicalWireValue(): Any =
  when (this) {
    is T3VoiceModelOptionValue.StringValue -> value
    is T3VoiceModelOptionValue.BooleanValue -> value
  }

internal data class T3VoiceThreadTarget(
  val environmentId: String,
  val projectId: String,
  val threadId: String,
  val modelSelection: T3VoiceModelSelection,
  val runtimeMode: T3VoiceThreadRuntimeMode,
  val interactionMode: T3VoiceThreadInteractionMode,
) {
  init {
    require(environmentId.isNotBlank()) { "environmentId must be non-empty." }
    require(projectId.isNotBlank()) { "projectId must be non-empty." }
    require(threadId.isNotBlank()) { "threadId must be non-empty." }
  }
}

/** Server-resolved Thread target; the owning Realtime runtime supplies its environment. */
internal data class T3VoiceRemoteThreadTarget(
  val projectId: String,
  val threadId: String,
  val modelSelection: T3VoiceModelSelection,
  val runtimeMode: T3VoiceThreadRuntimeMode,
  val interactionMode: T3VoiceThreadInteractionMode,
) {
  init {
    require(projectId.isNotBlank()) { "projectId must be non-empty." }
    require(threadId.isNotBlank()) { "threadId must be non-empty." }
  }

  fun inEnvironment(environmentId: String): T3VoiceThreadTarget =
    T3VoiceThreadTarget(
      environmentId = environmentId,
      projectId = projectId,
      threadId = threadId,
      modelSelection = modelSelection,
      runtimeMode = runtimeMode,
      interactionMode = interactionMode,
    )
}

internal enum class T3VoiceThreadSubmissionPolicy {
  REVIEW,
  AUTO_SUBMIT,
}

internal data class T3VoiceThreadEndpointDetection(
  val endSilenceMs: Long,
  val noSpeechTimeoutMs: Long?,
  val maximumUtteranceMs: Long,
) {
  init {
    require(
      endSilenceMs in
        T3VoiceRuntimeBounds.MINIMUM_END_SILENCE_MS..
          T3VoiceRuntimeBounds.MAXIMUM_END_SILENCE_MS,
    ) { "endSilenceMs is outside the supported range." }
    require(
      maximumUtteranceMs in
        T3VoiceRuntimeBounds.MINIMUM_UTTERANCE_MS..
          T3VoiceRuntimeBounds.MAXIMUM_UTTERANCE_MS,
    ) { "maximumUtteranceMs is outside the supported range." }
    require(
      noSpeechTimeoutMs == null ||
        noSpeechTimeoutMs in
          T3VoiceRuntimeBounds.MINIMUM_NO_SPEECH_TIMEOUT_MS..maximumUtteranceMs,
    ) {
      "noSpeechTimeoutMs must be null or within the utterance duration."
    }
  }
}

internal data class T3VoiceThreadSettings(
  val submissionPolicy: T3VoiceThreadSubmissionPolicy,
  val playResponses: Boolean,
  val autoRearm: Boolean,
  val endpointDetection: T3VoiceThreadEndpointDetection,
  val rearmDelayMs: Long,
  val transcriptionTimeoutMs: Long,
  val submissionTimeoutMs: Long,
  val responseTimeoutMs: Long,
) {
  init {
    require(rearmDelayMs in 0..MAXIMUM_REARM_DELAY_MS) {
      "rearmDelayMs must be between 0 and $MAXIMUM_REARM_DELAY_MS."
    }
    require(transcriptionTimeoutMs in 1L..T3VoiceRuntimeBounds.MAXIMUM_LONG_OPERATION_TIMEOUT_MS) {
      "transcriptionTimeoutMs is outside the supported range."
    }
    require(submissionTimeoutMs in 1L..T3VoiceRuntimeBounds.MAXIMUM_SUBMISSION_TIMEOUT_MS) {
      "submissionTimeoutMs is outside the supported range."
    }
    require(responseTimeoutMs in 1L..T3VoiceRuntimeBounds.MAXIMUM_LONG_OPERATION_TIMEOUT_MS) {
      "responseTimeoutMs is outside the supported range."
    }
  }

  private companion object {
    const val MAXIMUM_REARM_DELAY_MS = 60_000L
  }
}

internal data class T3VoiceThreadStart(
  val target: T3VoiceThreadTarget,
  val settings: T3VoiceThreadSettings,
)

internal enum class T3VoiceConversationRetention {
  EPHEMERAL,
  DURABLE,
}

internal sealed interface T3VoiceConversationSelection {
  data class New(
    val retention: T3VoiceConversationRetention,
    val title: String?,
  ) : T3VoiceConversationSelection {
    init {
      require(title == null || title.isNotBlank()) { "Conversation title must be null or non-empty." }
    }
  }

  data class Continue(
    val conversationId: String,
    val takeover: Boolean,
  ) : T3VoiceConversationSelection {
    init {
      require(conversationId.isNotBlank()) { "conversationId must be non-empty." }
    }
  }
}

internal data class T3VoiceRealtimeFocus(
  val projectId: String,
  val threadId: String,
) {
  init {
    require(projectId.isNotBlank()) { "projectId must be non-empty." }
    require(threadId.isNotBlank()) { "threadId must be non-empty." }
  }
}

internal data class T3VoiceRealtimeContext(
  val focus: T3VoiceRealtimeFocus?,
  val threadSettings: T3VoiceThreadSettings?,
)

internal data class T3VoiceRealtimeTarget(
  val environmentId: String,
  val conversation: T3VoiceConversationSelection,
  val focus: T3VoiceRealtimeFocus?,
  val threadSettings: T3VoiceThreadSettings?,
) {
  init {
    require(environmentId.isNotBlank()) { "environmentId must be non-empty." }
  }
}

internal data class T3VoiceRealtimeClientAction(
  val actionId: String,
  val projectId: String,
  val threadId: String,
  val expiresAt: String,
) {
  init {
    require(actionId.isNotBlank()) { "actionId must be non-empty." }
    require(projectId.isNotBlank()) { "projectId must be non-empty." }
    require(threadId.isNotBlank()) { "threadId must be non-empty." }
    require(expiresAt.isNotBlank()) { "expiresAt must be non-empty." }
  }
}

internal sealed interface T3VoiceRealtimeTerminalAction {
  val actionId: String

  data class StopRealtime(
    override val actionId: String,
  ) : T3VoiceRealtimeTerminalAction {
    init {
      require(actionId.isNotBlank()) { "actionId must be non-empty." }
    }
  }

  data class SwitchToThread(
    override val actionId: String,
    val target: T3VoiceRemoteThreadTarget,
  ) : T3VoiceRealtimeTerminalAction {
    init {
      require(actionId.isNotBlank()) { "actionId must be non-empty." }
    }
  }
}

internal enum class T3VoiceClientActionOutcome {
  SUCCEEDED,
  FAILED,
}

internal enum class T3VoiceTranscriptRole {
  USER,
  ASSISTANT,
}

internal data class T3VoiceRealtimeTranscriptTurn(
  val role: T3VoiceTranscriptRole,
  val text: String,
) {
  init {
    require(text.isNotBlank()) { "Transcript turn must be non-empty." }
  }
}

internal enum class T3VoiceToolName {
  LIST_PROJECTS,
  LIST_THREADS,
  GET_THREAD_STATUS,
  GET_THREAD_MESSAGES,
  WAIT_FOR_THREAD_TURN,
  SEARCH_HISTORY,
  READ_HISTORY,
  ACTIVATE_THREAD,
  STOP_REALTIME_VOICE,
  SWITCH_TO_THREAD_VOICE,
  CREATE_THREAD,
  SEND_THREAD_MESSAGE,
  INTERRUPT_THREAD,
  ARCHIVE_THREAD,
}

internal data class T3VoiceRealtimeConfirmation(
  val confirmationId: String,
  val tool: T3VoiceToolName,
  val summary: String,
  val expiresAt: String,
) {
  init {
    require(confirmationId.isNotBlank()) { "confirmationId must be non-empty." }
    require(summary.isNotBlank()) { "Confirmation summary must be non-empty." }
    require(expiresAt.isNotBlank()) { "expiresAt must be non-empty." }
  }
}

internal enum class T3VoiceConfirmationDecision {
  APPROVE,
  REJECT,
}

internal enum class T3VoiceRealtimeStage {
  STARTING,
  CONNECTED,
  STOPPING,
}

internal enum class T3VoiceSwitchStage {
  CLOSING_REALTIME,
  STARTING_RECORDER,
}

internal enum class T3VoiceThreadStage {
  STARTING,
  RECORDING,
  FINALIZING,
  UPLOADING,
  REVIEWING,
  SUBMITTING,
  WAITING,
  PLAYING,
  REARMING,
  STOPPING,
}

internal enum class T3VoiceThreadAttention {
  APPROVAL_REQUIRED,
  USER_INPUT_REQUIRED,
}

internal enum class T3VoiceOperation {
  REALTIME,
  THREAD,
  SWITCHING_TO_THREAD,
  SWITCHING_TO_REALTIME,
}

internal data class T3VoiceFailure(
  val code: String,
  val message: String,
  val recoverable: Boolean,
) {
  init {
    require(code.isNotBlank()) { "Failure code must be non-empty." }
    require(message.isNotBlank()) { "Failure message must be non-empty." }
  }
}

internal sealed interface T3VoiceControllerState {
  data object Idle : T3VoiceControllerState

  data class Realtime(
    val stage: T3VoiceRealtimeStage,
    val target: T3VoiceRealtimeTarget,
    val muted: Boolean,
    val pendingClientActions: List<T3VoiceRealtimeClientAction>,
    val transcript: List<T3VoiceRealtimeTranscriptTurn>,
    val pendingConfirmations: List<T3VoiceRealtimeConfirmation>,
  ) : T3VoiceControllerState

  data class SwitchingToThread(
    val stage: T3VoiceSwitchStage,
    val realtimeTarget: T3VoiceRealtimeTarget,
    val threadStart: T3VoiceThreadStart,
  ) : T3VoiceControllerState

  data class SwitchingToRealtime(
    val threadStart: T3VoiceThreadStart,
    val realtimeTarget: T3VoiceRealtimeTarget,
  ) : T3VoiceControllerState

  data class Thread(
    val stage: T3VoiceThreadStage,
    val target: T3VoiceThreadTarget,
    val settings: T3VoiceThreadSettings,
    val transcript: String?,
    val attention: T3VoiceThreadAttention?,
    val reviewId: Long? = null,
    val cycleFailure: T3VoiceFailure? = null,
  ) : T3VoiceControllerState

  data class Failed(
    val environmentId: String,
    val operation: T3VoiceOperation,
    val failure: T3VoiceFailure,
  ) : T3VoiceControllerState {
    init {
      require(environmentId.isNotBlank()) { "environmentId must be non-empty." }
    }
  }
}

internal data class T3VoiceControllerSnapshot(
  val state: T3VoiceControllerState,
  val generation: Long,
  val sequence: Long,
)

internal sealed interface T3VoiceRuntimeCommand {
  data class StartRealtime(
    val target: T3VoiceRealtimeTarget,
    val session: T3VoiceNativeSessionConfig,
  ) : T3VoiceRuntimeCommand

  data class StartThread(
    val target: T3VoiceThreadTarget,
    val settings: T3VoiceThreadSettings,
    val session: T3VoiceNativeSessionConfig,
  ) : T3VoiceRuntimeCommand

  data class SwitchRealtimeToThread(
    val target: T3VoiceThreadTarget,
    val settings: T3VoiceThreadSettings,
  ) : T3VoiceRuntimeCommand

  data class SwitchThreadToRealtime(
    val target: T3VoiceRealtimeTarget,
    val session: T3VoiceNativeSessionConfig,
  ) : T3VoiceRuntimeCommand

  data class SetRealtimeMuted(
    val muted: Boolean,
  ) : T3VoiceRuntimeCommand

  data class UpdateRealtimeContext(
    val context: T3VoiceRealtimeContext,
  ) : T3VoiceRuntimeCommand

  data class DecideRealtimeConfirmation(
    val confirmationId: String,
    val decision: T3VoiceConfirmationDecision,
  ) : T3VoiceRuntimeCommand {
    init {
      require(confirmationId.isNotBlank()) { "confirmationId must be non-empty." }
    }
  }

  data class CompleteRealtimeClientAction(
    val actionId: String,
    val outcome: T3VoiceClientActionOutcome,
    val message: String?,
  ) : T3VoiceRuntimeCommand {
    init {
      require(actionId.isNotBlank()) { "actionId must be non-empty." }
      require(message == null || message.isNotBlank()) { "message must be null or non-empty." }
    }
  }

  data object FinishThreadUtterance : T3VoiceRuntimeCommand

  data class UpdateThreadReviewTranscript(
    val expectedGeneration: Long,
    val expectedReviewId: Long,
    val transcript: String,
  ) : T3VoiceRuntimeCommand {
    init {
      require(expectedGeneration > 0) { "expectedGeneration must be positive." }
      require(expectedReviewId > 0) { "expectedReviewId must be positive." }
      require(transcript.length <= T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS) {
        "Transcript is too long."
      }
    }
  }

  data class SubmitThreadTranscript(
    val expectedGeneration: Long,
    val expectedReviewId: Long,
    val transcript: String,
  ) : T3VoiceRuntimeCommand {
    init {
      require(expectedGeneration > 0) { "expectedGeneration must be positive." }
      require(expectedReviewId > 0) { "expectedReviewId must be positive." }
      require(transcript.isNotBlank()) { "Transcript must be non-empty." }
      require(transcript.length <= T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS) {
        "Transcript is too long."
      }
    }
  }

  data object Stop : T3VoiceRuntimeCommand
}

internal sealed interface T3VoiceRuntimeCallback {
  data object RealtimeConnected : T3VoiceRuntimeCallback

  data object RealtimeClosed : T3VoiceRuntimeCallback

  /** Native ownership finally ended after an earlier failure initiated asynchronous release. */
  data object NativeReleaseQuiesced : T3VoiceRuntimeCallback

  data class RealtimeClientActionReceived(
    val action: T3VoiceRealtimeClientAction,
  ) : T3VoiceRuntimeCallback

  data class RealtimeClientActionResolved(
    val actionId: String,
  ) : T3VoiceRuntimeCallback {
    init {
      require(actionId.isNotBlank()) { "actionId must be non-empty." }
    }
  }

  data class RealtimeTerminalActionReceived(
    val action: T3VoiceRealtimeTerminalAction,
  ) : T3VoiceRuntimeCallback

  data class RealtimeTranscriptChanged(
    val transcript: List<T3VoiceRealtimeTranscriptTurn>,
  ) : T3VoiceRuntimeCallback

  data class RealtimeConfirmationReceived(
    val confirmation: T3VoiceRealtimeConfirmation,
  ) : T3VoiceRuntimeCallback

  data class RealtimeConfirmationResolved(
    val confirmationId: String,
  ) : T3VoiceRuntimeCallback {
    init {
      require(confirmationId.isNotBlank()) { "confirmationId must be non-empty." }
    }
  }

  data object ThreadRecordingStarted : T3VoiceRuntimeCallback

  data object ThreadEndpointDetected : T3VoiceRuntimeCallback

  data object ThreadNoSpeechDetected : T3VoiceRuntimeCallback

  data class ThreadCycleFailed(
    val failure: T3VoiceFailure,
  ) : T3VoiceRuntimeCallback

  data object ThreadRecordingFinalized : T3VoiceRuntimeCallback

  data class ThreadTranscriptReady(
    val transcript: String,
  ) : T3VoiceRuntimeCallback {
    init {
      require(transcript.isNotBlank()) { "Transcript must be non-empty." }
      require(transcript.length <= T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS) {
        "Transcript is too long."
      }
    }
  }

  data object ThreadSubmitted : T3VoiceRuntimeCallback

  data class ThreadResponseReady(
    val hasPlayback: Boolean,
  ) : T3VoiceRuntimeCallback

  data class ThreadAttentionChanged(
    val attention: T3VoiceThreadAttention?,
  ) : T3VoiceRuntimeCallback

  data object ThreadPlaybackFinished : T3VoiceRuntimeCallback

  data object ThreadRearmReady : T3VoiceRuntimeCallback

  data object ThreadStopped : T3VoiceRuntimeCallback

  data class Failed(
    val failure: T3VoiceFailure,
    val releasePending: Boolean = false,
  ) : T3VoiceRuntimeCallback
}

internal enum class T3VoiceCommandOutcome {
  APPLIED,
  DUPLICATE,
  REJECTED,
}

internal enum class T3VoiceCommandRejection {
  BUSY,
  INVALID_STATE,
  STALE_GENERATION,
  STALE_REVIEW,
}

internal data class T3VoiceCommandResult(
  val outcome: T3VoiceCommandOutcome,
  val snapshot: T3VoiceControllerSnapshot,
  val rejection: T3VoiceCommandRejection? = null,
)

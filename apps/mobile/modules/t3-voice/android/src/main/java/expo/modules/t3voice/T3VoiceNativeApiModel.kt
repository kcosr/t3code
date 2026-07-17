package expo.modules.t3voice

internal enum class T3VoiceMediaOperation(
  val wireValue: String,
) {
  TRANSCRIPTION("transcription-upload"),
  SPEECH("speech-stream"),
}

internal data class T3VoiceMediaTicket(
  val token: String,
  val expiresAt: String,
)

internal data class T3VoiceApiSessionState(
  val sessionId: String,
  val conversationId: String,
  val phase: String,
  val leaseGeneration: Long,
  val sequence: Long,
)

internal data class T3VoiceApiRealtimeSession(
  val state: T3VoiceApiSessionState,
  val signalingPath: String,
  val expiresAt: String,
  val heartbeatIntervalSeconds: Long,
)

internal sealed interface T3VoiceApiRealtimeEvent {
  val sequence: Long

  data class State(
    override val sequence: Long,
    val phase: String,
  ) : T3VoiceApiRealtimeEvent

  data class Transcript(
    override val sequence: Long,
    val role: T3VoiceTranscriptRole,
    val text: String,
    val final: Boolean,
  ) : T3VoiceApiRealtimeEvent

  data class ConfirmationRequired(
    override val sequence: Long,
    val toolCallId: String,
    val confirmation: T3VoiceRealtimeConfirmation,
  ) : T3VoiceApiRealtimeEvent

  data class Tool(
    override val sequence: Long,
    val toolCallId: String,
    val outcome: String,
  ) : T3VoiceApiRealtimeEvent

  data class ClientAction(
    override val sequence: Long,
    val action: T3VoiceRealtimeClientAction,
  ) : T3VoiceApiRealtimeEvent

  data class TerminalAction(
    override val sequence: Long,
    val action: T3VoiceRealtimeTerminalAction,
  ) : T3VoiceApiRealtimeEvent

  data class LeaseFenced(
    override val sequence: Long,
  ) : T3VoiceApiRealtimeEvent

  data class RotationRequired(
    override val sequence: Long,
    val reason: String,
  ) : T3VoiceApiRealtimeEvent

  data class Error(
    override val sequence: Long,
    val reason: String,
    val recoverable: Boolean,
  ) : T3VoiceApiRealtimeEvent

  data class Ignored(
    override val sequence: Long,
  ) : T3VoiceApiRealtimeEvent
}

internal data class T3VoiceApiRealtimeEvents(
  val state: T3VoiceApiSessionState,
  val events: List<T3VoiceApiRealtimeEvent>,
)

internal enum class T3VoiceMessageTurnState {
  PENDING,
  RUNNING,
  APPROVAL_REQUIRED,
  USER_INPUT_REQUIRED,
  COMPLETED,
  INTERRUPTED,
  FAILED,
  AMBIGUOUS,
}

internal data class T3VoiceAssistantMessage(
  val messageId: String,
  val text: String,
)

internal data class T3VoiceMessageTurn(
  val messageId: String,
  val state: T3VoiceMessageTurnState,
  val turnId: String?,
  val assistantMessage: T3VoiceAssistantMessage?,
)

internal class T3VoiceNativeApiException(
  val code: String,
  val retryable: Boolean,
  val statusCode: Int? = null,
  message: String = "The native voice server request failed.",
) : IllegalStateException(message)

internal class T3VoiceHttpCallRegistry {
  private val lock = Any()
  private val calls = mutableSetOf<T3VoiceHttpCall>()
  private var cancelled = false

  fun execute(call: T3VoiceHttpCall): T3VoiceHttpResult.Success {
    synchronized(lock) {
      if (cancelled) throw T3VoiceNativeApiException("cancelled", retryable = false)
      calls += call
    }
    return try {
      when (val result = call.execute()) {
        is T3VoiceHttpResult.Success -> result
        is T3VoiceHttpResult.Failure -> throw result.toException()
      }
    } finally {
      synchronized(lock) { calls -= call }
    }
  }

  fun cancelAll() {
    val active =
      synchronized(lock) {
        cancelled = true
        calls.toList()
      }
    active.forEach(T3VoiceHttpCall::cancel)
  }

  private fun T3VoiceHttpResult.Failure.toException(): T3VoiceNativeApiException {
    val typed = T3VoiceNativeVoiceApi.decodeError(body, contentType)
    val fallback =
      when (kind) {
        T3VoiceHttpFailureKind.AUTHENTICATION -> "authentication-failed"
        T3VoiceHttpFailureKind.CONFLICT -> "conflict"
        T3VoiceHttpFailureKind.RETRYABLE -> "network-retryable"
        T3VoiceHttpFailureKind.PERMANENT -> "request-rejected"
        T3VoiceHttpFailureKind.BOUNDS_EXCEEDED -> "response-too-large"
        T3VoiceHttpFailureKind.UNEXPECTED_CONTENT_TYPE -> "unexpected-content-type"
        T3VoiceHttpFailureKind.CANCELLED -> "cancelled"
      }
    return T3VoiceNativeApiException(
      code = typed?.reason ?: typed?.code ?: fallback,
      retryable = typed?.retryable ?: (kind == T3VoiceHttpFailureKind.RETRYABLE),
      statusCode = statusCode,
      message = typed?.message ?: "The native voice server request failed.",
    )
  }
}

internal data class T3VoiceTypedServerError(
  val code: String?,
  val reason: String?,
  val retryable: Boolean?,
  val message: String?,
)

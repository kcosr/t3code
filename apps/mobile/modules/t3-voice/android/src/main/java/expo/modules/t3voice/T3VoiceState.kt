package expo.modules.t3voice

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal enum class T3VoiceRuntimePhase {
  INACTIVE,
  IDLE,
  RECORDING,
  PLAYING,
  REALTIME,
}

internal data class T3VoiceRuntimeState(
  val phase: T3VoiceRuntimePhase,
  val isForeground: Boolean,
  val activeRecordingId: String?,
  val activePlaybackId: String?,
  val activeRealtimeSessionId: String?,
  val realtimeConnectionState: String?,
  val realtimeMuted: Boolean,
  val sequence: Long,
) {
  fun toEventBody(): Map<String, Any?> =
    mapOf(
      "phase" to phase.name.lowercase(),
      "isForeground" to isForeground,
      "activeRecordingId" to activeRecordingId,
      "activePlaybackId" to activePlaybackId,
      "activeRealtimeSessionId" to activeRealtimeSessionId,
      "realtimeConnectionState" to realtimeConnectionState,
      "realtimeMuted" to realtimeMuted,
      "sequence" to sequence.toDouble(),
    )
}

internal sealed interface T3VoiceRuntimeEvent {
  fun toEventBody(): Map<String, Any?>

  data class PlaybackChunkConsumed(
    val playbackId: String,
    val chunkIndex: Int,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "playbackId" to playbackId,
        "chunkIndex" to chunkIndex,
      )
  }

  data class RuntimeError(
    val operation: String,
    val code: String,
    val message: String,
    val recoverable: Boolean,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "operation" to operation,
        "code" to code,
        "message" to message,
        "recoverable" to recoverable,
      )
  }

  data class RealtimeTerminated(
    val nativeSessionId: String,
    val outcome: String,
    val code: String,
    val retryable: Boolean,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "nativeSessionId" to nativeSessionId,
        "outcome" to outcome,
        "code" to code,
        "retryable" to retryable,
      )
  }
}

internal object T3VoiceStateStore {
  private val mutableState =
    MutableStateFlow(
      T3VoiceRuntimeState(
        phase = T3VoiceRuntimePhase.INACTIVE,
        isForeground = false,
        activeRecordingId = null,
        activePlaybackId = null,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
        sequence = 0,
      ),
    )
  private val mutableEvents = MutableSharedFlow<T3VoiceRuntimeEvent>(extraBufferCapacity = 64)

  val state: StateFlow<T3VoiceRuntimeState> = mutableState.asStateFlow()
  val events: SharedFlow<T3VoiceRuntimeEvent> = mutableEvents.asSharedFlow()

  fun setServiceReady() {
    update { it.copy(phase = T3VoiceRuntimePhase.IDLE) }
  }

  fun setForeground(isForeground: Boolean) {
    update { it.copy(isForeground = isForeground) }
  }

  fun setRecording(recordingId: String?) {
    update {
      it.copy(
        phase = if (recordingId == null) T3VoiceRuntimePhase.IDLE else T3VoiceRuntimePhase.RECORDING,
        activeRecordingId = recordingId,
        activePlaybackId = null,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
      )
    }
  }

  fun setPlayback(playbackId: String?) {
    update {
      it.copy(
        phase = if (playbackId == null) T3VoiceRuntimePhase.IDLE else T3VoiceRuntimePhase.PLAYING,
        activeRecordingId = null,
        activePlaybackId = playbackId,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
      )
    }
  }

  fun setRealtime(sessionId: String?, connectionState: String?, muted: Boolean) {
    update {
      it.copy(
        phase = if (sessionId == null) T3VoiceRuntimePhase.IDLE else T3VoiceRuntimePhase.REALTIME,
        activeRecordingId = null,
        activePlaybackId = null,
        activeRealtimeSessionId = sessionId,
        realtimeConnectionState = connectionState,
        realtimeMuted = muted,
      )
    }
  }

  fun setInactive() {
    update {
      it.copy(
        phase = T3VoiceRuntimePhase.INACTIVE,
        isForeground = false,
        activeRecordingId = null,
        activePlaybackId = null,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
      )
    }
  }

  fun emit(event: T3VoiceRuntimeEvent) {
    mutableEvents.tryEmit(event)
  }

  private fun update(transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState) {
    mutableState.update { current ->
      val next = transform(current)
      if (next == current) current else next.copy(sequence = current.sequence + 1)
    }
  }
}
